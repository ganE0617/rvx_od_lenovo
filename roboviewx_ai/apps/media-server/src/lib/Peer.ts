import {
    Transport,
    Producer,
    Consumer,
    DataProducer,
    DataConsumer,
    RtpParameters,
    DtlsParameters,
    MediaKind,
    RtpCapabilities,
} from 'mediasoup/node/lib/types';
import { createLogger } from '@repo/logger';

const logger = createLogger('Peer');

export interface PeerOptions {
    id: string;
    role: 'producer' | 'viewer';
}

export class Peer {
    public id: string;
    public role: 'producer' | 'viewer';
    public transports: Map<string, Transport> = new Map();
    public producers: Map<string, Producer> = new Map();
    public consumers: Map<string, Consumer> = new Map();
    public dataProducers: Map<string, DataProducer> = new Map();
    public dataConsumers: Map<string, DataConsumer> = new Map();

    constructor(options: PeerOptions) {
        this.id = options.id;
        this.role = options.role;
    }

    addTransport(transport: Transport) {
        this.transports.set(transport.id, transport);
        (transport as any).on('dtlsstatechange', (dtlsState: string) => {
            if (dtlsState === 'closed') {
                transport.close();
                this.transports.delete(transport.id);
            }
        });
        (transport as any).on('close', () => {
            this.transports.delete(transport.id);
        });
    }

    getTransport(transportId: string) {
        return this.transports.get(transportId);
    }

    addProducer(producer: Producer) {
        this.producers.set(producer.id, producer);
        (producer as any).on('close', () => {
            this.producers.delete(producer.id);
        });
    }

    getProducer(producerId: string) {
        return this.producers.get(producerId);
    }

    addConsumer(consumer: Consumer) {
        this.consumers.set(consumer.id, consumer);
        (consumer as any).on('close', () => {
            this.consumers.delete(consumer.id);
        });
    }

    addDataProducer(dp: DataProducer) {
        this.dataProducers.set(dp.id, dp);
        (dp as any).on('close', () => {
            this.dataProducers.delete(dp.id);
        });
    }

    addDataConsumer(dc: DataConsumer) {
        this.dataConsumers.set(dc.id, dc);
        (dc as any).on('close', () => {
            this.dataConsumers.delete(dc.id);
        });
    }

    close() {
        this.consumers.forEach((c) => c.close());
        this.producers.forEach((p) => p.close());
        this.dataConsumers.forEach((c) => c.close());
        this.dataProducers.forEach((p) => p.close());
        this.transports.forEach((t) => t.close());
        logger.info(`Peer ${this.id} closed`);
    }
}
