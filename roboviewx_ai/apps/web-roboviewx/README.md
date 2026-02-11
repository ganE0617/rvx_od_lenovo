# RoboViewX Web Viewer

Real-time video streaming viewer for the AI Surveillance Service using mediasoup.

## Prerequisites

- Node.js 18+
- Running Media Server instance
- Edge Agent (Raspberry Pi) publishing video

## Environment Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Configure the signaling server URL:

```env
VITE_SIGNALING_URL=ws://localhost:3001
VITE_DEFAULT_ROOM_ID=robot-001
```

## Installation

```bash
# From repository root
npm install

# Or from this directory
npm install
```

## Development

```bash
npm run dev
```

The app will be available at `http://localhost:3000`.

## Building for Production

```bash
npm run build
npm run preview
```

## Testing

```bash
npm test
```

## Usage

1. **Start Media Server**: Ensure the media server is running on the configured URL
2. **Start Edge Agent**: Have a publisher (e.g., Raspberry Pi) streaming to the room
3. **Open Web App**: Navigate to `http://localhost:3000`
4. **Enter Room ID**: Input the room ID (default: `robot-001`)
5. **Click Connect**: The viewer will join and start consuming video

## Viewer Flow

The mediasoup-client viewer follows this sequence:

1. **Connect WebSocket** to signaling server
2. **Join Room** as viewer with unique peer ID
3. **Load Device** with router RTP capabilities
4. **Create Recv Transport** for consuming media
5. **Consume Tracks** from existing producers
6. **Handle Events** for new producers and closures

## Troubleshooting

### No Video Displayed

- **Check Network**: Ensure UDP ports 40000-49999 are accessible
- **Verify Announced IP**: Media server must have correct `MEDIASOUP_ANNOUNCED_IP`
- **Check Console**: Look for WebRTC connection state errors
- **Codec Mismatch**: Verify client and server support common codecs (VP8/H.264)

### Connection Fails

- **Signaling URL**: Verify `VITE_SIGNALING_URL` matches media server
- **CORS**: Ensure media server allows WebSocket connections
- **Room ID**: Confirm the room exists and has an active publisher

### Transport State "failed"

- **ICE/DTLS**: Check browser developer tools Network tab for ICE failures
- **Firewall**: Ensure UDP is not blocked
- **TURN Server**: Consider adding TURN if behind strict NAT

## End-to-End Verification Checklist

1. ✅ Media server starts without errors
2. ✅ Docker containers (Postgres, Redis) are running
3. ✅ Edge agent connects and publishes video
4. ✅ Web app loads and shows UI
5. ✅ Room ID input accepts value
6. ✅ Connect button triggers WebSocket connection
7. ✅ Status changes to CONNECTED then PLAYING
8. ✅ Video element displays live stream
9. ✅ Disconnect cleanly closes resources
10. ✅ Reconnection works after network interruption

## Architecture

```
┌─────────────┐      WebSocket (JSON-RPC)      ┌──────────────┐
│   Browser   │◄──────────────────────────────►│ Media Server │
│  (Viewer)   │                                 │  (Mediasoup) │
└─────────────┘                                 └──────────────┘
       │                                               ▲
       │ mediasoup-client                              │
       │ WebRTC (UDP)                                  │ WebRTC (UDP)
       └───────────────────────────────────────────────┘
                                                       │
                                                       │
                                              ┌────────┴────────┐
                                              │   Edge Agent    │
                                              │  (Publisher)    │
                                              └─────────────────┘
```

## Key Files

- `src/lib/rpcClient.ts` - JSON-RPC WebSocket client
- `src/hooks/useMediasoupViewer.ts` - Mediasoup viewer hook
- `src/pages/LiveViewPage.tsx` - Main viewer UI
- `package.json` - Dependencies (mediasoup-client 3.7.0)

## License

Proprietary
