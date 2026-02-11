/**
 * JSON-RPC 2.0 Types
 */
export interface JsonRpcRequest<T = any> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: T;
}

export interface JsonRpcResponse<T = any> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

export interface JsonRpcNotification<T = any> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

/**
 * Signaling Protocol Types
 */
export type PeerRole = 'publisher' | 'subscriber';

export interface JoinRoomRequest {
  roomId: string;
  peerId: string;
  role: PeerRole;
}

export interface JoinRoomResponse {
  roomId: string;
  peerId: string;
  peers: Array<{ peerId: string; role: PeerRole }>;
}

export interface GetRtpCapabilitiesRequest {
  roomId: string;
}

export interface GetRtpCapabilitiesResponse {
  rtpCapabilities: any; // mediasoup RtpCapabilities
}

export type TransportDirection = 'send' | 'recv';

export interface CreateWebRtcTransportRequest {
  roomId: string;
  peerId: string;
  direction: TransportDirection;
}

export interface CreateWebRtcTransportResponse {
  transportId: string;
  iceParameters: any;
  iceCandidates: any[];
  dtlsParameters: any;
  sctpParameters?: any;
}

export interface ConnectWebRtcTransportRequest {
  roomId: string;
  peerId: string;
  transportId: string;
  dtlsParameters: any;
}

export interface ConnectWebRtcTransportResponse {
  connected: boolean;
}

export type MediaKind = 'audio' | 'video';

export interface ProduceRequest {
  roomId: string;
  peerId: string;
  transportId: string;
  kind: MediaKind;
  rtpParameters: any;
  appData?: any;
}

export interface ProduceResponse {
  producerId: string;
}

export interface ConsumeRequest {
  roomId: string;
  peerId: string;
  transportId: string;
  producerId: string;
  rtpCapabilities: any;
}

export interface ConsumeResponse {
  consumerId: string;
  producerId: string;
  kind: MediaKind;
  rtpParameters: any;
}

export interface CloseProducerRequest {
  roomId: string;
  peerId: string;
  producerId: string;
}

export interface CloseProducerResponse {
  closed: boolean;
}

/**
 * Notifications
 */
export interface PeerJoinedNotification {
  roomId: string;
  peerId: string;
  role: PeerRole;
}

export interface PeerLeftNotification {
  roomId: string;
  peerId: string;
}

export interface NewProducerNotification {
  roomId: string;
  peerId: string;
  producerId: string;
  kind: MediaKind;
}

export interface ProducerClosedNotification {
  roomId: string;
  peerId: string;
  producerId: string;
}
