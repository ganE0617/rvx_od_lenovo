import { RpcClient } from './rpcClient';
import {
  JoinRoomRequest,
  JoinRoomResponse,
  GetRtpCapabilitiesRequest,
  GetRtpCapabilitiesResponse,
  CreateWebRtcTransportRequest,
  CreateWebRtcTransportResponse,
  ConnectWebRtcTransportRequest,
  ConnectWebRtcTransportResponse,
  ProduceRequest,
  ProduceResponse,
  CloseProducerRequest,
  CloseProducerResponse,
  // @repo/types may not include datachannel RPCs yet; we call them as `any`.
} from '@repo/types';

/**
 * Typed helper methods for signaling protocol
 */
export class SignalingClient {
  constructor(private rpcClient: RpcClient) {}

  public async joinRoom(
    roomId: string,
    peerId: string,
    role: 'publisher' | 'subscriber'
  ): Promise<JoinRoomResponse> {
    const params: JoinRoomRequest = { roomId, peerId, role };
    return this.rpcClient.request<JoinRoomResponse>('joinRoom', params);
  }

  public async getRtpCapabilities(roomId: string): Promise<GetRtpCapabilitiesResponse> {
    const params: GetRtpCapabilitiesRequest = { roomId };
    return this.rpcClient.request<GetRtpCapabilitiesResponse>(
      'getRtpCapabilities',
      params
    );
  }

  public async createWebRtcTransport(
    roomId: string,
    peerId: string,
    direction: 'send' | 'recv'
  ): Promise<CreateWebRtcTransportResponse> {
    const params: CreateWebRtcTransportRequest = { roomId, peerId, direction };
    return this.rpcClient.request<CreateWebRtcTransportResponse>(
      'createWebRtcTransport',
      params
    );
  }

  public async connectWebRtcTransport(
    roomId: string,
    peerId: string,
    transportId: string,
    dtlsParameters: any
  ): Promise<ConnectWebRtcTransportResponse> {
    const params: ConnectWebRtcTransportRequest = {
      roomId,
      peerId,
      transportId,
      dtlsParameters,
    };
    return this.rpcClient.request<ConnectWebRtcTransportResponse>(
      'connectWebRtcTransport',
      params
    );
  }

  public async produce(
    roomId: string,
    peerId: string,
    transportId: string,
    kind: 'audio' | 'video',
    rtpParameters: any,
    appData?: any
  ): Promise<ProduceResponse> {
    const params: ProduceRequest = {
      roomId,
      peerId,
      transportId,
      kind,
      rtpParameters,
      appData,
    };
    return this.rpcClient.request<ProduceResponse>('produce', params);
  }

  public async closeProducer(
    roomId: string,
    peerId: string,
    producerId: string
  ): Promise<CloseProducerResponse> {
    const params: CloseProducerRequest = { roomId, peerId, producerId };
    return this.rpcClient.request<CloseProducerResponse>('closeProducer', params);
  }

  public async produceData(
    roomId: string,
    peerId: string,
    transportId: string,
    sctpStreamParameters: any,
    label?: string,
    protocol?: string,
    appData?: any
  ): Promise<{ id: string }> {
    const params: any = {
      roomId,
      peerId,
      transportId,
      sctpStreamParameters,
      label,
      protocol,
      appData,
    };
    return this.rpcClient.request<{ id: string }>('produceData', params);
  }

  public onNotification(
    handler: (method: string, params: any) => void
  ): void {
    this.rpcClient.on('notification', handler);
  }

  public onClose(handler: () => void): void {
    this.rpcClient.on('close', handler);
  }

  public onError(handler: (error: Error) => void): void {
    this.rpcClient.on('error', handler);
  }

  public close(): void {
    this.rpcClient.close();
  }

  public isConnected(): boolean {
    return this.rpcClient.isConnected();
  }
}
