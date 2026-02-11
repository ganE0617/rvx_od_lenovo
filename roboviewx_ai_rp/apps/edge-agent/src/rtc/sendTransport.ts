import { Transport } from 'mediasoup-client/lib/Transport';
import { Device } from 'mediasoup-client';
import { Logger } from '@repo/logger';
import { SignalingClient } from '../signaling/messages';
import { config } from '../config';

export class SendTransportManager {
  private transport: Transport | null = null;
  private transportId: string | null = null;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  public async createTransport(
    device: Device,
    signalingClient: SignalingClient
  ): Promise<Transport> {
    this.logger.info('Creating send transport');

    const rawResp = await signalingClient.createWebRtcTransport(
      config.roomId,
      config.peerId,
      'send'
    );

    // Debug: raw createWebRtcTransport response (do not remove)
    this.logger.info(
      {
        rawResp,
        type: typeof rawResp,
        keys: rawResp && typeof rawResp === 'object' ? Object.keys(rawResp as object) : undefined,
      },
      'createWebRtcTransport raw response'
    );

    // Defensive unwrap: resp | resp.result | resp.transportOptions
    const raw = rawResp as unknown;
    const resp: Record<string, unknown> =
      raw && typeof raw === 'object' && (raw as Record<string, unknown>).id !== undefined
        ? (raw as Record<string, unknown>)
        : raw && typeof raw === 'object' && (raw as Record<string, unknown>).transportId !== undefined
          ? (raw as Record<string, unknown>)
          : raw && typeof raw === 'object' && (raw as Record<string, unknown>).result !== undefined
            ? (raw as { result: Record<string, unknown> }).result
            : raw && typeof raw === 'object' && (raw as Record<string, unknown>).transportOptions !== undefined
              ? (raw as { transportOptions: Record<string, unknown> }).transportOptions
              : (raw as Record<string, unknown>);

    const id = (resp?.id ?? resp?.transportId) as string | undefined;
    const iceParameters = resp?.iceParameters;
    const iceCandidates = resp?.iceCandidates;
    const dtlsParameters = resp?.dtlsParameters;
    const sctpParameters = resp?.sctpParameters;

    if (id == null || id === '') {
      throw new Error(
        'createWebRtcTransport response missing id/transportId. Check createWebRtcTransport raw response log.'
      );
    }
    if (iceParameters == null || typeof iceParameters !== 'object') {
      throw new Error(
        'createWebRtcTransport response missing or invalid iceParameters. Check createWebRtcTransport raw response log.'
      );
    }
    if (!Array.isArray(iceCandidates)) {
      throw new Error(
        'createWebRtcTransport response missing or invalid iceCandidates (must be array). Check createWebRtcTransport raw response log.'
      );
    }
    if (dtlsParameters == null || typeof dtlsParameters !== 'object') {
      throw new Error(
        'createWebRtcTransport response missing or invalid dtlsParameters. Check createWebRtcTransport raw response log.'
      );
    }

    this.transportId = id;

    this.logger.info(
      {
        id: this.transportId,
        iceParameters,
        iceCandidatesCount: iceCandidates.length,
        hasDtlsParameters: !!dtlsParameters,
      },
      'Send transport created on server'
    );

    this.transport = device.createSendTransport({
      id,
      iceParameters: iceParameters as import('mediasoup-client/lib/types').IceParameters,
      iceCandidates: iceCandidates as import('mediasoup-client/lib/types').IceCandidate[],
      dtlsParameters: dtlsParameters as import('mediasoup-client/lib/types').DtlsParameters,
      ...(sctpParameters && typeof sctpParameters === 'object' ? { sctpParameters: sctpParameters as any } : {}),
    });

    this.logger.info({ id: this.transportId }, 'sendTransport created locally');

    // Handle 'connect' event
    this.transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        const fingerprints = dtlsParameters?.fingerprints;
        const fingerprintsLen = fingerprints?.length ?? 0;
        const roleOriginal = dtlsParameters?.role;

        if (!fingerprints || fingerprints.length === 0) {
          throw new Error('DTLS fingerprints not ready (send transport). Ensure aiortc setLocalDescription(offer) completes before connect.');
        }

        // mediasoup expects remote DTLS role = 'client' for the connecting endpoint.
        // Force it, because aiortc may report 'server' depending on offer/answer flow.
        if (dtlsParameters) {
          dtlsParameters.role = 'client';
        }

        this.logger.info({
          transportId: this.transportId,
          dtlsRoleOriginal: roleOriginal,
          dtlsRoleSent: dtlsParameters?.role,
          fingerprintsLen,
        }, 'Connecting send transport (DTLS) [FORCED ROLE=client]');

        await signalingClient.connectWebRtcTransport(
          config.roomId,
          config.peerId,
          this.transportId!,
          dtlsParameters
        );

        this.logger.info('Transport connected');
        callback();
      } catch (error) {
        this.logger.error({ error }, 'Failed to connect transport');
        errback(error as Error);
      }
    });

    // Handle 'produce' event
    this.transport.on(
      'produce',
      async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          this.logger.info({ kind, transportId: this.transportId }, 'Producing track');

          const response = await signalingClient.produce(
            config.roomId,
            config.peerId,
            this.transportId!,
            kind,
            rtpParameters,
            appData
          );

          this.logger.info({ producerId: response.producerId }, 'Producer created');
          callback({ id: response.producerId });
        } catch (error) {
          this.logger.error({ error }, 'Failed to produce');
          errback(error as Error);
        }
      }
    );

    // Handle 'producedata' event (SCTP/DataChannel via mediasoup DataProducer)
    this.transport.on(
      'producedata' as any,
      async ({ sctpStreamParameters, label, protocol, appData }: any, callback: any, errback: any) => {
        try {
          this.logger.info(
            { transportId: this.transportId, label, protocol, sctpStreamParameters },
            'Producing data channel'
          );
          this.logger.info(
            { transportId: this.transportId, label, protocol, appDataKeys: appData ? Object.keys(appData) : [] },
            'producedata event fired'
          );
          const response = await signalingClient.produceData(
            config.roomId,
            config.peerId,
            this.transportId!,
            sctpStreamParameters,
            label,
            protocol,
            appData
          );
          this.logger.info(
            { transportId: this.transportId, label, dataProducerId: response?.id },
            'producedata ack from server'
          );
          if (label === 'ai') {
            this.logger.info(
              { dataProducerId: response?.id, sctpStreamParameters },
              'AI DataProducer created (label=ai)'
            );
          }
          callback({ id: response.id });
        } catch (error) {
          this.logger.error({ error }, 'Failed to produce data channel');
          errback(error as Error);
        }
      }
    );

    // Handle connection state changes
    this.transport.on('connectionstatechange', (state) => {
      this.logger.info({ state, transportId: this.transportId }, 'Transport state changed');

      if (state === 'failed' || state === 'closed') {
        this.logger.error('Transport connection failed or closed');
      }
    });

    // Additional ICE/DTLS state logging for debugging
    if ((this.transport as any).on) {
      (this.transport as any).on('icestatechange', (state: string) => {
        this.logger.info({ iceState: state, transportId: this.transportId }, '[TRANSPORT] ICE state changed');
      });

      (this.transport as any).on('iceconnectionstatechange', (state: string) => {
        this.logger.info({ iceConnectionState: state, transportId: this.transportId }, '[TRANSPORT] ICE connection state changed');
      });

      (this.transport as any).on('icegatheringstatechange', (state: string) => {
        this.logger.info({ iceGatheringState: state, transportId: this.transportId }, '[TRANSPORT] ICE gathering state changed');
      });
    }

    // Log underlying RTCPeerConnection state if available
    if ((this.transport as any)._handler?.connection) {
      const pc = (this.transport as any)._handler.connection;
      if (pc.addEventListener) {
        pc.addEventListener('icecandidateerror', (event: any) => {
          this.logger.warn({
            transportId: this.transportId,
            address: event.address,
            port: event.port,
            url: event.url,
            errorCode: event.errorCode,
            errorText: event.errorText,
          }, '[ICE] Candidate error');
        });

        pc.addEventListener('iceconnectionstatechange', () => {
          this.logger.info({
            transportId: this.transportId,
            iceConnectionState: pc.iceConnectionState,
            iceGatheringState: pc.iceGatheringState,
            connectionState: pc.connectionState,
            signalingState: pc.signalingState,
          }, '[PC] RTCPeerConnection state');
        });
      }
    }

    this.logger.info('Send transport ready');
    return this.transport;
  }

  public getTransport(): Transport | null {
    return this.transport;
  }

  public getTransportId(): string | null {
    return this.transportId;
  }

  public async close(): Promise<void> {
    if (this.transport) {
      this.logger.info({ transportId: this.transportId }, 'Closing send transport');
      this.transport.close();
      this.transport = null;
      this.transportId = null;
    }
  }
}
