import * as mediasoup from 'mediasoup';
import { Worker } from 'mediasoup/node/lib/types';
import { config } from '../config';
import { createLogger } from '@repo/logger';

const logger = createLogger('WorkerManager');

export class WorkerManager {
    private workers: Worker[] = [];
    private nextWorkerIndex = 0;

    async init() {
        logger.info(`Initializing ${config.mediasoup.numWorkers} mediasoup workers...`);

        for (let i = 0; i < config.mediasoup.numWorkers; i++) {
            const worker = await mediasoup.createWorker({
                logLevel: config.mediasoup.workerSettings.logLevel,
                logTags: config.mediasoup.workerSettings.logTags,
                rtcMinPort: config.mediasoup.workerSettings.rtcMinPort,
                rtcMaxPort: config.mediasoup.workerSettings.rtcMaxPort,
            });

            worker.on('died', () => {
                logger.error(`Worker ${worker.pid} died, exiting...`);
                process.exit(1);
            });

            this.workers.push(worker);
        }
    }

    getWorker(): Worker {
        const worker = this.workers[this.nextWorkerIndex];
        this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
        return worker;
    }

    async close() {
        for (const worker of this.workers) {
            worker.close();
        }
    }
}
