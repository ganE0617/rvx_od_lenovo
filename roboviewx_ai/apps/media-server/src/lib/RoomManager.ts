import { Room } from './Room';
import { WorkerManager } from './WorkerManager';
import { createLogger } from '@repo/logger';

const logger = createLogger('RoomManager');

export class RoomManager {
    private rooms: Map<string, Room> = new Map();
    private workerManager: WorkerManager;

    constructor(workerManager: WorkerManager) {
        this.workerManager = workerManager;
    }

    async getOrCreateRoom(roomId: string): Promise<Room> {
        let room = this.rooms.get(roomId);
        if (!room) {
            logger.info(`Creating room ${roomId}`);
            const worker = this.workerManager.getWorker();
            room = await Room.create(roomId, worker);

            this.rooms.set(roomId, room);

            room.on('close', () => {
                this.rooms.delete(roomId);
            });
        }
        return room;
    }

    getRoom(roomId: string): Room | undefined {
        return this.rooms.get(roomId);
    }
}
