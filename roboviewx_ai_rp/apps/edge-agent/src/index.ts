import { logger } from './logger';
import { config } from './config';
// Set PYTHON before any import that loads mediasoup-client-aiortc (Worker.js reads it at load time)
import './rtc/setAiortcPythonEnv';
import { ensureAiortcPythonEnv } from './rtc/aiortcWorker';
import { Supervisor } from './lifecycle/supervisor';
import { TiltServer } from './tilt/server';

/**
 * Edge Agent - Main Entry Point
 *
 * This agent runs on Raspberry Pi 4 and:
 * 1. Connects to mediasoup SFU server via WebSocket
 * 2. Joins a room as a publisher
 * 3. Produces a video track (test pattern for MVP)
 * 4. Provides tilt control via REST API
 * 5. Handles reconnection with exponential backoff
 */

async function main() {
  logger.info(
    {
      roomId: config.roomId,
      peerId: config.peerId,
      signalingUrl: config.signalingUrl,
      videoSource: config.videoSource,
      edgeVideoSource: config.edgeVideoSource,
      appDataSource: config.appDataSource,
      codec: config.codec,
      tiltPort: config.tiltPort,
    },
    'Starting Edge Agent'
  );
  logger.info(`Final signaling URL: ${config.signalingUrl}`);

  ensureAiortcPythonEnv(logger);

  // Create supervisor
  const supervisor = new Supervisor(logger);

  // Create tilt server
  const tiltServer = new TiltServer(logger);

  // Handle supervisor events
  supervisor.on('connected', () => {
    logger.info('✓ Edge agent connected and producing video');
  });

  supervisor.on('disconnected', () => {
    logger.warn('Edge agent disconnected');
  });

  supervisor.on('failed', () => {
    logger.error('Edge agent failed - max retries reached');
    process.exit(1);
  });

  supervisor.on('stopped', () => {
    logger.info('Edge agent stopped');
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');

    try {
      await supervisor.stop();
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

    // Start supervisor (connects and produces video)
    await supervisor.start();

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
