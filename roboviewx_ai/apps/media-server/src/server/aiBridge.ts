import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Server as SocketIOServer } from 'socket.io';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createLogger } from '@repo/logger';

const logger = createLogger('AI-Bridge');

export type DetectionV1 = {
  type: 'detection_v1';
  robotId: string;
  ts_ms: number;
  frame: { w: number; h: number };
  detections: Array<{
    label: string;
    classId: number;
    score: number;
    bbox: { x1: number; y1: number; x2: number; y2: number };
  }>;
};

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isFiniteNumber(x: any): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isDetectionV1(msg: any): msg is DetectionV1 {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type !== 'detection_v1') return false;
  if (typeof msg.robotId !== 'string' || msg.robotId.length === 0) return false;
  if (!isFiniteNumber(msg.ts_ms)) return false;
  if (!msg.frame || !isFiniteNumber(msg.frame.w) || !isFiniteNumber(msg.frame.h)) return false;
  if (!Array.isArray(msg.detections)) return false;
  for (const d of msg.detections) {
    if (!d || typeof d !== 'object') return false;
    if (typeof d.label !== 'string') return false;
    if (!isFiniteNumber(d.classId)) return false;
    if (!isFiniteNumber(d.score)) return false;
    const b = d.bbox;
    if (!b || !isFiniteNumber(b.x1) || !isFiniteNumber(b.y1) || !isFiniteNumber(b.x2) || !isFiniteNumber(b.y2)) return false;
  }
  return true;
}

function getUrl(req: IncomingMessage): URL | null {
  const host = req.headers.host;
  if (!host || !req.url) return null;
  try {
    return new URL(req.url, `http://${host}`);
  } catch {
    return null;
  }
}

function safeSend(ws: WebSocket, data: string) {
  // Backpressure: drop if client is too far behind.
  // 1MB is plenty for small JSON messages; if exceeded, drop newest to avoid latency buildup.
  const MAX_BUFFERED = 1_000_000;
  if (ws.readyState !== WebSocket.OPEN) return;
  // @ts-ignore bufferedAmount exists on ws in Node
  if (typeof (ws as any).bufferedAmount === 'number' && (ws as any).bufferedAmount > MAX_BUFFERED) return;
  ws.send(data);
}

/**
 * AI Bridge:
 * - Accepts AI publishers via raw WS at `/ws/ai?robotId=...&role=publisher`
 * - Broadcasts detections to UI via existing Socket.IO room notifications:
 *     method: 'ai:detection_v1'
 *     params: DetectionV1 message (includes `type`)
 *
 * The UI already joins Socket.IO rooms keyed by `roomId` (robotId), so `io.to(robotId)` targets the right viewers.
 */
export class AiBridge {
  private wss: WebSocketServer;
  private publishers = new Set<WebSocket>();
  private viewersByRobotId = new Map<string, Set<WebSocket>>();
  private lastRxLogMsByRobot = new Map<string, number>();

  constructor(private httpServer: HttpServer, private io: SocketIOServer) {
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (req, socket, head) => {
      const url = getUrl(req);
      if (!url || url.pathname !== '/ws/ai') return;

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    logger.info('AI bridge enabled at WS /ws/ai');
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const url = getUrl(req);
    const robotId = url?.searchParams.get('robotId') || '';
    const role = url?.searchParams.get('role') || 'viewer';

    if (!robotId) {
      ws.close(1008, 'robotId required');
      return;
    }

    if (role === 'publisher') {
      this.publishers.add(ws);
      logger.info(`[AI] publisher connected robotId=${robotId}`);

      ws.on('message', (buf) => {
        const raw: RawData = buf as any;
        const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        const msg = safeJsonParse(str);
        if (!isDetectionV1(msg)) return; // drop silently (robustness)

        // Rate-limited rx logging (at most 1/sec per robot)
        const now = Date.now();
        const last = this.lastRxLogMsByRobot.get(msg.robotId) ?? 0;
        if (now - last > 1000) {
          this.lastRxLogMsByRobot.set(msg.robotId, now);
          logger.info(
            `[AI] rx detection_v1 robotId=${msg.robotId} dets=${msg.detections.length} frame=${msg.frame.w}x${msg.frame.h}`
          );
        }

        // Broadcast to UI via Socket.IO notification channel
        this.io.to(msg.robotId).emit('notification', {
          method: 'ai:detection_v1',
          params: msg,
        });

        // Optional: raw WS viewers
        const viewers = this.viewersByRobotId.get(msg.robotId);
        if (viewers && viewers.size) {
          const payload = JSON.stringify(msg);
          viewers.forEach((v) => safeSend(v, payload));
        }
      });

      ws.on('close', () => {
        this.publishers.delete(ws);
        logger.info(`[AI] publisher disconnected robotId=${robotId}`);
      });

      ws.on('error', () => {
        // Don't crash on socket errors
      });

      return;
    }

    // Viewer role (optional raw WS viewer; UI primarily uses socket.io)
    const set = this.viewersByRobotId.get(robotId) ?? new Set<WebSocket>();
    set.add(ws);
    this.viewersByRobotId.set(robotId, set);

    ws.on('close', () => {
      const s = this.viewersByRobotId.get(robotId);
      if (!s) return;
      s.delete(ws);
      if (s.size === 0) this.viewersByRobotId.delete(robotId);
    });
    ws.on('error', () => {});
  }

  close() {
    try {
      this.wss.close();
    } catch {}
    for (const ws of this.publishers) {
      try {
        ws.close();
      } catch {}
    }
    for (const [, set] of this.viewersByRobotId) {
      for (const ws of set) {
        try {
          ws.close();
        } catch {}
      }
    }
    this.publishers.clear();
    this.viewersByRobotId.clear();
  }
}

