import { Device } from 'mediasoup-client';
import { RpcClient } from './rpcClient.js';

export const ViewerStatus = {
    DISCONNECTED: 'DISCONNECTED',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    PLAYING: 'PLAYING',
    ERROR: 'ERROR',
};

/**
 * Mediasoup Viewer orchestration
 */
export class MediasoupViewer {
    constructor(signalingUrl) {
        this.signalingUrl = signalingUrl;
        this.status = ViewerStatus.DISCONNECTED;
        this.error = null;

        // Mediasoup objects
        this.rpcClient = null;
        this.device = null;
        this.recvTransport = null;
        this.consumers = new Map();
        this.dataConsumers = new Map();
        this.mediaStream = null;

        // Callbacks
        this.onStatusChange = null;
        this.onError = null;
        this.onVideoTrack = null;
        this.onAiDetection = null;

        // AI/DataChannel diagnostics (heartbeats + detections)
        this._ai = {
            firstRx: false,
            rxTimes: [],
            lastRxMs: 0,
            lastType: 'none',
            lastLogMs: 0,
        };
    }

    _aiHudEl() {
        return document.getElementById('ai-status');
    }

    _aiSetHud(text) {
        const el = this._aiHudEl();
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('hidden', false);
    }

    _aiUpdateHud() {
        const now = Date.now();
        const ageMs = this._ai.lastRxMs ? (now - this._ai.lastRxMs) : -1;
        const rxFps = this._ai.rxTimes.length;
        this._aiSetHud(`AI: connected age=${ageMs}ms rx=${rxFps}fps last=${this._ai.lastType}`);
    }

    _decodeDataMessage(message) {
        try {
            if (typeof message === 'string') return message;

            // mediasoup-client typically delivers ArrayBuffer for binary messages
            if (message instanceof ArrayBuffer) {
                return new TextDecoder('utf-8').decode(new Uint8Array(message));
            }

            // Some environments deliver Uint8Array / ArrayBufferView
            if (ArrayBuffer.isView(message)) {
                return new TextDecoder('utf-8').decode(message);
            }
        } catch (e) {
            // ignore
        }
        return null;
    }

    async connect(roomId, peerId) {
        try {
            this.setStatus(ViewerStatus.CONNECTING);
            this.error = null;

            // Initialize RPC client
            this.rpcClient = new RpcClient(this.signalingUrl);
            await this.rpcClient.connect();

            // Join room
            const joinResponse = await this.rpcClient.request('joinRoom', {
                roomId,
                peerId,
                role: 'viewer',
            });
            console.log('[Viewer] joinRoom dataProducers:', joinResponse.dataProducers || []);

            // Create mediasoup device
            this.device = new Device();
            await this.device.load({ routerRtpCapabilities: joinResponse.rtpCapabilities });

            // Create recv transport
            const transportParams = await this.rpcClient.request('createWebRtcTransport', {
                producing: false,
                consuming: true,
            });

            this.recvTransport = this.device.createRecvTransport(transportParams);

            this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    await this.rpcClient.request('connectWebRtcTransport', {
                        transportId: this.recvTransport.id,
                        dtlsParameters,
                    });
                    callback();
                } catch (error) {
                    errback(error);
                }
            });

            this.recvTransport.on('connectionstatechange', (state) => {
                console.log('[Viewer] Transport state:', state);
                if (state === 'failed' || state === 'closed') {
                    this.setStatus(ViewerStatus.ERROR);
                    this.setError('Transport connection failed');
                }
            });

            this.setStatus(ViewerStatus.CONNECTED);

            // Consume existing producers
            for (const { producerId } of joinResponse.peers) {
                await this.consumeTrack(producerId);
            }

            // Consume existing data producers (AI detections)
            for (const { dataProducerId, label } of (joinResponse.dataProducers || [])) {
                if (label && label !== 'ai') continue;
                try {
                    await this.consumeData(dataProducerId);
                } catch (e) {
                    console.warn('[Viewer] Failed to consume dataProducer:', dataProducerId, e);
                }
            }

            // Listen for new producers
            this.rpcClient.on('newProducer', async (params) => {
                console.log('[Viewer] New producer:', params.producerId);
                try {
                    await this.consumeTrack(params.producerId);
                } catch (err) {
                    console.error('[Viewer] Failed to consume new producer:', err);
                }
            });

            // Listen for new data producers
            this.rpcClient.on('newDataProducer', async (params) => {
                try {
                    if (params?.label && params.label !== 'ai') return;
                    console.log('[Viewer] New data producer:', params.dataProducerId, params.label);
                    await this.consumeData(params.dataProducerId);
                } catch (err) {
                    console.error('[Viewer] Failed to consume new data producer:', err);
                }
            });

            // Listen for producer close
            this.rpcClient.on('producerClosed', (params) => {
                console.log('[Viewer] Producer closed:', params.producerId);
                const consumer = Array.from(this.consumers.values()).find(
                    (c) => c.producerId === params.producerId
                );
                if (consumer) {
                    consumer.close();
                    this.consumers.delete(consumer.id);
                    this.setStatus(ViewerStatus.CONNECTED);
                }
            });
        } catch (err) {
            console.error('[Viewer] Connection error:', err);
            this.setStatus(ViewerStatus.ERROR);
            this.setError(err.message || 'Connection failed');
            this.cleanup();
        }
    }

    async consumeTrack(producerId) {
        if (!this.recvTransport || !this.device) {
            throw new Error('Transport or device not ready');
        }

        // Request consume from server
        const consumeResponse = await this.rpcClient.request('consume', {
            transportId: this.recvTransport.id,
            producerId,
            rtpCapabilities: this.device.rtpCapabilities,
        });

        // Create consumer
        const consumer = await this.recvTransport.consume({
            id: consumeResponse.id,
            producerId: consumeResponse.producerId,
            kind: consumeResponse.kind,
            rtpParameters: consumeResponse.rtpParameters,
        });

        this.consumers.set(consumer.id, consumer);

        // Resume consumer
        await this.rpcClient.request('resume', { consumerId: consumer.id });

        // Attach track to video
        if (consumer.kind === 'video') {
            console.log('[Viewer] Video track received:', consumer.track.id);
            this.mediaStream = new MediaStream([consumer.track]);

            // Codec check logging
            if (window.MediaSource) {
                console.log('[Viewer] VP8 support:', MediaSource.isTypeSupported('video/webm; codecs="vp8"'));
                console.log('[Viewer] H264 support:', MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01F"'));
            }

            if (this.onVideoTrack) {
                this.onVideoTrack(this.mediaStream);
            }
            this.setStatus(ViewerStatus.PLAYING);

            // Start stats monitoring
            this.startStatsMonitoring();
        }

        console.log('[Viewer] consumeResponse received, consumer created, track attached');
        console.log('[Viewer] Consuming:', consumer.kind, consumer.id);
    }

    async consumeData(dataProducerId) {
        if (!this.recvTransport) throw new Error('Transport not ready');
        if (!this.rpcClient) throw new Error('RPC not ready');

        const resp = await this.rpcClient.request('consumeData', {
            transportId: this.recvTransport.id,
            dataProducerId,
        });

        const dc = await this.recvTransport.consumeData({
            id: resp.id,
            dataProducerId: resp.dataProducerId,
            sctpStreamParameters: resp.sctpStreamParameters,
            label: resp.label,
            protocol: resp.protocol,
            appData: resp.appData,
        });

        // Attach handlers immediately (no late binding).
        // Expose for debugging.
        window.__dataConsumers = window.__dataConsumers || {};
        window.__dataConsumers[dc.label || `dp:${dataProducerId}`] = dc;

        this.dataConsumers.set(dc.id, dc);
        console.log('[Viewer] DataConsumer created label=ai id=', dc.id, 'label=', dc.label);
        this._aiUpdateHud();

        dc.on('message', (message) => {
            try {
                const text = this._decodeDataMessage(message);
                if (!text) return;

                let obj = null;
                try {
                    obj = JSON.parse(text);
                } catch {
                    // Non-JSON message; still treat as activity.
                }

                const type = obj && typeof obj === 'object' ? obj.type : 'non_json';
                const now = Date.now();

                // Debug: expose last AI message for inspection.
                try {
                    window.__lastAI = obj;
                } catch {
                    // ignore
                }

                this._ai.lastRxMs = now;
                this._ai.lastType = String(type || 'unknown');
                this._ai.rxTimes.push(now);
                while (this._ai.rxTimes.length && (now - this._ai.rxTimes[0] > 1000)) this._ai.rxTimes.shift();

                if (!this._ai.firstRx) {
                    this._ai.firstRx = true;
                    console.log('[AI] rx first message');
                }

                // Throttle logs to once per second
                if (now - this._ai.lastLogMs >= 1000) {
                    this._ai.lastLogMs = now;
                    const ageMs = this._ai.lastRxMs ? (Date.now() - this._ai.lastRxMs) : -1;
                    const rxFps = this._ai.rxTimes.length;
                    const detsLen = type === 'detection_v1' && Array.isArray(obj?.detections) ? obj.detections.length : undefined;
                    console.log('[AI] rx', { type, ageMs, rxFps, detsLen });
                    console.log('[AI] type', type);
                }

                // Update HUD for heartbeat-only case too
                this._aiUpdateHud();

                if (type === 'detection_v1') {
                    // Dedicated detection RX log (throttled) for end-to-end proof.
                    if (now - this._ai.lastLogMs >= 1000) {
                        const dets = Array.isArray(obj?.detections) ? obj.detections.length : 0;
                        const ageMs = obj?.ts_ms ? (Date.now() - Number(obj.ts_ms)) : -1;
                        console.log(`[AI] detection_v1 rx dets=${dets} ageMs=${ageMs}`);
                    }
                    if (this.onAiDetection) this.onAiDetection(obj);
                    return;
                }

                if (type === 'ai_heartbeat') {
                    // heartbeat proves DataChannel path even if YOLO is down
                    return;
                }
            } catch (e) {
                // ignore
            }
        });

        dc.on('dataproducerclose', () => {
            console.warn('[Viewer] DataProducer closed for DataConsumer:', dc.id, dc.label);
            try {
                this.dataConsumers.delete(dc.id);
            } catch {
                // ignore
            }
            try {
                if (window.__dataConsumers) delete window.__dataConsumers[dc.label || `dp:${dataProducerId}`];
            } catch {
                // ignore
            }
        });

        dc.on('close', () => {
            console.warn('[Viewer] DataConsumer closed:', dc.id, dc.label);
            try {
                this.dataConsumers.delete(dc.id);
            } catch {
                // ignore
            }
            try {
                if (window.__dataConsumers) delete window.__dataConsumers[dc.label || `dp:${dataProducerId}`];
            } catch {
                // ignore
            }
        });
    }

    startStatsMonitoring() {
        if (this.statsInterval) clearInterval(this.statsInterval);

        this.statsInterval = setInterval(async () => {
            if (!this.recvTransport) return;

            try {
                // Accessing underlying PeerConnection for raw stats
                const pc = this.recvTransport._handler._pc;
                if (!pc) return;

                const stats = await pc.getStats();
                let inboundFound = false;

                stats.forEach(report => {
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        inboundFound = true;
                        console.log('[Stats] inbound-rtp video', {
                            packetsReceived: report.packetsReceived,
                            framesDecoded: report.framesDecoded,
                            bytesReceived: report.bytesReceived,
                            jitter: report.jitter,
                            frameWidth: report.frameWidth,
                            frameHeight: report.frameHeight
                        });
                    }
                });

                if (!inboundFound) {
                    console.warn('[Stats] No inbound-rtp video yet');
                }
            } catch (err) {
                console.error('[Stats] Error getting stats:', err);
            }
        }, 2000);
    }

    disconnect() {
        this.cleanup();
        this.setStatus(ViewerStatus.DISCONNECTED);
        this.error = null;
    }

    cleanup() {
        console.log('[Viewer] Cleanup initiated');

        // Close consumers
        this.consumers.forEach((consumer) => {
            try {
                consumer.close();
            } catch (e) {
                console.warn('[Viewer] Consumer close error:', e);
            }
        });
        this.consumers.clear();

        // Close data consumers
        this.dataConsumers.forEach((dc) => {
            try {
                dc.close();
            } catch (e) {
                // ignore
            }
        });
        this.dataConsumers.clear();

        // Close transport
        if (this.recvTransport) {
            try {
                this.recvTransport.close();
            } catch (e) {
                console.warn('[Viewer] Transport close error:', e);
            }
            this.recvTransport = null;
        }

        // Clear media stream
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop());
            this.mediaStream = null;
        }

        // Clear stats monitoring
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }

        // Disconnect RPC
        if (this.rpcClient) {
            try {
                this.rpcClient.disconnect();
            } catch (e) {
                console.warn('[Viewer] RPC disconnect error:', e);
            }
            this.rpcClient = null;
        }

        this.device = null;
    }

    setStatus(status) {
        this.status = status;
        if (this.onStatusChange) {
            this.onStatusChange(status);
        }
    }

    setError(error) {
        this.error = error;
        if (this.onError) {
            this.onError(error);
        }
    }
}
