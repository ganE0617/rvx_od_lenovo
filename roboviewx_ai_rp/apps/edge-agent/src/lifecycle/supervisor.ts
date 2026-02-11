import { EventEmitter } from 'events';
import { Logger } from '@repo/logger';
import { RpcClient } from '../signaling/rpcClient';
import { SignalingClient } from '../signaling/messages';
import { MediasoupDevice } from '../rtc/device';
import { SendTransportManager } from '../rtc/sendTransport';
import { ProducerManager } from '../rtc/producer';
import { closeAiortcWorker, getAiortcWorker } from '../rtc/aiortcWorker';
import { Cleanup } from './cleanup';
import { Backoff } from '../utils/backoff';
import { config } from '../config';

/**
 * Supervisor manages the lifecycle of the edge agent
 * Handles connection, reconnection, and cleanup
 */
export class Supervisor extends EventEmitter {
  private logger: Logger;
  private running = false;
  private shouldReconnect = true;
  private aiDataProducer: any | null = null;
  private aiHeartbeatTimer: NodeJS.Timeout | null = null;
  private aiHeartbeatLastOkLogMs = 0;
  private aiHeartbeatLastErrLogMs = 0;
  private aiTransportConnected = false;
  private aiTransportConnectedAtMs = 0;
  private aiNotOpenLastLogMs = 0;
  private aiTestTimer: NodeJS.Timeout | null = null;
  private aiTestSeq = 0;
  private aiTestLastLogMs = 0;
  private aiForceBox = false;
  private aiDetectionHandler: ((json: string) => void) | null = null;
  private aiDetTxTotal = 0;
  private aiDetLastLogMs = 0;

  // Components
  private rpcClient: RpcClient | null = null;
  private signalingClient: SignalingClient | null = null;
  private device: MediasoupDevice | null = null;
  private transportManager: SendTransportManager | null = null;
  private producerManager: ProducerManager | null = null;
  private cleanup: Cleanup;

  // Reconnection
  private backoff: Backoff;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
    this.cleanup = new Cleanup(logger);
    this.backoff = new Backoff(
      config.reconnectBaseDelayMs,
      config.reconnectMaxDelayMs,
      config.reconnectMaxRetries
    );
  }

  public async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Supervisor already running');
      return;
    }

    this.logger.info('Starting supervisor');
    this.running = true;
    this.shouldReconnect = true;

    await this.connect();
  }

  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping supervisor');
    this.running = false;
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.disconnectAndCleanup();
    this.emit('stopped');
  }

  private stopAiHeartbeat(): void {
    if (this.aiHeartbeatTimer) {
      clearInterval(this.aiHeartbeatTimer);
      this.aiHeartbeatTimer = null;
    }
    if (this.aiTestTimer) {
      clearInterval(this.aiTestTimer);
      this.aiTestTimer = null;
    }
    // Remove Python worker detection listener
    if (this.aiDetectionHandler) {
      try {
        getAiortcWorker(this.logger).then((w: any) => {
          w.off('aiDetection', this.aiDetectionHandler);
        }).catch(() => {});
      } catch {
        // ignore
      }
      this.aiDetectionHandler = null;
    }
    this.aiDataProducer = null;
    this.aiHeartbeatLastOkLogMs = 0;
    this.aiHeartbeatLastErrLogMs = 0;
    this.aiTransportConnected = false;
    this.aiTransportConnectedAtMs = 0;
    this.aiNotOpenLastLogMs = 0;
    this.aiTestSeq = 0;
    this.aiTestLastLogMs = 0;
    this.aiDetTxTotal = 0;
    this.aiDetLastLogMs = 0;
  }

  private maybeStartAiTestDetections(): void {
    if (this.aiTestTimer) return;
    if (!this.aiForceBox) {
      this.logger.info('maybeStartAiTestDetections: aiForceBox=false, skipping (YOLO mode)');
      return;
    }
    const producer = this.aiDataProducer;
    if (!producer) {
      this.logger.info('maybeStartAiTestDetections: no aiDataProducer, skipping');
      return;
    }
    if (!this.aiTransportConnected) {
      this.logger.info('maybeStartAiTestDetections: transport not connected, skipping');
      return;
    }

    this.logger.info('maybeStartAiTestDetections: starting moving bbox timer (AI_FORCE_BOX=1)');

    // Fast proof: send a moving bbox every 200ms.
    this.aiTestTimer = setInterval(() => {
      const p = this.aiDataProducer;
      if (!p) return;
      if (p.closed) return;
      if (!this.aiTransportConnected) return;
      if (p.transport && p.transport.closed) return;

      const readyState =
        p?._dataChannel?.readyState ??
        p?._dataChannel?._readyState ??
        p?._channel?.readyState ??
        p?._channel?._readyState;

      if (typeof readyState === 'string' && readyState !== 'open') return;

      // Backpressure: skip sends if buffered too high.
      const bufferedAmount =
        typeof p.bufferedAmount === 'number'
          ? p.bufferedAmount
          : typeof p?._dataChannel?.bufferedAmount === 'number'
            ? p._dataChannel.bufferedAmount
            : 0;
      if (bufferedAmount > 262144) return;

      const now = Date.now();
      const w = 1280;
      const h = 720;
      const x1 = Math.floor(((now / 20) % (w - 200)));
      const y1 = 100;

      const robotId = process.env.EDGE_ROOM_ID || config.roomId || 'robot-001';
      const msg = {
        type: 'detection_v1',
        robotId,
        ts_ms: now,
        frame: { w, h, id: this.aiTestSeq++ },
        detections: [
          {
            label: 'person',
            classId: 0,
            score: 0.99,
            bbox: { x1, y1, x2: x1 + 200, y2: 400 },
          },
        ],
      };

      try {
        p.send(JSON.stringify(msg));
        if (now - this.aiTestLastLogMs >= 1000) {
          this.aiTestLastLogMs = now;
          this.logger.info(
            { dets: 1, conf: process.env.AI_CONF, force: true },
            'TX detection_v1 dets=1'
          );
        }
      } catch (e) {
        // Skip if not open; don't spam.
        const err = e as any;
        if (
          String(err?.name || '').includes('InvalidStateError') ||
          String(err?.message || '').includes('not open')
        ) {
          return;
        }
      }
    }, 200);
  }

  private maybeStartAiHeartbeat(): void {
    if (this.aiHeartbeatTimer) return;
    if (!this.aiDataProducer) {
      this.logger.info('maybeStartAiHeartbeat: no aiDataProducer yet, deferring');
      return;
    }
    if (!this.aiTransportConnected) {
      this.logger.info('maybeStartAiHeartbeat: transport not connected yet, deferring');
      return;
    }

    this.logger.info(
      { aiForceBox: this.aiForceBox },
      'maybeStartAiHeartbeat: starting heartbeat timer'
    );

    const intervalMs = 500;
    this.aiHeartbeatTimer = setInterval(() => {
      const producer = this.aiDataProducer;
      if (!producer) return;
      if (producer.closed) return;
      if (!this.aiTransportConnected) return;
      if (producer.transport && producer.transport.closed) return;

      // Prefer the actual underlying data channel readyState if accessible.
      const readyState =
        producer?._dataChannel?.readyState ??
        producer?._dataChannel?._readyState ??
        producer?._channel?.readyState ??
        producer?._channel?._readyState;

      if (typeof readyState === 'string' && readyState !== 'open') {
        const now = Date.now();
        if (now - this.aiNotOpenLastLogMs >= 2000) {
          this.aiNotOpenLastLogMs = now;
          this.logger.info({ readyState }, 'AI channel not open yet; skipping sends');
        }
        return;
      }

      // Fallback gate: if we can't read readyState, wait a bit after transport is connected.
      if (readyState == null) {
        const now = Date.now();
        if (this.aiTransportConnectedAtMs && (now - this.aiTransportConnectedAtMs) < 1200) {
          if (now - this.aiNotOpenLastLogMs >= 2000) {
            this.aiNotOpenLastLogMs = now;
            this.logger.info('AI channel not open yet (warmup); skipping sends');
          }
          return;
        }
      }

      try {
        producer.send(JSON.stringify({ type: 'ai_heartbeat', ts_ms: Date.now() }));

        const now = Date.now();
        if (now - this.aiHeartbeatLastOkLogMs >= 2000) {
          this.aiHeartbeatLastOkLogMs = now;
          const bufferedAmount =
            typeof producer.bufferedAmount === 'number'
              ? producer.bufferedAmount
              : typeof producer?._dataChannel?.bufferedAmount === 'number'
                ? producer._dataChannel.bufferedAmount
                : undefined;
          this.logger.info({ bufferedAmount }, 'AI heartbeat tx ok');
        }
      } catch (e) {
        const now = Date.now();
        const err = e as any;

        // Common when SCTP/DataChannel isn't open yet (FakeRTCDataChannel).
        // Never throw; just skip quietly with rate-limited log.
        if (String(err?.name || '').includes('InvalidStateError') || String(err?.message || '').includes('not open')) {
          if (now - this.aiNotOpenLastLogMs >= 2000) {
            this.aiNotOpenLastLogMs = now;
            this.logger.info(
              { errorName: err?.name, errorMessage: err?.message, readyState },
              'AI channel not open yet; skipping sends'
            );
          }
          return;
        }

        if (now - this.aiHeartbeatLastErrLogMs >= 2000) {
          this.aiHeartbeatLastErrLogMs = now;
          this.logger.warn(
            { errorName: err?.name, errorMessage: err?.message, errorStack: err?.stack },
            'AI heartbeat send failed'
          );
        }
      }

    }, intervalMs);

    // Start the moving-box test sender only when AI_FORCE_BOX=1.
    this.maybeStartAiTestDetections();
  }

  private startAiHeartbeat(dp: any): void {
    // Preserve transport connection state across stop (stopAiHeartbeat resets it,
    // but the transport IS still connected when called from connect()).
    const wasConnected = this.aiTransportConnected;
    const connectedAtMs = this.aiTransportConnectedAtMs;

    // Ensure we never double-run across reconnects.
    this.stopAiHeartbeat();

    if (!dp) return;
    this.aiDataProducer = dp;

    // Restore transport state — the transport didn't actually disconnect.
    this.aiTransportConnected = wasConnected;
    this.aiTransportConnectedAtMs = connectedAtMs;

    this.logger.info(
      { aiForceBox: this.aiForceBox, aiTransportConnected: this.aiTransportConnected },
      'startAiHeartbeat: restored state, calling maybeStartAiHeartbeat'
    );

    this.maybeStartAiHeartbeat();
  }

  private async connect(): Promise<void> {
    try {
      this.logger.info(
        { roomId: config.roomId, peerId: config.peerId },
        'Connecting to media server'
      );

      // Step 1: Connect to signaling server
      this.rpcClient = new RpcClient({
        url: config.signalingUrl,
        logger: this.logger,
      });

      await this.rpcClient.connect();

      this.signalingClient = new SignalingClient(this.rpcClient);

      // Handle signaling events
      this.signalingClient.onClose(() => {
        this.logger.warn('Signaling connection closed');
        this.handleDisconnect();
      });

      this.signalingClient.onError((error) => {
        this.logger.error({ error }, 'Signaling error');
      });

      this.signalingClient.onNotification((method, params) => {
        this.logger.info({ method, params }, 'Received notification');
      });

      // Step 2: Join room
      const joinResponse = await this.signalingClient.joinRoom(
        config.roomId,
        config.peerId,
        config.role
      );

      this.logger.info({ roomId: config.roomId, joinResponse }, '✓ joinRoom ok');

      // Step 3: Get RTP capabilities (raw response; device.initialize normalizes and logs)
      const capsResp = await this.signalingClient.getRtpCapabilities(config.roomId);

      // Step 4: Initialize device with raw caps response (unwrapping done inside device)
      this.device = new MediasoupDevice(this.logger);
      await this.device.initialize(capsResp);

      if (!this.device.canProduce('video')) {
        throw new Error('Device cannot produce video');
      }

      // Step 5: Create send transport
      this.transportManager = new SendTransportManager(this.logger);
      const transport = await this.transportManager.createTransport(
        this.device.getDevice(),
        this.signalingClient
      );

      // Gate AI sends until transport is connected.
      try {
        transport.on('connectionstatechange', (state: string) => {
          if (state === 'connected') {
            this.aiTransportConnected = true;
            this.aiTransportConnectedAtMs = Date.now();
            this.logger.info('AI: transport connected; AI data channel may open soon');
            this.maybeStartAiHeartbeat();
          }
          if (state === 'failed' || state === 'closed' || state === 'disconnected') {
            this.aiTransportConnected = false;
          }
        });
      } catch {
        // ignore
      }

      // Step 5b: Create AI DataProducer (does NOT affect video pipeline if AI is disabled)
      const aiEnable =
        process.env.AI_ENABLE === '1' ||
        process.env.AI_ENABLE === 'true' ||
        process.env.AI_ENABLE === 'yes';
      if (aiEnable) {
        try {
          this.aiForceBox =
            String(process.env.AI_FORCE_BOX || '').toLowerCase() === '1' ||
            String(process.env.AI_FORCE_BOX || '').toLowerCase() === 'true' ||
            String(process.env.AI_FORCE_BOX || '').toLowerCase() === 'yes' ||
            String(process.env.AI_FORCE_BOX || '').toLowerCase() === 'on';
          if (this.aiForceBox) {
            this.logger.warn('AI_FORCE_BOX=1 enabled: sending moving debug bbox from Node');
          } else {
            this.logger.info('AI_FORCE_BOX not set: YOLO detections will be sent from aiortc worker');
          }
          const hasSctp = !!(transport as any).sctpParameters;
          this.logger.info({ hasSctp }, 'AI: transport SCTP capability');
          this.logger.info(
            {
              AI_ENABLE: process.env.AI_ENABLE,
              AI_FORCE_BOX: process.env.AI_FORCE_BOX,
              AI_MODEL_PATH: process.env.AI_MODEL_PATH,
              AI_FPS: process.env.AI_FPS,
              AI_SEND_HZ: process.env.AI_SEND_HZ,
              AI_CONF: process.env.AI_CONF,
              AI_IOU: process.env.AI_IOU,
              AI_INPUT_W: process.env.AI_INPUT_W,
              AI_INPUT_H: process.env.AI_INPUT_H,
            },
            'AI_ENABLE=1 attempting produceData(label=ai)'
          );
          const dp: any = await (transport as any).produceData({
            ordered: false,
            maxPacketLifeTime: 300,
            label: 'ai',
            protocol: 'json',
            appData: { type: 'detection_v1', robotId: config.roomId },
          });
          this.logger.info(
            { dataProducerId: dp?.id, label: dp?.label, protocol: dp?.protocol },
            '✓ AI DataProducer created (label=ai)'
          );
          // Start heartbeat only when transport is connected + channel is ready.
          this.startAiHeartbeat(dp);

          // Listen for AI detection messages from the Python worker via stderr IPC.
          // The Worker emits 'aiDetection' events with the JSON payload string.
          try {
            const worker = await getAiortcWorker(this.logger);
            this.aiDetectionHandler = (jsonStr: string) => {
              const producer = this.aiDataProducer;
              if (!producer || producer.closed) return;
              if (!this.aiTransportConnected) return;
              try {
                producer.send(jsonStr);
                this.aiDetTxTotal++;
                const now = Date.now();
                if (now - this.aiDetLastLogMs > 1000) {
                  this.aiDetLastLogMs = now;
                  // Parse quickly just for logging
                  try {
                    const parsed = JSON.parse(jsonStr);
                    const detsLen = parsed?.detections?.length ?? 0;
                    this.logger.info(
                      { dets: detsLen, txTotal: this.aiDetTxTotal },
                      'AI: forwarded detection_v1 from Python worker via DataProducer'
                    );
                  } catch {
                    this.logger.info({ txTotal: this.aiDetTxTotal }, 'AI: forwarded detection from worker');
                  }
                }
              } catch (sendErr: any) {
                const now = Date.now();
                if (now - this.aiDetLastLogMs > 2000) {
                  this.aiDetLastLogMs = now;
                  this.logger.warn(
                    { error: sendErr?.message },
                    'AI: failed to forward detection via DataProducer'
                  );
                }
              }
            };
            (worker as any).on('aiDetection', this.aiDetectionHandler);
            this.logger.info('AI: listening for detection_v1 from Python worker (stderr IPC)');
          } catch (workerErr: any) {
            this.logger.warn(
              { error: workerErr?.message },
              'AI: could not attach aiDetection listener to worker'
            );
          }
        } catch (e) {
          // Never block video on AI data path failures
          const err = e as any;
          this.logger.warn(
            { errorName: err?.name, errorMessage: err?.message, errorStack: err?.stack },
            'AI DataProducer creation failed; continuing without AI'
          );
        }
      } else {
        this.logger.info('AI disabled (AI_ENABLE not set); skipping DataProducer');
      }

      // Step 6: Create and start producer
      this.producerManager = new ProducerManager(this.logger);
      const producer = await this.producerManager.produce(transport);

      this.logger.info({ producerId: producer.id }, '✓ produce ok');
      this.logger.info('Edge agent connected and producing video');

      // Reset backoff on successful connection
      this.backoff.reset();
      this.emit('connected');
    } catch (error: any) {
      this.logger.error({
        error: {
          message: error.message,
          stack: error.stack,
          ...(error.cause ? { cause: error.cause } : {}),
          ...(error.code ? { code: error.code } : {}),
        },
      }, 'Connection failed');
      await this.disconnectAndCleanup();

      // Do not retry on Aiortc Worker failure (missing aiortc / Python env)
      const isAiortcWorkerFailure =
        error?.message && String(error.message).includes('Aiortc Worker failed');
      if (isAiortcWorkerFailure) {
        this.shouldReconnect = false;
        this.emit('failed');
        return;
      }

      this.handleDisconnect();
    }
  }

  private async disconnectAndCleanup(): Promise<void> {
    await this.cleanup.cleanupAll(
      this.producerManager,
      this.transportManager,
      this.signalingClient
    );

      // Always stop AI heartbeat loop before killing worker/transport.
      this.stopAiHeartbeat();

    try {
      await closeAiortcWorker(this.logger);
    } catch (error) {
      this.logger.error({ error }, 'Error closing Aiortc Worker');
    }

    this.producerManager = null;
    this.transportManager = null;
    this.signalingClient = null;
    this.rpcClient = null;
    this.device = null;
  }

  private handleDisconnect(): void {
    if (!this.running || !this.shouldReconnect) {
      return;
    }

    if (!config.reconnectEnabled) {
      this.logger.warn('Reconnection disabled');
      this.emit('disconnected');
      return;
    }

    const delay = this.backoff.next();

    if (delay === null) {
      this.logger.error('Max reconnection attempts reached');
      this.emit('failed');
      this.running = false;
      return;
    }

    this.logger.info(
      { delay, attempt: this.backoff.getAttempt() },
      'Scheduling reconnection'
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.logger.info('Attempting reconnection');
      this.connect();
    }, delay);
  }

  public isRunning(): boolean {
    return this.running;
  }

  public isProducing(): boolean {
    const producer = this.producerManager?.getProducer();
    return producer !== null && producer !== undefined && !producer.closed;
  }
}
