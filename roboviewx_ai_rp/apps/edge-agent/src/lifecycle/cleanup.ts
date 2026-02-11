import { Logger } from '@repo/logger';
import { ProducerManager } from '../rtc/producer';
import { SendTransportManager } from '../rtc/sendTransport';
import { SignalingClient } from '../signaling/messages';

/**
 * Cleanup helper for safely closing resources
 */
export class Cleanup {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  public async cleanupAll(
    producerManager: ProducerManager | null,
    transportManager: SendTransportManager | null,
    signalingClient: SignalingClient | null
  ): Promise<void> {
    this.logger.info('Starting cleanup');

    // Close producer first
    if (producerManager) {
      try {
        await producerManager.close();
        this.logger.info('Producer closed');
      } catch (error) {
        this.logger.error({ error }, 'Error closing producer');
      }
    }

    // Close transport
    if (transportManager) {
      try {
        await transportManager.close();
        this.logger.info('Transport closed');
      } catch (error) {
        this.logger.error({ error }, 'Error closing transport');
      }
    }

    // Close signaling
    if (signalingClient) {
      try {
        signalingClient.close();
        this.logger.info('Signaling closed');
      } catch (error) {
        this.logger.error({ error }, 'Error closing signaling');
      }
    }

    this.logger.info('Cleanup complete');
  }
}
