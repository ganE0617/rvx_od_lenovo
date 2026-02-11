import { Transport, Producer } from 'mediasoup-client/lib/types';
import { Logger } from '@repo/logger';
import {
  getAiortcVideoTrack,
  getAiortcVideoTrackFromFile,
  getAiortcVideoTrackFromV4l2,
  type AiortcVideoResult,
} from '../media/aiortcVideoSource';
import { config } from '../config';

/**
 * ProducerManager handles video track production using aiortc.
 * Gets a video track from the Aiortc Worker (same as Device) and produces it via mediasoup.
 * On trackended, recreates producer with a new track (same source) and reuses sendTransport.
 */
/** trackended 재시도 backoff: 10초 내 3회 이상 시 1s, 3s, 5s 적용 */
const TRACKENDED_WINDOW_MS = 10000;
const TRACKENDED_BACKOFF_MS = [1000, 3000, 5000];

export class ProducerManager {
  private producer: Producer | null = null;
  private logger: Logger;
  private videoResult: AiortcVideoResult | null = null;
  private currentTransport: Transport | null = null;
  private isClosingProducer = false;
  private isRecreating = false;
  private trackendedRetryTimestamps: number[] = [];

  constructor(logger: Logger) {
    this.logger = logger;
  }

  public async produce(transport: Transport): Promise<Producer> {
    this.currentTransport = transport;
    return this.createProducer(transport);
  }

  private async createProducer(transport: Transport): Promise<Producer> {
    this.logger.info('Creating video producer');

    const { track, stream } = await this.getVideoTrack();
    this.videoResult = { track, stream };

    const producer = await transport.produce({
      track,
      encodings: [
        {
          maxBitrate: 2_000_000, // 2 Mbps (aiortc path requires explicit encodings)
        },
      ],
      codecOptions: {
        videoGoogleStartBitrate: 1000,
      },
      appData: {
        source: config.appDataSource,
      },
    });

    this.producer = producer;

    this.logger.info(
      {
        producerId: this.producer.id,
        kind: this.producer.kind,
        paused: this.producer.paused,
        rtpParameters: this.producer.rtpParameters,
      },
      'Video producer created'
    );

    producer.on('transportclose', () => {
      this.logger.warn('Producer transport closed');
      this.currentTransport = null;
      this.cleanup();
    });

    producer.on('trackended', () => {
      this.logger.warn('Producer track ended');
      this.handleTrackEnded('trackended');
    });

    producer.on('@close', () => {
      if (!this.isClosingProducer) {
        this.logger.debug('Producer closed (event)');
      }
    });

    return producer;
  }

  private handleTrackEnded(reason: string): void {
    if (this.isRecreating) {
      this.logger.debug('Already recreating producer, ignoring trackended');
      return;
    }
    if (!this.currentTransport || this.currentTransport.closed) {
      this.logger.warn('Transport not available for producer recreation');
      return;
    }

    this.isRecreating = true;

    const now = Date.now();
    this.trackendedRetryTimestamps.push(now);
    const windowStart = now - TRACKENDED_WINDOW_MS;
    this.trackendedRetryTimestamps = this.trackendedRetryTimestamps.filter((t) => t >= windowStart);
    const attemptsInWindow = this.trackendedRetryTimestamps.length;

    let delayMs = 0;
    if (attemptsInWindow >= 3) {
      const backoffIndex = Math.min(attemptsInWindow - 3, TRACKENDED_BACKOFF_MS.length - 1);
      delayMs = TRACKENDED_BACKOFF_MS[backoffIndex];
      this.logger.info(
        { attemptsInWindow, delayMs, reason },
        'Trackended backoff: delaying producer recreation'
      );
    }

    const doRecreate = async () => {
      try {
        if (!this.currentTransport || this.currentTransport.closed) {
          this.logger.warn('Transport closed before recreation');
          return;
        }

        this.isClosingProducer = true;
        if (this.producer) {
          try {
            this.producer.close();
          } catch (e) {
            this.logger.warn({ error: e }, 'Error closing producer on trackended');
          }
          this.producer = null;
        }
        this.isClosingProducer = false;

        this.cleanup();

        const newProducer = await this.createProducer(this.currentTransport);
        this.logger.info(
          {
            attempt: attemptsInWindow,
            reason,
            producerId: newProducer.id,
          },
          'Video producer recreated after trackended'
        );
      } catch (err) {
        this.logger.error(
          { error: err, attempt: attemptsInWindow, reason },
          'Failed to recreate producer after trackended'
        );
      } finally {
        this.isRecreating = false;
      }
    };

    if (delayMs > 0) {
      setTimeout(doRecreate, delayMs);
    } else {
      doRecreate();
    }
  }

  public getProducer(): Producer | null {
    return this.producer;
  }

  public async close(): Promise<void> {
    this.logger.info('Closing producer');
    this.currentTransport = null;

    this.isClosingProducer = true;
    if (this.producer) {
      try {
        this.producer.close();
      } finally {
        this.producer = null;
      }
    }
    this.isClosingProducer = false;

    this.cleanup();
  }

  private async getVideoTrack(): Promise<AiortcVideoResult> {
    if (config.edgeVideoSourceKind === 'v4l2' && config.edgeVideoSourceV4l2) {
      return getAiortcVideoTrackFromV4l2(this.logger, config.edgeVideoSourceV4l2);
    }
    if (config.videoSource === 'test' || config.edgeVideoSourceKind === 'testsrc') {
      return getAiortcVideoTrack(this.logger);
    }
    if (config.videoSource === 'file' || config.edgeVideoSourceKind === 'file') {
      if (!config.videoFile) {
        throw new Error('VIDEO_FILE not specified for file source');
      }
      return getAiortcVideoTrackFromFile(this.logger, config.videoFile);
    }

    throw new Error(`Unsupported video source: ${config.edgeVideoSource}`);
  }

  private cleanup(): void {
    if (this.videoResult) {
      try {
        if (typeof this.videoResult.track.stop === 'function') {
          this.videoResult.track.stop();
        }
        this.videoResult.stream.close();
      } catch (e) {
        this.logger.warn({ error: e }, 'Error closing aiortc video stream');
      }
      this.videoResult = null;
    }
  }
}
