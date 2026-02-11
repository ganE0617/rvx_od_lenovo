import fetch from 'node-fetch';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { RoomManager } from '../lib/RoomManager';
import { Room } from '../lib/Room';
import { Peer } from '../lib/Peer';
import { createLogger } from '@repo/logger';
import { monitorEventLoopDelay } from 'perf_hooks';
import {
    JsonRpcRequest,
    JsonRpcResponse,
    JoinRoomParams,
    CreateTransportParams,
    ConnectTransportParams,
    ProduceParams,
    ConsumeParams,
    RequestMethods,
} from '@repo/types';
import { AppError, Errors } from '../common/errors';

interface ProduceDataParams {
    transportId: string;
    sctpStreamParameters: any;
    label?: string;
    protocol?: string;
    appData?: any;
}

interface ConsumeDataParams {
    transportId: string;
    dataProducerId: string;
}

// Extend types locally if needed, or assume Any for quick iteration
// TODO: Add these to @repo/types
interface CreatePlainTransportParams {
    rtcpMux?: boolean;
    comedia?: boolean;
}

interface ConnectPlainTransportParams {
    transportId: string;
    ip: string;
    port: number;
    rtcpPort?: number;
}

const logger = createLogger('Signaling');

export class SignalingServer {
    private eventLoopMonitor: any;
    private ptzFailureCount: Map<string, number> = new Map();
    private ptzLastErrorLog: Map<string, number> = new Map();
    private ptzInFlight: Set<string> = new Set();
    
    constructor(
        private io: SocketIOServer,
        private roomManager: RoomManager,
        private piTiltBaseUrl: string = 'http://172.30.1.39:8080'
    ) {
        this.io.on('connection', (socket) => this.handleConnection(socket));
        
        // EVENT LOOP MONITORING
        // resolution: 10ms = check every 10ms for delays
        // If event loop is delayed, samples will be late
        this.eventLoopMonitor = monitorEventLoopDelay({ resolution: 10 });
        this.eventLoopMonitor.enable();
        
        setInterval(() => {
            const mean = this.eventLoopMonitor.mean / 1000000; // ns to ms
            const p99 = this.eventLoopMonitor.percentile(99) / 1000000;
            
            // Only warn if ACTUAL lag detected (not just sampling interval)
            if (mean > 50 || p99 > 100) {
                logger.warn(`[EVENT-LOOP] Real lag: mean=${mean.toFixed(1)}ms, p99=${p99.toFixed(1)}ms`);
                
                // If severe lag, capture memory snapshot
                if (p99 > 200) {
                    const mem = process.memoryUsage();
                    logger.error(`[EVENT-LOOP] SEVERE LAG! Memory: rss=${(mem.rss/1024/1024).toFixed(0)}MB, heap=${(mem.heapUsed/1024/1024).toFixed(0)}/${(mem.heapTotal/1024/1024).toFixed(0)}MB`);
                }
            }
            
            // Reset stats every interval for fresh measurements
            this.eventLoopMonitor.reset();
        }, 10000);
    }

    private handleConnection(socket: Socket) {
        logger.info(`Socket connected: ${socket.id}`);

        // Debug logger - DISABLED for production low-latency mode
        // socket.onAny((event, ...args) => {
        //     const last = args[args.length - 1];
        //     const hasAck = typeof last === 'function';
        //     logger.info(`[SOCKET.IO onAny] ${event} | hasAck: ${hasAck}`, args?.[0]);
        // });

        // Peer Context (attached to socket)
        let currentRoomId: string | null = null;
        let currentPeerId: string | null = null;

        socket.on('message', async (request: JsonRpcRequest) => {
            const response = await this.processRpc(socket, request, { currentRoomId, currentPeerId }, (roomId, peerId) => {
                currentRoomId = roomId;
                currentPeerId = peerId;
            });
            socket.send(response);
        });

        socket.on('rpc:request', async (request: JsonRpcRequest, ack?: (res: JsonRpcResponse) => void) => {
            const response = await this.processRpc(socket, request, { currentRoomId, currentPeerId }, (roomId, peerId) => {
                currentRoomId = roomId;
                currentPeerId = peerId;
            });

            if (typeof ack === 'function') {
                ack(response);
            } else {
                socket.emit('rpc:response', response);
            }
        });

        socket.on('disconnect', () => {
            if (currentRoomId && currentPeerId) {
                const room = this.roomManager.getRoom(currentRoomId);
                const peer = room?.getPeer(currentPeerId);
                
                if (peer) {
                    logger.info(`[CLEANUP] Peer ${currentPeerId} disconnecting: ${peer.consumers.size} consumers, ${peer.producers.size} producers, ${peer.transports.size} transports`);
                }
                
                room?.removePeer(currentPeerId);

                // Notify others
                socket.to(currentRoomId).emit('notification', {
                    method: 'peerLeft',
                    params: { peerId: currentPeerId }
                });
            }
            logger.info(`Socket disconnected: ${socket.id}`);
        });
    }

    /**
     * Broadcasts PTZ state to all peers in a room
     */
    public broadcastPtzState(roomId: string, state: any) {
        // Reduced logging to avoid overhead
        this.io.to(roomId).emit('notification', {
            method: 'ptz:state',
            params: state
        });
    }

    /**
     * Fetches current PTZ state from Pi and broadcasts it
     * CRITICAL: Short timeout (200ms) + exponential backoff on failure
     */
    public async fetchAndBroadcastPtz(roomId: string) {
        if (process.env.DISABLE_PTZ === '1' || process.env.DISABLE_PTZ === 'true') {
            return;
        }
        if (this.ptzInFlight.has(roomId)) {
            return;
        }
        const failCount = this.ptzFailureCount.get(roomId) || 0;
        
        // Exponential backoff: if failed 3+ times, skip for 60s
        if (failCount >= 3) {
            const lastError = this.ptzLastErrorLog.get(roomId) || 0;
            if (Date.now() - lastError < 60000) {
                return; // Skip silently during backoff period
            }
            // Reset after backoff
            this.ptzFailureCount.set(roomId, 0);
        }
        
        this.ptzInFlight.add(roomId);
        try {
            // CRITICAL: 200ms timeout to prevent blocking
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 200);

            const url = `${this.piTiltBaseUrl}/ptz`;
            logger.info(`[PTZ] Fetching ${url}`);

            const response = await fetch(url, {
                signal: controller.signal as any
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Pi returned ${response.status}`);
            }
            const data: any = await response.json();
            const state = data.state || data;

            this.broadcastPtzState(roomId, {
                pan: state.pan ?? 0,
                tilt: state.tilt ?? 0,
                zoom: state.zoom ?? 1.0
            });
            
            // Reset failure count on success
            this.ptzFailureCount.set(roomId, 0);
        } catch (error: any) {
            const failCount = (this.ptzFailureCount.get(roomId) || 0) + 1;
            this.ptzFailureCount.set(roomId, failCount);

            // Log only once per minute to avoid spam
            const lastLog = this.ptzLastErrorLog.get(roomId) || 0;
            if (Date.now() - lastLog > 60000) {
                const msg = error?.name === 'AbortError'
                    ? 'AbortError/timeout'
                    : (error?.message || 'unknown');
                logger.warn(`[PTZ] Fetch failed (attempt ${failCount}): ${msg}. Backing off...`);
                this.ptzLastErrorLog.set(roomId, Date.now());
            }
        } finally {
            this.ptzInFlight.delete(roomId);
        }
    }

    private async processRpc(
        socket: Socket,
        request: JsonRpcRequest,
        ctxVars: { currentRoomId: string | null, currentPeerId: string | null },
        updateCtx: (r: string, p: string) => void
    ): Promise<JsonRpcResponse> {
        try {
            const result = await this.handleRequest(socket, request, {
                getPeer: () => {
                    if (!ctxVars.currentRoomId || !ctxVars.currentPeerId) throw new Error('Not joined');
                    return this.roomManager.getRoom(ctxVars.currentRoomId)?.getPeer(ctxVars.currentPeerId);
                },
                setPeerCtx: (roomId, peerId) => {
                    updateCtx(roomId, peerId);
                }
            });

            return {
                jsonrpc: '2.0',
                id: request.id,
                result,
            } as JsonRpcResponse;

        } catch (error: any) {
            const code = error instanceof AppError ? error.code : 500;
            logger.error(`Error handling request ${request.method}: ${error.message}`);
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code,
                    message: error.message || 'Internal Server Error',
                },
            } as JsonRpcResponse;
        }
    }

    private async handleRequest(
        socket: Socket,
        request: JsonRpcRequest,
        ctx: { getPeer: () => Peer | undefined, setPeerCtx: (r: string, p: string) => void }
    ): Promise<any> {
        const { method, params } = request;

        switch (method) {
            case 'joinRoom': {
                const { roomId, peerId, role } = params as JoinRoomParams;
                const room = await this.roomManager.getOrCreateRoom(roomId);

                if (role === 'producer' && room.hasProducer()) {
                    // MVP restriction: Only 1 producer allowed
                    // But if re-joining same peer, allow it? For simplicity, generic Check.
                    const existing = room.getAllProducers().find(p => p.peerId === peerId); // Allow reconnect
                    if (!existing && room.getAllProducers().length > 0) {
                        throw new AppError(Errors.ROOM_FULL, 'Room already has a publisher');
                    }
                }

                const peer = new Peer({ id: peerId, role });
                room.addPeer(peer);
                ctx.setPeerCtx(roomId, peerId);

                socket.join(roomId);

                // Trigger PTZ Sync
                this.fetchAndBroadcastPtz(roomId);

                // Notify existing peers
                socket.to(roomId).emit('notification', {
                    method: 'peerJoined',
                    params: { peerId, role }
                });

                // Return RtpCapabilities + Existing Producers (for Auto-Consume)
                return {
                    rtpCapabilities: room.getRtpCapabilities(),
                    peers: [...room.getAllProducers()], // List of { producerId, peerId }
                    dataProducers: [...room.getAllDataProducers()], // List of { dataProducerId, peerId, label?, protocol? }
                };
            }

            case 'getRtpCapabilities': {
                const { roomId } = params as any;
                const room = this.roomManager.getRoom(roomId);
                if (!room) throw new AppError(Errors.NOT_FOUND, 'Room not found');
                return room.getRtpCapabilities();
            }

            case 'createWebRtcTransport': {
                const peer = ctx.getPeer();
                if (!peer) throw new Error('Peer not found');

                // Get roomId from closure or socket rooms
                const rName = Array.from(socket.rooms).find(id => id !== socket.id);
                if (!rName) throw new AppError(Errors.NOT_FOUND, 'Room ID not found for socket');

                const r = this.roomManager.getRoom(rName);
                if (!r) throw new AppError(Errors.NOT_FOUND, 'Room not found');

                const producing = (params as any)?.producing ?? (params as any)?.direction === 'send';
                const consuming = (params as any)?.consuming ?? (params as any)?.direction === 'recv';
                const direction = producing ? 'send' : (consuming ? 'recv' : 'unknown');

                // We assume room instance is valid if peer is found
                const data = await r.createWebRtcTransport(peer.id);
                logger.info(`[TRANSPORT] created: peerId=${peer.id}, transportId=${data.id}, direction=${direction}`);

                // Log critical transport parameters for same-host debugging
                const candidatesSample = data.iceCandidates
                    .map((c: any) => `${c.type}:${c.protocol ?? '?'}:${c.ip}:${c.port}${c.tcpType ? `:${c.tcpType}` : ''}`)
                    .slice(0, 3)
                    .join(', ');
                const hasSctp = !!(data as any).sctpParameters;
                logger.info(
                    `[TRANSPORT] Parameters: transportId=${data.id.substring(0,8)}, direction=${direction}, ` +
                    `iceLite=${data.iceParameters.iceLite}, candidatesCount=${data.iceCandidates.length}, ` +
                    `candidatesSample=[${candidatesSample}], dtlsRole=${data.dtlsParameters.role}, sctp=${hasSctp}`
                );

                const transport = peer.getTransport(data.id);
                if (transport) {
                    // Only log state changes, not every event
                    let lastIceState = '';
                    let lastDtlsState = '';
                    const peerIdForLog = peer.id;

                    (transport as any).on('icestatechange', (state: string) => {
                        if (state !== lastIceState && (state === 'connected' || state === 'failed' || state === 'disconnected')) {
                            logger.info(`[TRANSPORT] ICE: ${state} (${data.id}) peerId=${peerIdForLog} direction=${direction}`);
                            lastIceState = state;
                            if (state === 'connected') {
                                // Dump selected tuple to confirm where packets should arrive.
                                (async () => {
                                    try {
                                        const dump = await (transport as any).dump();
                                        const tuple =
                                            (transport as any).iceSelectedTuple ??
                                            dump?.iceSelectedTuple ??
                                            null;
                                        logger.info(
                                            `[TRANSPORT] ICE selectedTuple peerId=${peerIdForLog} direction=${direction} transportId=${data.id.substring(0,8)} ` +
                                            `tuple=${tuple ? JSON.stringify(tuple) : 'null'}`
                                        );
                                    } catch (e: any) {
                                        logger.warn(
                                            `[TRANSPORT] ICE dump failed peerId=${peerIdForLog} direction=${direction} err=${e?.message || String(e)}`
                                        );
                                    }
                                })();
                            }
                        }
                    });
                    (transport as any).on('dtlsstatechange', (state: string) => {
                        if (state !== lastDtlsState) {
                            logger.info(`[TRANSPORT] DTLS: ${state} (${data.id}) peerId=${peerIdForLog} direction=${direction}`);
                            lastDtlsState = state;
                        }
                        if (state === 'failed') {
                            logger.error(`[TRANSPORT] DTLS FAILED - Check firewall/NAT/ICE candidates. peerId=${peerIdForLog} direction=${direction}`);
                        }
                        if (state === 'connected' || state === 'failed') {
                            // Dump details for "DTLS connected but RTP 0" vs "DTLS never connects".
                            (async () => {
                                try {
                                    const dump = await (transport as any).dump();
                                    const tuple =
                                        (transport as any).iceSelectedTuple ??
                                        dump?.iceSelectedTuple ??
                                        null;
                                    const dtls = (transport as any).dtlsState ?? dump?.dtlsState ?? state;
                                    logger.info(
                                        `[TRANSPORT] DTLS dump peerId=${peerIdForLog} direction=${direction} transportId=${data.id.substring(0,8)} ` +
                                        `dtlsState=${dtls || state} tuple=${tuple ? JSON.stringify(tuple) : 'null'}`
                                    );
                                    if (state === 'connected') {
                                        logger.info(
                                            `[TRANSPORT] DTLS connected => SRTP keys established (expect RTP bytesReceived>0 soon) peerId=${peerIdForLog} direction=${direction}`
                                        );
                                    }
                                } catch (e: any) {
                                    logger.warn(
                                        `[TRANSPORT] DTLS dump failed peerId=${peerIdForLog} direction=${direction} err=${e?.message || String(e)}`
                                    );
                                }
                            })();
                        }
                    });
                }

                return {
                    id: data.id,
                    iceParameters: data.iceParameters,
                    iceCandidates: data.iceCandidates,
                    dtlsParameters: data.dtlsParameters,
                    sctpParameters: (data as any).sctpParameters,
                };
            }

            case 'createPlainTransport': {
                const peer = ctx.getPeer();
                if (!peer) throw new Error('Peer not found');

                const rName = Array.from(socket.rooms).find(id => id !== socket.id);
                if (!rName) throw new AppError(Errors.NOT_FOUND, 'Room ID not found');

                const r = this.roomManager.getRoom(rName);
                if (!r) throw new AppError(Errors.NOT_FOUND, 'Room not found');

                const { rtcpMux, comedia } = params as CreatePlainTransportParams;
                const data = await r.createPlainTransport(peer.id, rtcpMux, comedia);

                return data;
            }

            case 'connectPlainTransport': {
                const peer = ctx.getPeer();
                if (!peer) throw new Error('Peer not found');
                const { transportId, ip, port, rtcpPort } = params as ConnectPlainTransportParams;

                const transport = peer.getTransport(transportId);
                if (!transport) throw new Error(`Transport ${transportId} not found`);

                await transport.connect({ ip, port, rtcpPort });
                return {};
            }

            case 'connectWebRtcTransport': {
                const peer = ctx.getPeer();
                if (!peer) throw new Error('Peer not found');
                const { transportId, dtlsParameters } = params as ConnectTransportParams;
                const transport = peer.getTransport(transportId);
                if (!transport) throw new Error(`Transport ${transportId} not found`);

                const fingerprintsLen = dtlsParameters?.fingerprints?.length ?? 0;
                logger.info(`[TRANSPORT] connect: peerId=${peer.id}, transportId=${transportId}, dtlsFingerprintsLen=${fingerprintsLen}`);
                if (fingerprintsLen === 0) {
                    logger.warn(`[TRANSPORT] connect: dtlsParameters.fingerprints missing or empty - DTLS will likely fail`);
                }

                await transport.connect({ dtlsParameters });
                return {};
            }

            case 'produce': {
                const peer = ctx.getPeer();
                if (!peer) throw new Error('Peer not found');
                const { transportId, kind, rtpParameters, appData } = params as ProduceParams;
                const transport = peer.getTransport(transportId);
                if (!transport) throw new Error(`Transport ${transportId} not found`);

                const producer = await transport.produce({ kind, rtpParameters, appData });
                peer.addProducer(producer);

                // CODEC VERIFICATION: Log actual negotiated codec
                const codecInfo = producer.rtpParameters.codecs.map((c: any) => c.mimeType).join(', ');
                logger.info(`[VERIFY] Producer ${producer.id.substring(0,8)} created: codec=${codecInfo}, kind=${kind}`);

                // ONE-SHOT IMMEDIATE DIAGNOSTIC: Check if RTP is actually being sent after 1s
                setTimeout(async () => {
                    if (producer.closed) return;
                    try {
                        const stats = await producer.getStats();
                        const stat = stats?.[0] as any;
                        // Producer stats are "from producer -> SFU", so most meaningful fields are bytes/packets RECEIVED by the SFU.
                        const bytesReceived =
                            stat?.bytesReceived ??
                            stat?.byteCount ??
                            stat?.bytes ??
                            0;
                        const packetsReceived =
                            stat?.packetsReceived ??
                            stat?.packetCount ??
                            stat?.packets ??
                            0;
                        const bytesSent = stat?.bytesSent ?? 0;
                        const packetsSent = stat?.packetsSent ?? 0;
                        const keys = stat ? Object.keys(stat).slice(0, 25).join(',') : '';
                        logger.info(
                            `[STATS] producer (1s) peerId=${peer.id} producerId=${producer.id.substring(0,8)} ` +
                            `bytesReceived=${bytesReceived} packetsReceived=${packetsReceived} bytesSent=${bytesSent} packetsSent=${packetsSent} keys=[${keys}]`
                        );
                    } catch (e) {
                        logger.warn(`[STATS] producer (1s) failed: ${String((e as Error).message)}`);
                    }
                }, 1000);

                // Optional high-frequency stats for diagnosis (enable with STATS_DEBUG=1)
                if (process.env.STATS_DEBUG === '1') {
                    const fastInterval = setInterval(async () => {
                        if (producer.closed) {
                            clearInterval(fastInterval);
                            return;
                        }
                        try {
                            const stats = await producer.getStats();
                            const stat = stats?.[0] as any;
                            const bytesReceived =
                                stat?.bytesReceived ??
                                stat?.byteCount ??
                                stat?.bytes ??
                                0;
                            const packetsReceived =
                                stat?.packetsReceived ??
                                stat?.packetCount ??
                                stat?.packets ??
                                0;
                            logger.info(
                                `[STATS] producer (1s-interval) peerId=${peer.id} producerId=${producer.id.substring(0,8)} bytesReceived=${bytesReceived} packetsReceived=${packetsReceived}`
                            );
                        } catch {
                            // ignore
                        }
                    }, 1000);
                }

                // Stats monitoring for Producer - REDUCED FREQUENCY FOR LOW LATENCY
                // Only collect stats every 30s to avoid event loop blocking
                const statsInterval = setInterval(async () => {
                    if (producer.closed) {
                        clearInterval(statsInterval);
                        return;
                    }
                    try {
                        const stats = await producer.getStats();
                        // Only log critical metrics to reduce overhead
                        const stat = stats?.[0];
                        if (stat && (stat.packetsLost > 0 || stat.fractionLost > 0.05)) {
                            logger.warn(`[STATS] Producer ${producer.id}: packetsLost=${stat.packetsLost}, fractionLost=${stat.fractionLost}`);
                        }
                    } catch (e) {
                        // Silent fail to avoid log spam
                    }
                }, 30000);

                // Notification to others
                socket.to(Array.from(socket.rooms)).emit('notification', {
                    method: 'newProducer',
                    params: {
                        producerId: producer.id,
                        peerId: peer.id,
                        kind: producer.kind
                    }
                });

                return { id: producer.id };
            }

            case 'produceData': {
                const peer = ctx.getPeer();
                if (!peer) throw new Error('Peer not found');
                const { transportId, sctpStreamParameters, label, protocol, appData } = params as unknown as ProduceDataParams;
                const transport = peer.getTransport(transportId);
                if (!transport) throw new Error(`Transport ${transportId} not found`);

                const dataProducer = await (transport as any).produceData({
                    sctpStreamParameters,
                    label: label ?? 'ai',
                    protocol: protocol ?? 'json',
                    appData,
                });
                peer.addDataProducer(dataProducer);
                logger.info(`[DATA] DataProducer created peerId=${peer.id} id=${dataProducer.id} label=${label ?? 'ai'}`);

                // Notify others (viewers) so they can consume
                socket.to(Array.from(socket.rooms)).emit('notification', {
                    method: 'newDataProducer',
                    params: {
                        dataProducerId: dataProducer.id,
                        peerId: peer.id,
                        label: dataProducer.label,
                        protocol: dataProducer.protocol,
                    },
                });

                return { id: dataProducer.id };
            }

            case 'consume': {
                const peer = ctx.getPeer();
                if (!peer) throw new Error('Peer not found');
                const { producerId, rtpCapabilities } = params as ConsumeParams;

                // CRITICAL: Check if peer already consuming this producer
                const existingConsumer = Array.from(peer.consumers.values()).find(
                    c => c.producerId === producerId
                );
                if (existingConsumer) {
                    logger.warn(`[DEDUP] Peer ${peer.id} already consuming producer ${producerId}, returning existing consumer`);
                    return {
                        id: existingConsumer.id,
                        producerId: existingConsumer.producerId,
                        kind: existingConsumer.kind,
                        rtpParameters: existingConsumer.rtpParameters,
                    };
                }

                // Need Room to find producer
                const rName = Array.from(socket.rooms).find(id => id !== socket.id);
                if (!rName) throw new Error('Room ID not found for socket');
                const room = this.roomManager.getRoom(rName);
                if (!room) throw new Error('Room not found');

                if (!room.router.canConsume({ producerId, rtpCapabilities })) {
                    throw new Error('Cannot consume');
                }

                // Create Consumer
                // Find transport to consume on. Usually we create a separate transport for consuming
                // The client should have created a transport for consuming.
                // We just pick the first consuming transport or pass ID in params?
                // Standard Mediasoup: Consumer must be created on a transport.
                // Params should include transportId?
                // Updating `ConsumeParams` locally or assuming logic.
                // Let's assume user sends one transport for consuming.

                // Fix: Client should send transportId.
                // I'll check my defined Types. `Recall: ConsumeParams: { producerId, rtpCapabilities }`
                // I missed `transportId` in `ConsumeParams`. I should update types or just guess.
                // I'll pick the first transport that is NOT used for producing? 
                // Or assume the client sends it? 
                // Let's check typical flow. Client: createRecvTransport -> connect -> consume(transportId).
                // I will add `transportId` to `ConsumeParams` in logic (and update Types file silently or via override).

                // For now, I'll attempt to find a transport or fail.
                let transport = Array.from(peer.transports.values()).find(t => t.appData.consuming); // Need to set appData

                // Actually, let's just create a consume function that accepts transportId if I can update types easily.
                // I'll update the loop to expect transportId in params, cast it.

                const p = params as any;
                if (p.transportId) {
                    transport = peer.getTransport(p.transportId);
                }

                if (!transport) {
                    // Fallback: try to find any
                    transport = Array.from(peer.transports.values())[0];
                }

                if (!transport) throw new Error("No transport found for consumption");

                const consumer = await transport.consume({
                    producerId,
                    rtpCapabilities,
                    paused: false, // Start unpaused for lowest latency
                    // Enable layers for adaptive bitrate (if using simulcast/SVC)
                    // preferredLayers: { spatialLayer: 2, temporalLayer: 2 }
                });

                peer.addConsumer(consumer);

                // Request first keyframe so viewer gets picture immediately (VP8/H264)
                try {
                    await consumer.requestKeyFrame();
                    logger.info(`[KF] requestKeyFrame sent peerId=${peer.id} consumerId=${consumer.id}`);
                } catch (e) {
                    logger.warn(`[KF] requestKeyFrame failed peerId=${peer.id} consumerId=${consumer.id} err=${(e as Error).message}`);
                }

                // CODEC VERIFICATION: Log actual negotiated codec
                const codecInfo = consumer.rtpParameters.codecs.map((c: any) => c.mimeType).join(', ');
                logger.info(`[VERIFY] Consumer ${consumer.id.substring(0, 8)}... created: paused=${consumer.paused} (should be FALSE), codec=${codecInfo}, peer=${peer.id} (total consumers: ${peer.consumers.size})`);

                // One-shot stats 1s after create: bytesReceived > 0 means RTP is flowing
                const peerIdForStats = peer.id;
                setTimeout(async () => {
                    if (consumer.closed) return;
                    try {
                        const stats = await consumer.getStats();
                        const first = stats?.[0] as any;
                        const bytesReceived = first?.bytesReceived ?? 0;
                        const packetsReceived = first?.packetsReceived ?? 0;
                        logger.info(`[STATS] consumer (1s) peerId=${peerIdForStats} consumerId=${consumer.id.substring(0, 8)} bytesReceived=${bytesReceived} packetsReceived=${packetsReceived}`);
                    } catch (e) {
                        logger.warn(`[STATS] consumer getStats failed peerId=${peerIdForStats} consumerId=${consumer.id}`);
                    }
                }, 1000);

                // Optional high-frequency consumer stats for diagnosis (enable with STATS_DEBUG=1)
                if (process.env.STATS_DEBUG === '1') {
                    const fastInterval = setInterval(async () => {
                        if (consumer.closed) {
                            clearInterval(fastInterval);
                            return;
                        }
                        try {
                            const stats = await consumer.getStats();
                            const first = stats?.[0] as any;
                            const bytesReceived = first?.bytesReceived ?? 0;
                            const packetsReceived = first?.packetsReceived ?? 0;
                            logger.info(
                                `[STATS] consumer (1s-interval) peerId=${peerIdForStats} consumerId=${consumer.id.substring(0, 8)} bytesReceived=${bytesReceived} packetsReceived=${packetsReceived}`
                            );
                        } catch {
                            // ignore
                        }
                    }, 1000);
                }

                // Stats monitoring for Consumer - REDUCED FREQUENCY FOR LOW LATENCY
                const statsInterval = setInterval(async () => {
                    if (consumer.closed) {
                        clearInterval(statsInterval);
                        return;
                    }
                    try {
                        const stats = await consumer.getStats();
                        const stat = stats?.[0];
                        // ENHANCED: Log when jitter is high OR on every interval for diagnosis
                        if (stat) {
                            const jitterMs = Math.round(('jitter' in stat ? (stat as any).jitter : 0) || 0);
                            if (jitterMs > 100 || stat.packetsLost > 10) {
                                logger.warn(`[STATS] Consumer ${consumer.id.substring(0,8)}: jitter=${jitterMs}ms, pLost=${stat.packetsLost}, nack=${stat.nackCount || 0}, pli=${stat.pliCount || 0}, rtt=${stat.roundTripTime ? (stat.roundTripTime*1000).toFixed(0)+'ms' : 'N/A'}`);
                            }
                        }
                    } catch (e) {
                        // Silent fail
                    }
                }, 30000);

                // Handle closure
                consumer.on('transportclose', () => {
                    // clean up
                });

                consumer.on('producerclose', () => {
                    peer.consumers.delete(consumer.id);
                    socket.emit('notification', {
                        method: 'producerClosed',
                        params: { producerId }
                    });
                });

                return {
                    id: consumer.id,
                    producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                };
            }

            case 'consumeData': {
                const peer = ctx.getPeer();
                if (!peer) throw new Error('Peer not found');
                const { transportId, dataProducerId } = params as unknown as ConsumeDataParams;

                const rName = Array.from(socket.rooms).find(id => id !== socket.id);
                if (!rName) throw new Error('Room ID not found for socket');
                const room = this.roomManager.getRoom(rName);
                if (!room) throw new Error('Room not found');

                const dataProducer = room.getDataProducer(dataProducerId);
                if (!dataProducer) throw new Error(`DataProducer ${dataProducerId} not found`);

                const transport = peer.getTransport(transportId);
                if (!transport) throw new Error(`Transport ${transportId} not found`);

                const dataConsumer = await (transport as any).consumeData({ dataProducerId });
                peer.addDataConsumer(dataConsumer);
                logger.info(`[DATA] DataConsumer created peerId=${peer.id} id=${dataConsumer.id} dp=${dataProducerId}`);

                return {
                    id: dataConsumer.id,
                    dataProducerId,
                    sctpStreamParameters: dataConsumer.sctpStreamParameters,
                    label: dataConsumer.label,
                    protocol: dataConsumer.protocol,
                    appData: dataConsumer.appData,
                };
            }

            case 'resume': {
                // Note: Resume now optional since consumers start unpaused
                const peer = ctx.getPeer();
                if (!peer) throw new Error('Peer not found');
                const { consumerId } = params as any;
                const consumer = peer.consumers.get(consumerId);
                if (!consumer) throw new Error('Consumer not found');
                if (consumer.paused) {
                    await consumer.resume();
                }
                return {};
            }

            case 'requestKeyFrame': {
                const peer = ctx.getPeer();
                if (!peer) throw new Error('Peer not found');
                const { consumerId } = params as any;
                const consumer = peer.consumers.get(consumerId);
                if (!consumer) throw new Error('Consumer not found');
                await consumer.requestKeyFrame();
                return {};
            }

            case 'heartbeat':
                return { alive: true };

            default:
                throw new Error(`Unknown method ${method}`);
        }
    }
}
