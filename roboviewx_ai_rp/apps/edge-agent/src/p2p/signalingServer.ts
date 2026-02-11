import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from '@repo/logger';
import { getP2PEnv } from './env';
import { P2PWorkerProcess, WorkerToNodeMsg } from './workerProcess';

type ClientRole = 'viewer';

type ClientToServerMsg =
  | { type: 'join'; roomId: string; peerId: string; role?: ClientRole }
  | { type: 'offer'; sdp: string; sdpType?: string }
  | { type: 'answer'; sdp: string; sdpType?: string }
  | { type: 'iceCandidate'; candidate: any }
  | { type: 'leave' };

type ServerToClientMsg =
  | { type: 'joined'; roomId: string; peerId: string; iceServers: any }
  | { type: 'answer'; sdp: string; sdpType: string }
  | { type: 'iceCandidate'; candidate: any }
  | { type: 'error'; message: string };

function safeSend(ws: WebSocket, obj: ServerToClientMsg): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    // ignore
  }
}

export class P2PSignalingServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private viewer: WebSocket | null = null;
  private viewerPeerId: string | null = null;

  private worker: P2PWorkerProcess;

  constructor(private logger: Logger) {
    this.worker = new P2PWorkerProcess(logger);
    this.worker.onMessage((m) => this.onWorkerMsg(m));
  }

  async start(): Promise<void> {
    const env = getP2PEnv();

    // Start worker immediately (it owns /dev/video0 and must remain exclusive).
    this.worker.start({
      ICE_SERVERS_JSON: env.iceServersJson,
      EDGE_ROOM_ID: env.roomId,
      EDGE_VIDEO_SOURCE: process.env.EDGE_VIDEO_SOURCE,
      AI_ENABLE: process.env.AI_ENABLE,
      AI_MODEL_PATH: process.env.AI_MODEL_PATH,
      AI_FPS: process.env.AI_FPS,
      AI_SEND_HZ: process.env.AI_SEND_HZ,
      AI_CONF: process.env.AI_CONF,
      AI_IOU: process.env.AI_IOU,
      AI_INPUT_W: process.env.AI_INPUT_W,
      AI_INPUT_H: process.env.AI_INPUT_H,
      AI_CLASSES: process.env.AI_CLASSES,
      P2P_VIDEO_CODEC: process.env.P2P_VIDEO_CODEC,
    });

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    this.server = server;

    const wss = new WebSocketServer({ server, path: '/ws' });
    this.wss = wss;

    wss.on('connection', (ws) => {
      this.logger.info('P2P: viewer websocket connected');

      ws.on('message', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf-8');
        let msg: ClientToServerMsg | null = null;
        try {
          msg = JSON.parse(text);
        } catch {
          safeSend(ws, { type: 'error', message: 'invalid json' });
          return;
        }
        if (!msg) return;
        this.onClientMsg(ws, msg);
      });

      ws.on('close', () => {
        if (this.viewer === ws) {
          this.logger.warn('P2P: viewer disconnected');
          this.viewer = null;
          this.viewerPeerId = null;
          // Ask worker to close current PeerConnection (keeps process alive).
          this.worker.send({ type: 'leave' });
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(env.signalingPort, env.signalingHost, resolve));
    this.logger.info(
      { host: env.signalingHost, port: env.signalingPort },
      'P2P: signaling server listening (ws path=/ws)'
    );
  }

  async stop(): Promise<void> {
    try {
      this.viewer?.close();
    } catch {
      // ignore
    }
    this.viewer = null;
    this.viewerPeerId = null;

    this.worker.stop();

    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;

    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  private onClientMsg(ws: WebSocket, msg: ClientToServerMsg): void {
    const env = getP2PEnv();
    switch (msg.type) {
      case 'join': {
        // Only one viewer supported for now.
        if (this.viewer && this.viewer !== ws) {
          safeSend(ws, { type: 'error', message: 'viewer already connected' });
          return;
        }
        if (msg.roomId !== env.roomId) {
          safeSend(ws, { type: 'error', message: `unknown roomId ${msg.roomId}` });
          return;
        }
        this.viewer = ws;
        this.viewerPeerId = msg.peerId;
        this.logger.info({ roomId: msg.roomId, peerId: msg.peerId }, 'P2P: viewer joined');
        let iceServers: any = [];
        try {
          iceServers = JSON.parse(env.iceServersJson);
        } catch {
          iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
        }
        safeSend(ws, { type: 'joined', roomId: env.roomId, peerId: msg.peerId, iceServers });
        return;
      }
      case 'offer': {
        if (this.viewer !== ws) return;
        this.logger.info('P2P: received offer from viewer -> forwarding to worker');
        this.worker.send({ type: 'offer', sdp: msg.sdp, sdpType: msg.sdpType || 'offer' });
        return;
      }
      case 'iceCandidate': {
        if (this.viewer !== ws) return;
        this.worker.send({ type: 'iceCandidate', candidate: msg.candidate });
        return;
      }
      case 'leave': {
        if (this.viewer !== ws) return;
        this.worker.send({ type: 'leave' });
        return;
      }
      default:
        return;
    }
  }

  private onWorkerMsg(m: WorkerToNodeMsg): void {
    const ws = this.viewer;
    if (!ws) return;
    if (m.type === 'answer') {
      this.logger.info('P2P: received answer from worker -> forwarding to viewer');
      safeSend(ws, { type: 'answer', sdp: (m as any).sdp, sdpType: (m as any).sdpType || 'answer' });
      return;
    }
    if (m.type === 'iceCandidate') {
      safeSend(ws, { type: 'iceCandidate', candidate: (m as any).candidate });
      return;
    }
    if (m.type === 'worker-ready') {
      this.logger.info({ pid: (m as any).pid }, 'P2P: worker ready');
      return;
    }
  }
}

