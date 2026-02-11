import { io, Socket } from 'socket.io-client';
import {
    JsonRpcRequest,
    JsonRpcResponse,
    RequestMethods,
    Notification,
    ServerEvents,
} from '@repo/types';

type EventHandler = (params: any) => void;

export class RpcClient {
    private socket: Socket | null = null;
    private requestId = 0;
    private pendingRequests: Map<
        number,
        {
            resolve: (result: any) => void;
            reject: (error: Error) => void;
            timeout: NodeJS.Timeout;
        }
    > = new Map();
    private eventHandlers: Map<ServerEvents, EventHandler[]> = new Map();
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectTimeout: NodeJS.Timeout | null = null;

    constructor(
        private url: string,
        private requestTimeout = 10000
    ) { }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket = io(this.url, {
                transports: ['websocket'],
                reconnection: false, // Manual reconnection
            });

            this.socket.on('connect', () => {
                console.log('[RpcClient] Connected');
                this.reconnectAttempts = 0;
                resolve();
            });

            this.socket.on('disconnect', (reason) => {
                console.warn('[RpcClient] Disconnected:', reason);
                this.handleDisconnect();
            });

            this.socket.on('connect_error', (error) => {
                console.error('[RpcClient] Connection error:', error);
                reject(error);
            });

            // Server notifications
            this.socket.on('notification', (notification: Notification) => {
                const handlers = this.eventHandlers.get(notification.method);
                if (handlers) {
                    handlers.forEach((handler) => handler(notification.params));
                }
            });
        });
    }

    async request<T = any>(method: RequestMethods, params: any): Promise<T> {
        if (!this.socket || !this.socket.connected) {
            throw new Error('Socket not connected');
        }

        return new Promise<T>((resolve, reject) => {
            const id = ++this.requestId;
            const timeout = setTimeout(() => {
                reject(new Error(`Request timeout: ${method}`));
            }, this.requestTimeout);

            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                method,
                params,
                id,
            };

            console.log(`[RpcClient] Request: ${method}`, request);

            this.socket!.emit('rpc:request', request, (response: JsonRpcResponse) => {
                clearTimeout(timeout);
                console.log(`[RpcClient] Response: ${method}`, response);

                if (response.error) {
                    reject(
                        new Error(`${response.error.message} (code: ${response.error.code})`)
                    );
                } else {
                    resolve(response.result);
                }
            });
        });
    }

    on(event: ServerEvents, handler: EventHandler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event)!.push(handler);
    }

    off(event: ServerEvents, handler: EventHandler) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index !== -1) {
                handlers.splice(index, 1);
            }
        }
    }

    private handleDisconnect() {
        // Clear all pending requests
        this.pendingRequests.forEach(({ reject, timeout }) => {
            clearTimeout(timeout);
            reject(new Error('Socket disconnected'));
        });
        this.pendingRequests.clear();

        // Attempt reconnection with exponential backoff
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            console.log(`[RpcClient] Reconnecting in ${delay}ms...`);

            this.reconnectTimeout = setTimeout(() => {
                this.reconnectAttempts++;
                this.connect().catch((error) => {
                    console.error('[RpcClient] Reconnection failed:', error);
                });
            }, delay);
        }
    }

    disconnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        this.pendingRequests.forEach(({ reject, timeout }) => {
            clearTimeout(timeout);
            reject(new Error('Client disconnected'));
        });
        this.pendingRequests.clear();

        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }
}
