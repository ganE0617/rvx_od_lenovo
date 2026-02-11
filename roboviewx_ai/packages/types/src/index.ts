export interface DetectionEvent {
    eventId: string;
    type: string;
    timestamp: string; // ISO
    cameraId: string;
    confidence: number;
    bbox: [number, number, number, number];
    snapshotUrl?: string;
    clipRef?: string;
}

export interface ControlCommand {
    targetDevice: string;
    action: 'pan_tilt' | 'restart';
    parameters: Record<string, any>;
}

// --- Signaling JSON-RPC Types ---

export type RequestMethods =
    | 'joinRoom'
    | 'leaveRoom'
    | 'getRouterRtpCapabilities'
    | 'getRtpCapabilities'
    | 'createWebRtcTransport'
    | 'connectWebRtcTransport'
    | 'createPlainTransport'
    | 'connectPlainTransport'
    | 'produce'
    | 'produceData'
    | 'consume'
    | 'consumeData'
    | 'resume'
    | 'requestKeyFrame'
    | 'heartbeat';

export interface JsonRpcRequest<T = any> {
    jsonrpc: '2.0';
    method: RequestMethods;
    params: T;
    id: number;
}

export interface JsonRpcResponse<T = any> {
    jsonrpc: '2.0';
    result?: T;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
    id: number;
}

export interface JoinRoomParams {
    roomId: string;
    peerId: string;
    role: 'producer' | 'viewer';
}

export interface CreateTransportParams {
    forceTcp?: boolean;
    producing: boolean;
    consuming: boolean;
}

export interface ConnectTransportParams {
    transportId: string;
    dtlsParameters: any; // Mediasoup DtlsParameters
}

export interface ProduceParams {
    transportId: string;
    kind: 'audio' | 'video';
    rtpParameters: any; // Mediasoup RtpParameters
    appData?: any;
}

export interface ConsumeParams {
    transportId: string;
    producerId: string;
    rtpCapabilities: any; // Mediasoup RtpCapabilities
}

export interface ProduceDataParams {
    transportId: string;
    sctpStreamParameters: any; // Mediasoup SctpStreamParameters
    label?: string;
    protocol?: string;
    appData?: any;
}

export interface ConsumeDataParams {
    transportId: string;
    dataProducerId: string;
}

// --- Server Events (Notifications) ---

export type ServerEvents =
    | 'newProducer'
    | 'newDataProducer'
    | 'producerClosed'
    | 'peerJoined'
    | 'peerLeft'
    | 'roomClosed'
    | 'ptz:state';

export interface Notification<T = any> {
    method: ServerEvents;
    params: T;
}
