import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RpcClient } from '../lib/rpcClient';

// Mock socket.io-client
vi.mock('socket.io-client', () => ({
    io: vi.fn(() => ({
        on: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        connected: true,
    })),
}));

describe('RpcClient', () => {
    let client: RpcClient;

    beforeEach(() => {
        client = new RpcClient('ws://localhost:3001');
    });

    it('should create an instance', () => {
        expect(client).toBeDefined();
    });

    it('should handle disconnect gracefully', () => {
        // Basic test for idempotent cleanup
        expect(() => client.disconnect()).not.toThrow();
        expect(() => client.disconnect()).not.toThrow();
    });
});
