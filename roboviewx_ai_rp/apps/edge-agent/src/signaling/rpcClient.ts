import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from '@repo/types';
import { Logger } from '@repo/logger';
import { config } from '../config';

export interface RpcClientOptions {
  url: string;
  logger: Logger;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  method: string;
  startTime: number;
}

export class RpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private requestIdCounter = 0;
  private logger: Logger;
  private url: string;
  private closed = false;

  constructor(options: RpcClientOptions) {
    super();
    this.url = options.url;
    this.logger = options.logger;
  }

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.info(
        { 
          url: this.url,
          requestEvent: config.signalingRpcRequestEvent,
          responseEvent: config.signalingRpcResponseEvent,
          eventEvent: config.signalingRpcEventEvent,
        },
        '→ Connecting to signaling server via Socket.IO'
      );

      // Polling-only: avoids websocket errors when running under pnpm from apps/edge-agent
      this.socket = io(this.url, {
        transports: ['polling'],
        reconnection: false,
        timeout: 8000,
        forceNew: true,
      });

      // Defensive: engine-level errors may surface outside Socket-level handlers.
      try {
        const anySocket = this.socket as any;
        const manager = anySocket?.io;
        const engine = manager?.engine;
        manager?.on?.('error', (err: any) => {
          this.logger.error(
            { error: { message: err?.message, stack: err?.stack, code: err?.code } },
            'Socket.IO manager error'
          );
        });
        engine?.on?.('error', (err: any) => {
          this.logger.error(
            { error: { message: err?.message, stack: err?.stack, code: err?.code } },
            'Engine.IO error'
          );
        });
        engine?.transport?.on?.('error', (err: any) => {
          this.logger.error(
            { error: { message: err?.message, stack: err?.stack, code: err?.code } },
            'Engine.IO transport error'
          );
        });
      } catch {
        // ignore
      }

      // Log ALL incoming Socket.IO events for debugging
      this.socket.onAny((eventName, ...args) => {
        this.logger.debug(
          {
            eventName,
            argsCount: args.length,
            firstArg: args[0] ? JSON.stringify(args[0]).substring(0, 200) : null,
          },
          '← Socket.IO event received'
        );
      });

      this.socket.on('connect', () => {
        const socketId = this.socket?.id;
        this.logger.info({ socketId }, '✓ Socket.IO connected');
        resolve();
      });

      // Listen for RPC responses
      this.socket.on(config.signalingRpcResponseEvent, (message: JsonRpcResponse) => {
        try {
          this.logger.debug(
            { 
              id: message.id, 
              hasError: !!message.error,
              hasResult: !!message.result,
            },
            `← Received ${config.signalingRpcResponseEvent}`
          );
          this.handleMessage(message);
        } catch (error: any) {
          this.logger.error({ 
            error: { message: error.message, stack: error.stack },
          }, 'Failed to handle response');
        }
      });

      // Listen for server push events
      this.socket.on(config.signalingRpcEventEvent, (message: JsonRpcNotification) => {
        try {
          this.logger.info(
            { method: message.method, params: message.params },
            `← Received ${config.signalingRpcEventEvent}`
          );
          this.emit('notification', message.method, message.params);
        } catch (error: any) {
          this.logger.error({ 
            error: { message: error.message, stack: error.stack },
          }, 'Failed to handle notification');
        }
      });

      this.socket.on('connect_error', (error: any) => {
        this.logger.error({ 
          error: { 
            message: error.message, 
            stack: error.stack,
            ...(error.cause ? { cause: error.cause } : {}),
          },
        }, 'Socket.IO connect error');
        this.emit('error', error);
        reject(error);
      });

      this.socket.on('disconnect', (reason) => {
        this.logger.warn({ reason }, 'Socket.IO disconnected');
        this.cleanup();
        if (!this.closed) {
          this.emit('close');
        }
      });

      this.socket.on('error', (error: any) => {
        this.logger.error({ 
          error: { message: error.message, stack: error.stack },
        }, 'Socket.IO error');
        this.emit('error', error);
      });
    });
  }

  public async request<T = any>(method: string, params?: any): Promise<T> {
    if (!this.socket || !this.socket.connected) {
      throw new Error('Socket.IO not connected');
    }

    const id = ++this.requestIdCounter;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const startTime = Date.now();
    this.logger.info(
      { 
        id, 
        method, 
        params,
        eventName: config.signalingRpcRequestEvent,
      }, 
      `→ Sending RPC request`
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const elapsed = Date.now() - startTime;
        this.pendingRequests.delete(String(id));
        
        this.logger.error(
          { 
            id,
            method, 
            elapsed: `${elapsed}ms`,
            eventNames: {
              request: config.signalingRpcRequestEvent,
              response: config.signalingRpcResponseEvent,
              event: config.signalingRpcEventEvent,
            },
            pendingCount: this.pendingRequests.size,
          },
          `✗ RPC request timeout: ${method}`
        );
        
        reject(new Error(`Request timeout: ${method} (${elapsed}ms)`));
      }, 30000);

      // Store with string key for consistent lookup
      const idKey = String(id);
      this.pendingRequests.set(idKey, { 
        resolve, 
        reject, 
        timeout,
        method,
        startTime,
      });

      // Emit with ACK callback support
      this.logger.debug(
        {
          eventName: config.signalingRpcRequestEvent,
          payload: request,
        },
        `→ socket.emit(${config.signalingRpcRequestEvent}) with ACK callback`
      );
      
      this.socket!.emit(config.signalingRpcRequestEvent, request, (ackPayload: any) => {
        // ACK callback received from server
        if (ackPayload !== undefined && ackPayload !== null) {
          this.logger.info(
            {
              id,
              method,
              hasId: 'id' in ackPayload,
              hasResult: 'result' in ackPayload,
              hasError: 'error' in ackPayload,
              ackKeys: Object.keys(ackPayload || {}),
            },
            '← ACK callback received'
          );

          // Check if this looks like a JSON-RPC response
          if (typeof ackPayload === 'object' && ('id' in ackPayload || 'result' in ackPayload || 'error' in ackPayload)) {
            // This is a JSON-RPC response via ACK
            const pending = this.pendingRequests.get(String(ackPayload.id || id));
            if (pending) {
              const elapsed = Date.now() - pending.startTime;
              clearTimeout(pending.timeout);
              this.pendingRequests.delete(String(ackPayload.id || id));

              if (ackPayload.error) {
                this.logger.error(
                  { 
                    id: ackPayload.id || id,
                    method: pending.method,
                    elapsed: `${elapsed}ms`,
                    error: ackPayload.error,
                  },
                  `✗ RPC error response (via ACK)`
                );
                pending.reject(
                  new Error(`RPC Error ${ackPayload.error.code}: ${ackPayload.error.message}`)
                );
              } else {
                this.logger.info(
                  { 
                    id: ackPayload.id || id,
                    method: pending.method,
                    elapsed: `${elapsed}ms`,
                  },
                  `✓ RPC response received (via ACK)`
                );
                pending.resolve(ackPayload.result);
              }
            }
          } else {
            // ACK received but not a JSON-RPC response, might be simple confirmation
            this.logger.debug(
              { id, method, ackPayload },
              'ACK received but not JSON-RPC format, waiting for response event'
            );
          }
        } else {
          // No ACK or undefined ACK, rely on response event listener
          this.logger.debug(
            { id, method },
            'No ACK callback or undefined, relying on response event listener'
          );
        }
      });
    });
  }

  public notify(method: string, params?: any): void {
    if (!this.socket || !this.socket.connected) {
      this.logger.warn({ method }, 'Cannot send notification: not connected');
      return;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.logger.debug(
      { 
        method, 
        params,
        eventName: config.signalingRpcRequestEvent,
      }, 
      `→ Sending notification`
    );
    
    this.socket.emit(config.signalingRpcRequestEvent, notification);
  }

  public close(): void {
    this.closed = true;
    this.logger.info('Closing RPC client');
    this.cleanup();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  public isConnected(): boolean {
    return this.socket !== null && this.socket.connected;
  }

  private handleMessage(message: JsonRpcResponse): void {
    // Normalize ID to string for consistent lookup
    const idKey = String(message.id);
    const pending = this.pendingRequests.get(idKey);

    if (pending) {
      const elapsed = Date.now() - pending.startTime;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(idKey);

      if (message.error) {
        this.logger.error(
          { 
            id: message.id,
            method: pending.method,
            elapsed: `${elapsed}ms`,
            error: message.error,
          },
          `✗ RPC error response (via ${config.signalingRpcResponseEvent} event)`
        );
        pending.reject(
          new Error(`RPC Error ${message.error.code}: ${message.error.message}`)
        );
      } else {
        this.logger.info(
          { 
            id: message.id,
            method: pending.method,
            elapsed: `${elapsed}ms`,
          },
          `✓ RPC response received (via ${config.signalingRpcResponseEvent} event)`
        );
        pending.resolve(message.result);
      }
    } else {
      this.logger.warn(
        { id: message.id },
        `Received ${config.signalingRpcResponseEvent} for unknown request (already resolved via ACK?)`
      );
    }
  }

  private cleanup(): void {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      const elapsed = Date.now() - pending.startTime;
      this.logger.warn(
        { id, method: pending.method, elapsed: `${elapsed}ms` },
        'Rejecting pending request (connection closed)'
      );
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }
}
