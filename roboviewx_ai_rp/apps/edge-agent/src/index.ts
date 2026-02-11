import { logger } from './logger';
import { config } from './config';
import { TiltServer } from './tilt/server';
import { P2PSignalingServer } from './p2p/signalingServer';

/**
 * Edge Agent - Main Entry Point
 *
 * P2P Architecture (no mediasoup):
 * - Node runs a minimal WebSocket signaling server
 * - Node supervises a Python aiortc worker subprocess
 * - Python worker owns /dev/video0, sends video via WebRTC P2P and AI detections via DataChannel ("ai")
 * - Viewer (web-vanilla) connects directly to the Python worker using native WebRTC
 */

async function main() {
  logger.info(
    {
      roomId: config.roomId,
      peerId: config.peerId,
      signalingUrl: '(p2p-local)',
      videoSource: config.videoSource,
      edgeVideoSource: config.edgeVideoSource,
      appDataSource: config.appDataSource,
      codec: config.codec,
      tiltPort: config.tiltPort,
    },
    'Starting Edge Agent'
  );
  logger.info('P2P signaling + python worker mode (mediasoup disabled)');

  // Create tilt server
  const tiltServer = new TiltServer(logger);
  const signalingServer = new P2PSignalingServer(logger);

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');

    try {
      await signalingServer.stop();
      await tiltServer.stop();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (error: any) => {
    logger.error({ error }, 'Uncaught exception');
    const code =
      error?.code ??
      error?.context?.statusText?.code ??
      error?.context?.statusText?.errno ??
      error?.cause?.code;

    // Don't exit for transient connection errors (signaling/network). Let supervisor handle reconnect.
    const transientCodes = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ETIMEDOUT',
    ]);

    if (!transientCodes.has(String(code))) {
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, 'Unhandled rejection');
    // Don't exit immediately for connection errors - let reconnection handle it
  });

  try {
    const disableTilt =
      process.env.DISABLE_TILT === '1' ||
      process.env.DISABLE_TILT === 'true' ||
      process.env.DISABLE_TILT === 'yes';

    // Start tilt server (optional; not required for WebRTC pipeline debugging)
    if (disableTilt) {
      logger.warn('Tilt REST API disabled via DISABLE_TILT');
    } else {
      try {
        await tiltServer.start();
        logger.info(`✓ Tilt REST API listening on port ${config.tiltPort}`);
      } catch (e: any) {
        // Do not block WebRTC pipeline on tilt REST server issues.
        const code = e?.code || e?.cause?.code;
        logger.warn(
          { code, error: e },
          'Tilt REST API failed to start; continuing without it'
        );
      }
    }

    // Start P2P signaling server (spawns python worker)
    await signalingServer.start();

    logger.info('Edge Agent running');
    logger.info('Press Ctrl+C to stop');
  } catch (error) {
    logger.error({ error }, 'Failed to start Edge Agent');
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});
