/**
 * Video source via aiortc Worker.getUserMedia.
 * Supports: v4l2 (camera), file (MP4 with loop), testsrc (FIFO lavfi for dev).
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Logger } from '@repo/logger';
import { getAiortcWorker } from '../rtc/aiortcWorker';
import { config } from '../config';

const EDGE_TEST_FIFO_PATH = '/tmp/edge_testsrc_fifo';
let testsrcFfmpegProc: ReturnType<typeof spawn> | null = null;

export interface AiortcVideoResult {
  track: MediaStreamTrack;
  stream: { close(): void };
}

function ensureTestsrcFifo(logger: Logger): void {
  try {
    execSync(`mkfifo ${EDGE_TEST_FIFO_PATH}`, { stdio: 'ignore' });
    logger.debug({ path: EDGE_TEST_FIFO_PATH }, 'Testsrc FIFO created');
  } catch {
    if (existsSync(EDGE_TEST_FIFO_PATH)) {
      logger.debug({ path: EDGE_TEST_FIFO_PATH }, 'Testsrc FIFO already exists');
    } else {
      throw new Error(`Failed to create FIFO ${EDGE_TEST_FIFO_PATH}`);
    }
  }
}

/** Optional testsrc (lavfi FIFO) for development when EDGE_VIDEO_SOURCE=testsrc. */
export async function getAiortcVideoTrack(logger: Logger): Promise<AiortcVideoResult> {
  ensureTestsrcFifo(logger);

  const w = config.videoWidth ?? 640;
  const h = config.videoHeight ?? 480;
  const r = config.videoFramerate ?? 30;

  testsrcFfmpegProc = spawn(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi',
      '-i', `testsrc=size=${w}x${h}:rate=${r}`,
      '-f', 'mpegts',
      EDGE_TEST_FIFO_PATH,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  testsrcFfmpegProc.on('error', (err) => {
    logger.error({ err }, '[testsrc] ffmpeg process error');
  });
  testsrcFfmpegProc.on('exit', (code, signal) => {
    logger.debug({ code, signal }, '[testsrc] ffmpeg process exited');
    testsrcFfmpegProc = null;
  });

  const worker = await getAiortcWorker(logger);
  const stream = await worker.getUserMedia({
    video: {
      source: 'file',
      file: `file://${EDGE_TEST_FIFO_PATH}`,
      loop: false,
    },
  });

  const track = stream.getVideoTracks()[0];
  if (!track) {
    if (testsrcFfmpegProc) {
      testsrcFfmpegProc.kill();
      testsrcFfmpegProc = null;
    }
    stream.close();
    throw new Error('No video track from aiortc getUserMedia');
  }

  const streamWrapper = {
    close() {
      if (testsrcFfmpegProc) {
        try {
          testsrcFfmpegProc.kill();
        } catch (e) {
          logger.warn({ error: e }, '[testsrc] error killing ffmpeg');
        }
        testsrcFfmpegProc = null;
      }
      stream.close();
    },
  };

  logger.info({ trackId: track.id, fifo: EDGE_TEST_FIFO_PATH }, 'Aiortc video track (testsrc)');
  return { track, stream: streamWrapper };
}

/**
 * Get a video track from the Aiortc Worker using a specific file path.
 * Used when VIDEO_SOURCE=file and VIDEO_FILE is set.
 * Returns stream so caller can call stream.close() on cleanup.
 */
export async function getAiortcVideoTrackFromFile(
  logger: Logger,
  filePath: string
): Promise<AiortcVideoResult> {
  const worker = await getAiortcWorker(logger);
  const normalizedPath = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
  const stream = await worker.getUserMedia({
    video: {
      source: 'file',
      file: normalizedPath,
      loop: true,
    },
  });

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.close();
    throw new Error('No video track from aiortc getUserMedia (file)');
  }

  logger.info({ trackId: track.id, file: filePath }, 'Aiortc video track from file obtained');
  return { track, stream };
}

export interface V4l2Options {
  device: string;
  size: string;
  fps: string;
  format?: string;
}

/**
 * Get a video track from the Aiortc Worker using a V4L2 device (/dev/videoX).
 * Worker.getUserMedia is called with source 'file', format 'v4l2', and options
 * so the Python worker creates MediaPlayer(device, format="v4l2", options={...}).
 */
export async function getAiortcVideoTrackFromV4l2(
  logger: Logger,
  options: V4l2Options
): Promise<AiortcVideoResult> {
  const worker = await getAiortcWorker(logger);
  const opts: Record<string, string> = {
    video_size: options.size,
    framerate: options.fps,
  };
  if (options.format) {
    opts.input_format = options.format;
  }
  const stream = await worker.getUserMedia({
    video: {
      source: 'file',
      file: options.device,
      format: 'v4l2',
      options: opts,
    },
  });

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.close();
    throw new Error('No video track from aiortc getUserMedia (v4l2)');
  }

  logger.info(
    { trackId: track.id, device: options.device, size: options.size, fps: options.fps, format: options.format },
    'Aiortc video track from v4l2 obtained'
  );
  return { track, stream };
}
