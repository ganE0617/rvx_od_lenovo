import { Room } from '../lib/Room';
import { Peer } from '../lib/Peer';
import { EventEmitter } from 'events';

// Mocks
const mockWorker = {
    createRouter: jest.fn().mockResolvedValue({
        id: 'router1',
        close: jest.fn(),
        rtpCapabilities: {},
    })
};

const mockTransport = new EventEmitter();
(mockTransport as any).id = 't1';
(mockTransport as any).close = jest.fn();

const mockProducer = new EventEmitter();
(mockProducer as any).id = 'p1';
(mockProducer as any).close = jest.fn();

describe('Cleanup Logic', () => {
    let room: Room;

    beforeEach(async () => {
        room = await Room.create('room1', mockWorker as any);
    });

    test('Room close cascades to peers and router', () => {
        const peer = new Peer({ id: 'peer1', role: 'viewer' });
        peer.close = jest.fn();
        room.addPeer(peer);

        room.close();

        expect(peer.close).toHaveBeenCalled();
        expect(room.router.close).toHaveBeenCalled();
    });

    test('Peer close cascades to transports/producers', () => {
        const peer = new Peer({ id: 'peer1', role: 'producer' });

        peer.addTransport(mockTransport as any);
        peer.addProducer(mockProducer as any);

        peer.close();

        expect((mockTransport as any).close).toHaveBeenCalled();
        expect((mockProducer as any).close).toHaveBeenCalled();
    });
});
