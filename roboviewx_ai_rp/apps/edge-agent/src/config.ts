import dotenv from 'dotenv';

dotenv.config();

function sanitizeUrl(raw: string | undefined): { raw: string | undefined; sanitized: string | undefined } {
  if (raw == null) return { raw, sanitized: raw };
  const trimmed = raw.trim();

  // Handle accidental Markdown link format: [text](url)
  const md = trimmed.match(/^\s*\[[^\]]+\]\(([^)]+)\)\s*$/);
  const candidate = (md?.[1] ?? trimmed).trim();

  // Also handle accidental bracket-wrapped URL: [http://127.0.0.1:3001]
  const bracket = candidate.match(/^\[([^\]]+)\]$/);
  const out = (bracket?.[1] ?? candidate).trim();
  return { raw, sanitized: out };
}

/** Parsed EDGE_VIDEO_SOURCE for v4l2: device path and optional size/fps/format from query string */
export interface EdgeVideoSourceV4l2 {
  device: string;
  size: string;
  fps: string;
  format?: string;
}

/** Kind of video source derived from EDGE_VIDEO_SOURCE */
export type EdgeVideoSourceKind = 'testsrc' | 'file' | 'v4l2';

/** appData.source value for producer (for logging: test vs file vs camera) */
export type AppDataSource = 'test' | 'file' | 'camera';

function parseEdgeVideoSource(raw: string): {
  kind: EdgeVideoSourceKind;
  v4l2?: EdgeVideoSourceV4l2;
  appDataSource: AppDataSource;
} {
  const trimmed = (raw || 'testsrc').trim() || 'testsrc';
  if (trimmed.startsWith('v4l2:')) {
    const rest = trimmed.slice(5).trim();
    const [pathPart, queryPart] = rest.split('?');
    const device = pathPart?.trim() || '/dev/video0';
    let size = '640x480';
    let fps = '30';
    let format: string | undefined;
    if (queryPart) {
      for (const pair of queryPart.split('&')) {
        const [k, v] = pair.split('=').map((s) => s?.trim());
        if (k === 'size' && v) size = v;
        if (k === 'fps' && v) fps = v;
        if (k === 'format' && v) format = v;
      }
    }
    return {
      kind: 'v4l2',
      v4l2: { device, size, fps, ...(format ? { format } : {}) },
      appDataSource: 'camera',
    };
  }
  if (trimmed === 'file') {
    return { kind: 'file', appDataSource: 'file' };
  }
  return { kind: 'testsrc', appDataSource: 'test' };
}

const edgeVideoSourceRaw = process.env.EDGE_VIDEO_SOURCE ?? 'v4l2:/dev/video0';
const parsedEdgeVideoSource = parseEdgeVideoSource(edgeVideoSourceRaw);
const signalingUrlSan = sanitizeUrl(process.env.SIGNALING_URL);

export interface EdgeAgentConfig {
  // Room & Peer
  roomId: string;
  peerId: string;
  role: 'publisher';

  // Signaling
  signalingUrl: string;
  signalingRpcRequestEvent: string;
  signalingRpcResponseEvent: string;
  signalingRpcEventEvent: string;

  // Video Source (legacy: VIDEO_SOURCE for file vs test)
  videoSource: 'test' | 'file' | 'webcam';
  videoFile?: string;
  videoWidth: number;
  videoHeight: number;
  videoFramerate: number;

  // EDGE_VIDEO_SOURCE: "testsrc" | "v4l2:/dev/video0" | "v4l2:/dev/video2?size=1280x720&fps=30" | "file"
  edgeVideoSource: string;
  edgeVideoSourceKind: EdgeVideoSourceKind;
  edgeVideoSourceV4l2: EdgeVideoSourceV4l2 | undefined;
  appDataSource: AppDataSource;

  // Codec
  codec: 'VP8' | 'H264';

  // TURN/STUN
  turnUrls?: string[];
  turnUsername?: string;
  turnCredential?: string;

  // Reconnect
  reconnectEnabled: boolean;
  reconnectMaxRetries: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;

  // Tilt Service
  tiltPort: number;

  // Logging
  logLevel: string;
}

export const config: EdgeAgentConfig = {
  roomId: process.env.EDGE_ROOM_ID || 'robot-001',
  peerId: process.env.EDGE_PEER_ID || `edge-${Date.now()}`,
  role: 'publisher',

  // Same-host dev: default 127.0.0.1:3001. Remote: set SIGNALING_URL=http://<server-ip>:3001
  signalingUrl: signalingUrlSan.sanitized || 'http://127.0.0.1:3001',
  signalingRpcRequestEvent: process.env.SIGNALING_RPC_REQUEST_EVENT || 'rpc:request',
  signalingRpcResponseEvent: process.env.SIGNALING_RPC_RESPONSE_EVENT || 'rpc:response',
  signalingRpcEventEvent: process.env.SIGNALING_RPC_EVENT_EVENT || 'rpc:event',

  videoSource: (process.env.VIDEO_SOURCE as any) || 'test',
  videoFile: process.env.VIDEO_FILE,
  videoWidth: parseInt(process.env.VIDEO_WIDTH || '640', 10),
  videoHeight: parseInt(process.env.VIDEO_HEIGHT || '480', 10),
  videoFramerate: parseInt(process.env.VIDEO_FRAMERATE || '30', 10),

  edgeVideoSource: edgeVideoSourceRaw,
  edgeVideoSourceKind: parsedEdgeVideoSource.kind,
  edgeVideoSourceV4l2: parsedEdgeVideoSource.v4l2,
  appDataSource: parsedEdgeVideoSource.appDataSource,

  // VP8 only (router is VP8-only; aiortc + mediasoup most stable with VP8)
  codec: 'VP8',

  turnUrls: process.env.TURN_URLS ? process.env.TURN_URLS.split(',') : undefined,
  turnUsername: process.env.TURN_USERNAME,
  turnCredential: process.env.TURN_CREDENTIAL,

  reconnectEnabled: process.env.RECONNECT_ENABLED !== 'false',
  reconnectMaxRetries: parseInt(process.env.RECONNECT_MAX_RETRIES || '10', 10),
  reconnectBaseDelayMs: parseInt(process.env.RECONNECT_BASE_DELAY_MS || '1000', 10),
  reconnectMaxDelayMs: parseInt(process.env.RECONNECT_MAX_DELAY_MS || '30000', 10),

  tiltPort: parseInt(process.env.TILT_PORT || '8080', 10),

  logLevel: process.env.LOG_LEVEL || 'info',
};

// Log once at module load so misformatted env is obvious.
if (signalingUrlSan.raw && signalingUrlSan.raw !== signalingUrlSan.sanitized) {
  // eslint-disable-next-line no-console
  console.warn(`[CONFIG] SIGNALING_URL sanitized: "${signalingUrlSan.raw}" -> "${signalingUrlSan.sanitized}"`);
}
