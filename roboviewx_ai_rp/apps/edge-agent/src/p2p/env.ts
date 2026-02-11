export interface IceServerJson {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface P2PEnv {
  signalingHost: string;
  signalingPort: number;
  roomId: string;
  iceServersJson: string; // stringified JSON array
}

function safeInt(raw: string | undefined, d: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? n : d;
}

export function getP2PEnv(): P2PEnv {
  const signalingHost = process.env.SIGNALING_HOST || '0.0.0.0';
  const signalingPort = safeInt(process.env.SIGNALING_PORT, 8082);
  const roomId = process.env.EDGE_ROOM_ID || 'robot-001';

  // Default ICE: public STUN. TURN can be provided via ICE_SERVERS_JSON.
  const iceServersJson =
    process.env.ICE_SERVERS_JSON ||
    JSON.stringify([{ urls: ['stun:stun.l.google.com:19302'] }]);

  return { signalingHost, signalingPort, roomId, iceServersJson };
}

