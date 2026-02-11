import { RtpCodecCapability, WorkerLogTag } from 'mediasoup/node/lib/types';
import os from 'os';

const getLocalIp = () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
};

// MEDIASOUP_MODE for same-host debugging:
// - "loopback": listenIp=127.0.0.1, no announcedIp (ICE uses only loopback)
// - "hostip": listenIp=<LAN_IP>, announcedIp=<LAN_IP> (ICE uses only host IP)
// - undefined/other: default behavior (listenIp=0.0.0.0, announcedIp from env or 127.0.0.1)
const mode = process.env.MEDIASOUP_MODE?.toLowerCase();
const hostIp = getLocalIp();

let listenIp: string;
let announcedIp: string | undefined;

if (mode === 'loopback') {
    listenIp = '127.0.0.1';
    announcedIp = undefined; // mediasoup will use listenIp
    console.log('[CONFIG] MEDIASOUP_MODE=loopback: listenIp=127.0.0.1, announcedIp=undefined');
} else if (mode === 'hostip') {
    listenIp = hostIp;
    // NOTE: for same-LAN testing, prefer host candidates without announcedIp first.
    // If needed, user can still set MEDIASOUP_ANNOUNCED_IP explicitly.
    announcedIp = undefined;
    console.log(`[CONFIG] MEDIASOUP_MODE=hostip: listenIp=${hostIp}, announcedIp=undefined`);
} else {
    // Default:
    // - listen on all interfaces (0.0.0.0)
    // - announce a non-loopback IP by default (hostIp) so ICE works when the client
    //   is not strictly using loopback routing (common on multi-NIC / bridged setups).
    // Use MEDIASOUP_MODE=loopback if you truly want loopback-only candidates.
    listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
    const announcedIpRaw = process.env.MEDIASOUP_ANNOUNCED_IP;
    announcedIp = (announcedIpRaw === '' || announcedIpRaw === undefined)
        ? hostIp
        : announcedIpRaw.trim() || hostIp;
    console.log(`[CONFIG] Default mode: listenIp=${listenIp}, announcedIp=${announcedIp}`);
}

const enableTcp =
    process.env.MEDIASOUP_ENABLE_TCP !== undefined
        ? process.env.MEDIASOUP_ENABLE_TCP !== 'false'
        : (mode === 'loopback' || mode === 'hostip')
            ? false
            : true;

export const config = {
    // Mediasoup Worker Settings
    mediasoup: {
        numWorkers: Object.keys(os.cpus()).length,
        workerSettings: {
            // NOTE: Use MEDIASOUP_WORKER_LOG_LEVEL=debug to get worker ICE/DTLS logs for diagnosis.
            logLevel: (process.env.MEDIASOUP_WORKER_LOG_LEVEL as any) || 'warn',
            logTags: [
                'info',
                'ice',
                'dtls',
                'rtp',
                'srtp',
                'rtcp',
                'rtx',
                'bwe',
            ] as WorkerLogTag[],
            rtcMinPort: Number(process.env.MEDIASOUP_MIN_PORT) || 40000,
            rtcMaxPort: Number(process.env.MEDIASOUP_MAX_PORT) || 49999,
        },
        // Router Settings
        routerOptions: {
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                },
                // VP8 only for stability (WebRTC + aiortc + mediasoup). H264 disabled to avoid encoder/negotiation issues.
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    parameters: {
                        'x-google-start-bitrate': 1000,
                    },
                },
            ] as RtpCodecCapability[],
        },
        // WebRtcTransport Settings
        webRtcTransportOptions: {
            listenIps: announcedIp !== undefined
                ? [{ ip: listenIp, announcedIp }]
                : [{ ip: listenIp }],
            initialAvailableOutgoingBitrate: 1000000,
            maxSctpMessageSize: 262144,
            enableUdp: true,
            enableTcp,
            preferUdp: true,
        },
    },
};
