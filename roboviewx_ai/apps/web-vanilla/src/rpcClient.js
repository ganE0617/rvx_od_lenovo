import { io } from 'socket.io-client';

/**
 * JSON-RPC 2.0 WebSocket client
 */
export class RpcClient {
    constructor(url, requestTimeout = 10000) {
        this.url = url;
        this.requestTimeout = requestTimeout;
        this.socket = null;
        this.requestId = 0;
        this.pendingRequests = new Map();
        this.eventHandlers = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectTimeout = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = io(this.url, {
                transports: ['websocket'],
                reconnection: false,
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
            this.socket.on('notification', (notification) => {
                const handlers = this.eventHandlers.get(notification.method);
                if (handlers) {
                    handlers.forEach((handler) => handler(notification.params));
                }
            });
        });
    }

    request(method, params) {
        if (!this.socket || !this.socket.connected) {
            return Promise.reject(new Error('Socket not connected'));
        }

        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const timeout = setTimeout(() => {
                reject(new Error(`Request timeout: ${method}`));
            }, this.requestTimeout);

            const request = {
                jsonrpc: '2.0',
                method,
                params,
                id,
            };

            console.log(`[RpcClient] Request: ${method}`, request);

            this.socket.emit('rpc:request', request, (response) => {
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

    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event).push(handler);
    }

    off(event, handler) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index !== -1) {
                handlers.splice(index, 1);
            }
        }
    }

    handleDisconnect() {
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
