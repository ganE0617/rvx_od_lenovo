import { Router, Worker, RtpCapabilities } from 'mediasoup/node/lib/types';
import { Peer } from './Peer';
import { config } from '../config';
import { createLogger } from '@repo/logger';
import { TypedEventEmitter } from '../common/TypedEmitter';

const logger = createLogger('Room');

export class Room extends TypedEventEmitter {
    public id: string;
    public router: Router;
    private peers: Map<string, Peer> = new Map();

    constructor(roomId: string, worker: Worker, router: Router) {
        super();
        this.id = roomId;
        this.router = router;
    }

    static async create(roomId: string, worker: Worker): Promise<Room> {
        const router = await worker.createRouter({ mediaCodecs: config.mediasoup.routerOptions.mediaCodecs });
        return new Room(roomId, worker, router);
    }

    addPeer(peer: Peer) {
        this.peers.set(peer.id, peer);
        logger.info(`Peer ${peer.id} joined room ${this.id}`);
    }

    getPeer(peerId: string) {
        return this.peers.get(peerId);
    }

    removePeer(peerId: string) {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.close();
            this.peers.delete(peerId);
            logger.info(`Peer ${peerId} left room ${this.id}`);
        }

        if (this.peers.size === 0) {
            this.close();
        }
    }

    getRtpCapabilities(): RtpCapabilities {
        return this.router.rtpCapabilities;
    }

    async createWebRtcTransport(peerId: string) {
        const peer = this.peers.get(peerId);
        if (!peer) throw new Error('Peer not found');

        const transport = await this.router.createWebRtcTransport({
            ...config.mediasoup.webRtcTransportOptions,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            enableSctp: true,
            numSctpStreams: { OS: 1024, MIS: 1024 },
            // In Prod, use TURN:
            // iceServers: [ { urls: 'turn:...' } ]
        });

        peer.addTransport(transport);

        return {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            sctpParameters: transport.sctpParameters,
        };
    }

    async createPlainTransport(_peerId: string, _rtcpMux?: boolean, _comedia?: boolean) {
        throw new Error('createPlainTransport not implemented');
    }

    // Check if room has active producer (MVP: 1 publisher limit)
    hasProducer(): boolean {
        for (const peer of this.peers.values()) {
            if (peer.producers.size > 0) return true;
        }
        return false;
    }

    getAllProducers() {
        const producers: { producerId: string, peerId: string }[] = [];
        for (const peer of this.peers.values()) {
            for (const producer of peer.producers.values()) {
                producers.push({ producerId: producer.id, peerId: peer.id });
            }
        }
        return producers;
    }

    getAllDataProducers() {
        const out: { dataProducerId: string, peerId: string, label?: string, protocol?: string }[] = [];
        for (const peer of this.peers.values()) {
            for (const dp of peer.dataProducers.values()) {
                out.push({ dataProducerId: dp.id, peerId: peer.id, label: (dp as any).label, protocol: (dp as any).protocol });
            }
        }
        return out;
    }

    getDataProducer(dataProducerId: string) {
        for (const peer of this.peers.values()) {
            const dp = peer.dataProducers.get(dataProducerId);
            if (dp) return dp;
        }
        return undefined;
    }

    close() {
        this.peers.forEach((peer) => peer.close());
        this.router.close();
        this.emit('close');
        logger.info(`Room ${this.id} closed`);
    }
}
