import path from 'path';
import dotenv from 'dotenv';

// Load .env from app dir so it works when run from monorepo root
dotenv.config({ path: path.join(__dirname, '../.env'), override: true });
dotenv.config({ override: true });

import express from 'express';
import fetch from 'node-fetch';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createLogger } from '@repo/logger';
import { config } from './config';
import { WorkerManager } from './lib/WorkerManager';
import { RoomManager } from './lib/RoomManager';
import { SignalingServer } from './server/signaling';
import { AiBridge } from './server/aiBridge';

const logger = createLogger('media-server');

function sanitizeUrl(raw: string | undefined): { raw: string | undefined; sanitized: string | undefined } {
    if (raw == null) return { raw, sanitized: raw };
    const trimmed = raw.trim();

    // Handle accidental Markdown link format: [text](url)
    const md = trimmed.match(/^\s*\[[^\]]+\]\(([^)]+)\)\s*$/);
    const candidate = (md?.[1] ?? trimmed).trim();

    // Also handle accidental bracket-wrapped URL: [http://127.0.0.1:8080]
    const bracket = candidate.match(/^\[([^\]]+)\]$/);
    const out = (bracket?.[1] ?? candidate).trim();
    return { raw, sanitized: out };
}

async function main() {
    const app = express();
    app.use(express.json());
    
    // CORS middleware for PTZ API calls from browser
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            return res.sendStatus(200);
        }
        next();
    });
    
    const httpServer = createServer(app);
    const io = new Server(httpServer, {
        cors: { origin: '*' },
    });

    // Services
    const workerManager = new WorkerManager();
    await workerManager.init();

    // Tilt/PTZ Control Proxy
    // Same-host default: edge-agent TiltServer runs locally (see roboviewx_ai_rp/apps/edge-agent/src/tilt/server.ts).
    // Override via PI_TILT_BASE_URL if the PTZ device/controller is remote.
    const piTiltUrlSan = sanitizeUrl(process.env.PI_TILT_BASE_URL);
    const PI_TILT_BASE_URL = piTiltUrlSan.sanitized || 'http://127.0.0.1:8080';
    console.log(`[DEBUG] Final PI_TILT_BASE_URL in process: ${PI_TILT_BASE_URL}`);
    if (piTiltUrlSan.raw && piTiltUrlSan.raw !== piTiltUrlSan.sanitized) {
        logger.warn(`PI_TILT_BASE_URL sanitized: "${piTiltUrlSan.raw}" -> "${piTiltUrlSan.sanitized}"`);
    }

    const roomManager = new RoomManager(workerManager);
    const signaling = new SignalingServer(io, roomManager, PI_TILT_BASE_URL);
    const aiBridge = new AiBridge(httpServer, io);

    // REST API (Basic)
    app.get('/health', (req, res) =>
        res.json({
            status: 'ok',
            aiBridge: { wsPath: '/ws/ai', publishRole: 'publisher', viewerRole: 'viewer' },
        })
    );

    logger.info(`PTZ Proxy configured for: ${PI_TILT_BASE_URL}`);

    app.get('/api/robots/:roomId/tilt', async (req, res) => {
        try {
            const response = await fetch(`${PI_TILT_BASE_URL}/tilt`, { timeout: 3000 });
            if (!response.ok) throw new Error(`Pi returned ${response.status}`);
            const data: any = await response.json();
            // Map Pi's 'angle' to our 'angle' if needed
            res.json(data);
        } catch (error: any) {
            logger.error(`Failed to get tilt: ${error.message}`);
            res.status(502).json({ error: 'Failed to communicate with robot' });
        }
    });

    app.post('/api/robots/:roomId/tilt', async (req, res) => {
        try {
            const { angle } = req.body;
            const response = await fetch(`${PI_TILT_BASE_URL}/tilt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ angle }),
                timeout: 3000
            });
            if (!response.ok) throw new Error(`Pi returned ${response.status}`);
            const data = await response.json();
            res.json(data);
        } catch (error: any) {
            logger.error(`Failed to set tilt: ${error.message}`);
            res.status(502).json({ error: 'Failed to communicate with robot' });
        }
    });

    app.get('/api/robots/:roomId/ptz', async (req, res) => {
        const { roomId } = req.params;
        const url = `${PI_TILT_BASE_URL}/ptz`;
        logger.info(`[PTZ] Route GET roomId=${roomId}`);
        logger.info(`[PTZ] Fetching ${url}`);
        try {
            const response = await fetch(url, { timeout: 3000 });

            if (response.status === 404) {
                // Fallback if Pi hasn't implemented GET /ptz yet
                return res.json({
                    ok: true,
                    pan: 0,
                    tilt: 0,
                    zoom: 1.0,
                    minPan: -180,
                    maxPan: 180,
                    minTilt: -90,
                    maxTilt: 90,
                    minZoom: 1.0,
                    maxZoom: 3.0
                });
            }

            const start = Date.now();
            if (!response.ok) {
                const errorText = await response.text();
                logger.warn(`PTZ GET non-OK ${response.status}: ${errorText}`);
                let msg = errorText;
                try {
                    const j = JSON.parse(errorText);
                    msg = j?.message || j?.error || msg;
                } catch { /* ignore */ }
                return res.json({
                    ok: false,
                    state: null,
                    status: response.status,
                    reason: 'http_error',
                    detail: msg,
                    error: `Pi (${PI_TILT_BASE_URL}) returned ${response.status}${msg ? `: ${msg}` : ''}`
                });
            }
            const data: any = await response.json();
            // Reduced logging for low-latency operation

            // Pi returns wrapped state: { ok: true, state: { pan, tilt, zoom } }
            const state = data.state || data;
            const limits = data.limits;
            const supported = limits?.supported ?? data.supported;

            const minPan = limits?.pan?.min ?? -180;
            const maxPan = limits?.pan?.max ?? 180;
            const minTilt = limits?.tilt?.min ?? -90;
            const maxTilt = limits?.tilt?.max ?? 90;
            const minZoom = limits?.zoom?.min ?? 1.0;
            const maxZoom = limits?.zoom?.max ?? 3.0;

            res.json({
                ok: true,
                status: 200,
                pan: state.pan ?? 0,
                tilt: state.tilt ?? 0,
                zoom: state.zoom ?? 1.0,
                minPan,
                maxPan,
                minTilt,
                maxTilt,
                minZoom,
                maxZoom,
                ...(limits ? { limits } : {}),
                ...(supported ? { supported } : {}),
            });
        } catch (error: any) {
            logger.warn(`Failed to get ptz: ${error.message}`);
            res.json({
                ok: false,
                state: null,
                status: 0,
                reason: 'network',
                detail: error?.message || String(error),
                error: 'unreachable'
            });
        }
    });

    app.post('/api/robots/:roomId/ptz', async (req, res) => {
        const { roomId } = req.params;
        const url = `${PI_TILT_BASE_URL}/ptz`;
        logger.info(`[PTZ] Route POST roomId=${roomId}`);
        logger.info(`[PTZ] Fetching ${url}`);
        try {
            const { pan, tilt, zoom } = req.body;
            // Standardized payload for RPi
            const body: any = {};
            if (pan !== undefined) body.pan = pan;
            if (tilt !== undefined) body.tilt = tilt;
            if (zoom !== undefined) body.zoom = zoom;

            const t0 = Date.now();
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                timeout: 3000
            });
            if (!response.ok) {
                const errorText = await response.text();
                logger.warn(`PTZ POST non-OK ${response.status}: ${errorText}`);
                let msg = errorText;
                try {
                    const j = JSON.parse(errorText);
                    msg = j?.message || j?.error || msg;
                } catch { /* ignore */ }
                if (process.env.PTZ_DEBUG === '1') {
                    logger.warn(`[PTZ_DEBUG] upstream POST status=${response.status} durationMs=${Date.now() - t0} body=${JSON.stringify(body)}`);
                }
                return res.json({
                    ok: false,
                    state: null,
                    status: response.status,
                    reason: 'http_error',
                    detail: msg,
                    error: `Pi (${PI_TILT_BASE_URL}) returned ${response.status}${msg ? `: ${msg}` : ''}`
                });
            }
            const data: any = await response.json();
            // Reduced logging for low-latency operation

            // Broadcast status to all viewers in the room
            const state = data.state || { pan, tilt, zoom };
            signaling.broadcastPtzState(roomId, state);

            const limits = data.limits;
            const supported = limits?.supported ?? data.supported;

            // Keep response shape consistent with GET /ptz and web-vanilla expectations
            res.json({
                ok: true,
                status: 200,
                state,
                pan: state.pan ?? pan ?? 0,
                tilt: state.tilt ?? tilt ?? 0,
                zoom: state.zoom ?? zoom ?? 1.0,
                ...(limits ? { limits } : {}),
                ...(supported ? { supported } : {}),
            });
        } catch (error: any) {
            logger.warn(`Failed to set ptz: ${error.message}`);
            res.json({
                ok: false,
                state: null,
                status: 0,
                reason: 'network',
                detail: error?.message || String(error),
                error: 'unreachable'
            });
        }
    });

    const port = Number(process.env.PORT) || 3001;
    
    // === RUNTIME VERIFICATION LOGGING ===
    logger.info('════════════════════════════════════════════════════════');
    logger.info('    LOW-LATENCY CONFIGURATION VERIFICATION');
    logger.info('════════════════════════════════════════════════════════');
    const listenIp = config.mediasoup.webRtcTransportOptions.listenIps[0];
    logger.info('FINAL WebRTC listenIps / announcedIp / rtc ports:');
    logger.info(`  listenIp: ${listenIp?.ip ?? '0.0.0.0'}, announcedIp: ${(listenIp as any)?.announcedIp ?? '127.0.0.1'}, rtcPorts: ${config.mediasoup.workerSettings.rtcMinPort}-${config.mediasoup.workerSettings.rtcMaxPort}`);
    logger.info('Transport Settings:');
    logger.info(`  • TCP Enabled: ${config.mediasoup.webRtcTransportOptions.enableTcp} (should be FALSE)`);
    logger.info(`  • UDP Enabled: ${config.mediasoup.webRtcTransportOptions.enableUdp} (should be TRUE)`);
    logger.info(`  • Initial Bitrate: ${config.mediasoup.webRtcTransportOptions.initialAvailableOutgoingBitrate / 1000000} Mbps`);
    const minBr = (config.mediasoup.webRtcTransportOptions as any).minimumAvailableOutgoingBitrate;
    if (minBr != null) logger.info(`  • Minimum Bitrate: ${minBr / 1000} kbps`);
    
    const vp8Codec = config.mediasoup.routerOptions.mediaCodecs.find(c => c.mimeType === 'video/VP8');
    logger.info('VP8 Codec Settings:');
    logger.info(`  • Start Bitrate: ${vp8Codec?.parameters?.['x-google-start-bitrate']} kbps`);
    logger.info(`  • Max Bitrate: ${vp8Codec?.parameters?.['x-google-max-bitrate']} kbps`);
    logger.info(`  • Min Bitrate: ${vp8Codec?.parameters?.['x-google-min-bitrate']} kbps`);
    
    logger.info('Expected Intervals:');
    logger.info('  • Stats polling: 30 seconds (producer & consumer)');
    logger.info('  • PTZ polling: 30 seconds (client-side)');
    logger.info('  • Consumer start state: UNPAUSED (immediate playback)');
    logger.info('  • RTX (retransmission): ENABLED (always available for reliability)');
    logger.info('════════════════════════════════════════════════════════');
    
    httpServer.listen(port, '0.0.0.0', () => {
        logger.info(`Media Server listening on 0.0.0.0:${port} (signaling + HTTP)`);
        logger.info(`RTC Ports: ${config.mediasoup.workerSettings.rtcMinPort}-${config.mediasoup.workerSettings.rtcMaxPort}`);
    });

    process.on('unhandledRejection', (reason) => {
        logger.error(`[FATAL] Unhandled promise rejection: ${reason}`);
    });
    process.on('uncaughtException', (err) => {
        logger.error(`[FATAL] Uncaught exception: ${err?.message || err}`);
    });

    // Graceful Shutdown
    process.on('SIGTERM', async () => {
        logger.info('SIGTERM received, closing...');
        aiBridge.close();
        await workerManager.close();
        process.exit(0);
    });
}

main().catch((err) => {
    logger.error(`Failed to start server: ${err}`);
    process.exit(1);
});
