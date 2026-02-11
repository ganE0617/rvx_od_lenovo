import { useEffect, useRef, useState, useCallback } from 'react';
import { Device } from 'mediasoup-client';
import type { Consumer, DtlsParameters, RtpCapabilities, Transport } from 'mediasoup-client/types';
import { RpcClient } from '../lib/rpcClient';
import {
    JoinRoomParams,
    CreateTransportParams,
    ConnectTransportParams,
    ConsumeParams,
} from '@repo/types';

export enum ViewerStatus {
    DISCONNECTED = 'DISCONNECTED',
    CONNECTING = 'CONNECTING',
    CONNECTED = 'CONNECTED',
    PLAYING = 'PLAYING',
    ERROR = 'ERROR',
}

interface UseMediasoupViewerResult {
    status: ViewerStatus;
    error: string | null;
    videoRef: React.RefObject<HTMLVideoElement>;
    connect: (roomId: string, peerId: string) => Promise<void>;
    disconnect: () => void;
    onNotification: (method: string, handler: (params: any) => void) => void;
    offNotification: (method: string, handler: (params: any) => void) => void;
}

export function useMediasoupViewer(signalingUrl: string): UseMediasoupViewerResult {
    const [status, setStatus] = useState<ViewerStatus>(ViewerStatus.DISCONNECTED);
    const [error, setError] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);

    // Refs for cleanup
    const rpcClientRef = useRef<RpcClient | null>(null);
    const deviceRef = useRef<Device | null>(null);
    const recvTransportRef = useRef<Transport | null>(null);
    const consumersRef = useRef<Map<string, Consumer>>(new Map());
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const notificationHandlersRef = useRef<Array<{ method: string; handler: (params: any) => void }>>([]);

    const cleanup = useCallback(() => {
        console.log('[Viewer] Cleanup initiated');

        // Close consumers
        consumersRef.current.forEach((consumer) => {
            try {
                consumer.close();
            } catch (e) {
                console.warn('[Viewer] Consumer close error:', e);
            }
        });
        consumersRef.current.clear();

        // Close transport
        if (recvTransportRef.current) {
            try {
                recvTransportRef.current.close();
            } catch (e) {
                console.warn('[Viewer] Transport close error:', e);
            }
            recvTransportRef.current = null;
        }

        // Clear video
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((track) => track.stop());
            mediaStreamRef.current = null;
        }

        // Disconnect RPC
        if (rpcClientRef.current) {
            try {
                rpcClientRef.current.disconnect();
            } catch (e) {
                console.warn('[Viewer] RPC disconnect error:', e);
            }
            rpcClientRef.current = null;
        }

        deviceRef.current = null;
    }, []);

    const consumeTrack = useCallback(
        async (producerId: string, rtpCapabilities: RtpCapabilities) => {
            if (!recvTransportRef.current || !deviceRef.current) {
                throw new Error('Transport or device not ready');
            }

            const transport = recvTransportRef.current;
            const device = deviceRef.current;

            // Request consume from server
            const consumeResponse = await rpcClientRef.current!.request<{
                id: string;
                producerId: string;
                kind: 'audio' | 'video';
                rtpParameters: any;
            }>('consume', {
                transportId: transport.id,
                producerId,
                rtpCapabilities,
            } as ConsumeParams);

            // Create consumer
            const consumer = await transport.consume({
                id: consumeResponse.id,
                producerId: consumeResponse.producerId,
                kind: consumeResponse.kind,
                rtpParameters: consumeResponse.rtpParameters,
            });

            consumersRef.current.set(consumer.id, consumer);

            // Resume consumer
            await rpcClientRef.current!.request('resume', { consumerId: consumer.id });

            // Attach track to video
            if (consumer.kind === 'video') {
                console.log('[Viewer] Video track received:', consumer.track.id);
                const stream = new MediaStream([consumer.track]);
                mediaStreamRef.current = stream;

                // Codec check logging
                if (window.MediaSource) {
                    console.log('[Viewer] VP8 support:', MediaSource.isTypeSupported('video/webm; codecs="vp8"'));
                    console.log('[Viewer] H264 support:', MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01F"'));
                }

                if (videoRef.current) {
                    const video = videoRef.current;
                    video.srcObject = stream;
                    video.muted = true;
                    video.playsInline = true;
                    video.autoplay = true;

                    video.onloadedmetadata = () => console.log('[Viewer] loadedmetadata', video.videoWidth, video.videoHeight);
                    video.onplaying = () => console.log('[Viewer] playing');
                    video.onpause = () => console.log('[Viewer] paused');
                    video.onerror = (e) => console.error('[Viewer] video error', e);

                    try {
                        await video.play();
                        console.log('[Viewer] video.play() OK');
                    } catch (e) {
                        console.error('[Viewer] video.play() FAILED', e);
                    }
                }
                setStatus(ViewerStatus.PLAYING);

                // Stats monitoring
                const intervalId = setInterval(async () => {
                    if (!recvTransportRef.current) return;
                    try {
                        // @ts-ignore - access internal pc for debugging
                        const pc = recvTransportRef.current._handler._pc;
                        if (!pc) return;
                        const stats = await pc.getStats();
                        let inboundFound = false;
                        stats.forEach((report: any) => {
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
                        if (!inboundFound) console.warn('[Stats] No inbound-rtp video yet');
                    } catch (err) {
                        console.error('[Stats] Error getting stats:', err);
                    }
                }, 2000);

                // Add to a ref or state for cleanup if needed, but here it's simple enough
                // In a production app you'd clear this interval.
            }

            console.log('[Viewer] consumeResponse received, consumer created, track attached');
            console.log('[Viewer] Consuming:', consumer.kind, consumer.id);
        },
        []
    );

    const connect = useCallback(
        async (roomId: string, peerId: string) => {
            try {
                setStatus(ViewerStatus.CONNECTING);
                setError(null);

                // Initialize RPC client
                const rpcClient = new RpcClient(signalingUrl);
                rpcClientRef.current = rpcClient;

                await rpcClient.connect();

                // Join room
                const joinResponse = await rpcClient.request<{
                    rtpCapabilities: RtpCapabilities;
                    peers: Array<{ producerId: string; peerId: string }>;
                }>('joinRoom', {
                    roomId,
                    peerId,
                    role: 'viewer',
                } as JoinRoomParams);

                // Create mediasoup device
                const device = new Device();
                deviceRef.current = device;

                await device.load({ routerRtpCapabilities: joinResponse.rtpCapabilities });

                // Create recv transport
                const transportParams = await rpcClient.request<{
                    id: string;
                    iceParameters: any;
                    iceCandidates: any;
                    dtlsParameters: any;
                }>('createWebRtcTransport', {
                    producing: false,
                    consuming: true,
                } as CreateTransportParams);

                const recvTransport = device.createRecvTransport(transportParams);
                recvTransportRef.current = recvTransport;

                recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                    try {
                        await rpcClient.request('connectWebRtcTransport', {
                            transportId: recvTransport.id,
                            dtlsParameters,
                        } as ConnectTransportParams);
                        callback();
                    } catch (error: any) {
                        errback(error);
                    }
                });

                recvTransport.on('connectionstatechange', (state) => {
                    console.log('[Viewer] Transport state:', state);
                    if (state === 'failed' || state === 'closed') {
                        setStatus(ViewerStatus.ERROR);
                        setError('Transport connection failed');
                    }
                });

                setStatus(ViewerStatus.CONNECTED);

                // Consume existing producers
                for (const { producerId } of joinResponse.peers) {
                    await consumeTrack(producerId, device.rtpCapabilities);
                }

                // Register buffered notification handlers
                notificationHandlersRef.current.forEach(({ method, handler }) => {
                    rpcClient.on(method as any, handler);
                });

                // Listen for new producers
                rpcClient.on('newProducer', async (params: { producerId: string }) => {
                    console.log('[Viewer] New producer:', params.producerId);
                    try {
                        if (device.rtpCapabilities) {
                            await consumeTrack(params.producerId, device.rtpCapabilities);
                        }
                    } catch (err: any) {
                        console.error('[Viewer] Failed to consume new producer:', err);
                    }
                });

                // Listen for producer close
                rpcClient.on('producerClosed', (params: { producerId: string }) => {
                    console.log('[Viewer] Producer closed:', params.producerId);
                    const consumer = Array.from(consumersRef.current.values()).find(
                        (c) => c.producerId === params.producerId
                    );
                    if (consumer) {
                        consumer.close();
                        consumersRef.current.delete(consumer.id);
                        setStatus(ViewerStatus.CONNECTED);
                    }
                });
            } catch (err: any) {
                console.error('[Viewer] Connection error:', err);
                setStatus(ViewerStatus.ERROR);
                setError(err.message || 'Connection failed');
                cleanup();
            }
        },
        [signalingUrl, cleanup, consumeTrack]
    );

    const offNotification = useCallback((method: string, handler: (params: any) => void) => {
        notificationHandlersRef.current = notificationHandlersRef.current.filter(
            (h) => h.method !== method || h.handler !== handler
        );
        if (rpcClientRef.current) {
            rpcClientRef.current.off(method as any, handler);
        }
    }, []);

    const onNotification = useCallback((method: string, handler: (params: any) => void) => {
        // Only add if not already present
        if (!notificationHandlersRef.current.some((h) => h.method === method && h.handler === handler)) {
            notificationHandlersRef.current.push({ method, handler });
        }
        if (rpcClientRef.current) {
            rpcClientRef.current.on(method as any, handler);
        }
    }, []);

    const disconnect = useCallback(() => {
        cleanup();
        setStatus(ViewerStatus.DISCONNECTED);
        setError(null);
    }, [cleanup]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cleanup();
        };
    }, [cleanup]);

    return {
        status,
        error,
        videoRef: videoRef as React.RefObject<HTMLVideoElement>,
        connect,
        disconnect,
        onNotification,
        offNotification,
    };
}
