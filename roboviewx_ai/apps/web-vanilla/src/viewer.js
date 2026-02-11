export const ViewerStatus = {
    DISCONNECTED: 'DISCONNECTED',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    PLAYING: 'PLAYING',
    ERROR: 'ERROR',
};

/**
 * P2P Viewer orchestration (native WebRTC, no mediasoup)
 */
export class P2PViewer {
    constructor(signalingUrl) {
        this.signalingUrl = signalingUrl;
        this.status = ViewerStatus.DISCONNECTED;
        this.error = null;

        // P2P objects
        this.ws = null;
        this.pc = null;
        this.mediaStream = null;
        this.aiDataChannel = null;

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

    _aiUpdateHud() {
        // HUD removed from UI; keep internal stats only.
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

            // Signaling over WebSocket to edge-agent
            const wsUrl = this.signalingUrl;
            const ws = new WebSocket(wsUrl);
            this.ws = ws;

            const joined = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('signaling timeout')), 10000);
                ws.onopen = () => {
                    ws.send(JSON.stringify({ type: 'join', roomId, peerId, role: 'viewer' }));
                };
                ws.onerror = (e) => {
                    clearTimeout(t);
                    reject(new Error('signaling websocket error'));
                };
                ws.onmessage = (ev) => {
                    try {
                        const msg = JSON.parse(String(ev.data || ''));
                        if (msg.type === 'joined') {
                            clearTimeout(t);
                            resolve(msg);
                        }
                        if (msg.type === 'error') {
                            clearTimeout(t);
                            reject(new Error(msg.message || 'signaling error'));
                        }
                    } catch {
                        // ignore
                    }
                };
            });

            const iceServers = joined.iceServers || [{ urls: ['stun:stun.l.google.com:19302'] }];
            console.log('[P2P] joined, iceServers=', iceServers);

            const pc = new RTCPeerConnection({ iceServers });
            this.pc = pc;

            pc.oniceconnectionstatechange = () => {
                console.log('[P2P] iceConnectionState=', pc.iceConnectionState);
            };
            pc.onconnectionstatechange = () => {
                console.log('[P2P] connectionState=', pc.connectionState);
                if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                    this.setStatus(ViewerStatus.ERROR);
                    this.setError('PeerConnection failed/closed');
                }
            };

            pc.onicecandidate = (ev) => {
                if (!ev.candidate) return;
                try {
                    ws.send(JSON.stringify({ type: 'iceCandidate', candidate: ev.candidate }));
                } catch {
                    // ignore
                }
            };

            pc.ontrack = (ev) => {
                const track = ev.track;
                console.log('[P2P] ontrack kind=', track.kind, 'id=', track.id);
                if (track.kind !== 'video') return;
                this.mediaStream = new MediaStream([track]);
                if (this.onVideoTrack) this.onVideoTrack(this.mediaStream);
                this.setStatus(ViewerStatus.PLAYING);
            };

            pc.ondatachannel = (ev) => {
                const dc = ev.channel;
                console.log('[P2P] ondatachannel label=', dc.label);
                if (dc.label === 'ai') {
                    this.aiDataChannel = dc;
                    this._wireAiChannel(dc);
                }
            };

            // Handle signaling messages (answer/candidates)
            ws.onmessage = async (ev) => {
                let msg = null;
                try {
                    msg = JSON.parse(String(ev.data || ''));
                } catch {
                    return;
                }
                if (msg.type === 'answer') {
                    await pc.setRemoteDescription({ type: msg.sdpType || 'answer', sdp: msg.sdp });
                    return;
                }
                if (msg.type === 'iceCandidate') {
                    try {
                        await pc.addIceCandidate(msg.candidate);
                    } catch {
                        // ignore
                    }
                    return;
                }
            };

            ws.onclose = () => {
                console.warn('[P2P] signaling websocket closed');
            };

            // Create offer
            const offer = await pc.createOffer({ offerToReceiveVideo: true });
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp, sdpType: pc.localDescription.type }));

            this.setStatus(ViewerStatus.CONNECTED);
        } catch (err) {
            console.error('[Viewer] Connection error:', err);
            this.setStatus(ViewerStatus.ERROR);
            this.setError(err.message || 'Connection failed');
            this.cleanup();
        }
    }

    _wireAiChannel(dc) {
        // Expose for debugging
        window.__dataConsumers = window.__dataConsumers || {};
        window.__dataConsumers[dc.label || 'ai'] = dc;

        dc.onmessage = (ev) => {
            try {
                const text = this._decodeDataMessage(ev.data);
                if (!text) return;
                let obj = null;
                try {
                    obj = JSON.parse(text);
                } catch {
                    obj = null;
                }
                const type = obj && typeof obj === 'object' ? obj.type : 'non_json';
                const now = Date.now();

                try { window.__lastAI = obj; } catch {}

                this._ai.lastRxMs = now;
                this._ai.lastType = String(type || 'unknown');
                this._ai.rxTimes.push(now);
                while (this._ai.rxTimes.length && (now - this._ai.rxTimes[0] > 1000)) this._ai.rxTimes.shift();

                if (!this._ai.firstRx) {
                    this._ai.firstRx = true;
                    console.log('[AI] rx first message (P2P)');
                }
                if (now - this._ai.lastLogMs >= 1000) {
                    this._ai.lastLogMs = now;
                    const rxFps = this._ai.rxTimes.length;
                    const detsLen = type === 'detection_v1' && Array.isArray(obj?.detections) ? obj.detections.length : undefined;
                    console.log('[AI] rx', { type, rxFps, detsLen });
                }

                if (type === 'detection_v1') {
                    if (this.onAiDetection) this.onAiDetection(obj);
                }
            } catch {
                // ignore
            }
        };
    }

    startStatsMonitoring() {
        // optional: can be re-added using pc.getStats() if needed
    }

    disconnect() {
        this.cleanup();
        this.setStatus(ViewerStatus.DISCONNECTED);
        this.error = null;
    }

    cleanup() {
        console.log('[Viewer] Cleanup initiated');

        try { this.aiDataChannel?.close(); } catch {}
        this.aiDataChannel = null;

        try { this.pc?.close(); } catch {}
        this.pc = null;

        try { this.ws?.close(); } catch {}
        this.ws = null;

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

        // remove debug refs
        try { if (window.__dataConsumers) delete window.__dataConsumers.ai; } catch {}
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
