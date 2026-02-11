import { Device } from 'mediasoup-client';
import { RtpCapabilities } from 'mediasoup-client/lib/RtpParameters';
import { Logger } from '@repo/logger';
import { getAiortcWorker } from './aiortcWorker';

export class MediasoupDevice {
  private device: Device | null = null;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Initialize device with getRtpCapabilities RPC response (raw).
   * Normalizes all possible response shapes before passing to Device.load().
   */
  public async initialize(capsResp: unknown): Promise<void> {
    this.logger.info('Initializing mediasoup Device');

    // Debug: always log raw getRtpCapabilities response (do not remove)
    this.logger.info(
      {
        capsResp,
        type: typeof capsResp,
        keys: capsResp && typeof capsResp === 'object' ? Object.keys(capsResp as object) : undefined,
      },
      'getRtpCapabilities raw response'
    );

    // Defensive unwrap: support { codecs, headerExtensions } | { rtpCapabilities } | { result } | string
    let routerRtpCapabilities: RtpCapabilities | unknown =
      capsResp && (capsResp as { codecs?: unknown }).codecs !== undefined
        ? (capsResp as RtpCapabilities)
        : capsResp && (capsResp as { rtpCapabilities?: unknown }).rtpCapabilities !== undefined
          ? (capsResp as { rtpCapabilities: RtpCapabilities }).rtpCapabilities
          : capsResp && (capsResp as { result?: unknown }).result !== undefined
            ? (capsResp as { result: RtpCapabilities }).result
            : capsResp;

    if (typeof routerRtpCapabilities === 'string') {
      routerRtpCapabilities = JSON.parse(routerRtpCapabilities) as RtpCapabilities;
    }

    this.logger.info(
      {
        type: typeof routerRtpCapabilities,
        keys:
          routerRtpCapabilities &&
          typeof routerRtpCapabilities === 'object'
            ? Object.keys(routerRtpCapabilities as object)
            : undefined,
      },
      'routerRtpCapabilities normalized'
    );

    if (
      routerRtpCapabilities == null ||
      typeof routerRtpCapabilities !== 'object' ||
      Array.isArray(routerRtpCapabilities)
    ) {
      throw new Error(
        'routerRtpCapabilities must be an object (with codecs and headerExtensions). ' +
          'Check getRtpCapabilities raw response log above.'
      );
    }

    const worker = await getAiortcWorker(this.logger);
    const handlerFactory = worker.createHandlerFactory();

    this.logger.info('Creating Device with handlerFactory');

    try {
      this.device = new Device({ handlerFactory });
      this.logger.debug('Device instance created successfully');
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(
        {
          error: {
            message: err.message,
            stack: err.stack,
            name: err.name,
          },
        },
        'Failed to create Device instance'
      );
      throw error;
    }

    try {
      await this.device.load({ routerRtpCapabilities: routerRtpCapabilities as RtpCapabilities });
      this.logger.info('Device loaded');
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(
        {
          error: {
            message: err.message,
            stack: err.stack,
            name: err.name,
          },
        },
        'Failed to load routerRtpCapabilities'
      );
      throw error;
    }

    this.logger.info(
      {
        loaded: this.device.loaded,
        canProduce: {
          audio: this.device.canProduce('audio'),
          video: this.device.canProduce('video'),
        },
      },
      '✓ Device initialized'
    );
  }

  public getDevice(): Device {
    if (!this.device) {
      throw new Error('Device not initialized');
    }
    return this.device;
  }

  public getRtpCapabilities(): RtpCapabilities {
    if (!this.device) {
      throw new Error('Device not initialized');
    }
    return this.device.rtpCapabilities;
  }

  public canProduce(kind: 'audio' | 'video'): boolean {
    if (!this.device) {
      return false;
    }
    return this.device.canProduce(kind);
  }

  public isLoaded(): boolean {
    return this.device !== null && this.device.loaded;
  }
}
