# RoboViewX Vanilla Web Viewer

Pure JavaScript (no frameworks) live video viewer for AI Surveillance Service using mediasoup-client.

## Features

- **No Frameworks**: Pure HTML5 + Vanilla JavaScript + TailwindCSS
- **Mediasoup WebRTC**: Full SFU viewer implementation
- **JSON-RPC Signaling**: WebSocket-based protocol matching server spec
- **Auto-reconnect**: Exponential backoff on disconnect
- **Robust Cleanup**: Idempotent resource management

## Prerequisites

- Node.js 18+
- Running Media Server (port 3001)
- Edge Agent publishing video

## Installation

```bash
# From this directory
npm install
```

## Environment Configuration

Create `.env` file:

```bash
cp .env.example .env
```

Configure:
```env
VITE_SIGNALING_URL=ws://localhost:3001
VITE_DEFAULT_ROOM_ID=robot-001
```

## Development

```bash
npm run dev
```

Open `http://localhost:5173` (Vite default port).

## Build

```bash
npm run build
npm run preview
```

## Project Structure

```
apps/web-vanilla/
├── index.html              # Main HTML (Tailwind classes)
├── src/
│   ├── main.js            # Application entry point
│   ├── rpcClient.js       # JSON-RPC WebSocket client
│   ├── viewer.js          # Mediasoup viewer orchestration
│   ├── ui.js              # DOM manipulation & UI state
│   ├── personDetectionOverlay.js  # AI overlay loop + canvas rendering
│   ├── vision/
│   │   └── yolo11Person.js        # YOLO11 preprocess/infer/postprocess (person-only)
│   └── styles.css         # Tailwind entry
├── vite.config.js         # Vite configuration
├── tailwind.config.js     # Tailwind configuration
├── postcss.config.js      # PostCSS (Tailwind processing)
└── package.json           # Dependencies
```

## Usage

1. **Start Media Server**: `cd apps/media-server && npm run dev`
2. **Start Edge Agent**: Ensure publisher is streaming to room
3. **Open Vanilla Viewer**: `npm run dev` (this directory)
4. **Enter Room ID**: Default is `robot-001`
5. **Click Connect**: Viewer joins and consumes video
6. **(Optional) AI Overlay**: See `README_AI_DETECT.md` to run the server/edge inference service. In the UI, toggle **AI Overlay: ON** to show person boxes.

## Viewer Flow

Matches exact protocol from `packages/types`:

1. WebSocket connect to signaling server
2. `joinRoom` (role: viewer, peerId, roomId)
3. Receive `rtpCapabilities` + existing producers
4. Load mediasoup Device with capabilities
5. `createWebRtcTransport` (consuming: true)
6. Device creates recv transport
7. Transport `connect` event → `connectWebRtcTransport` RPC with `dtlsParameters`
8. For each producer: `consume` RPC → transport.consume() → `resume` RPC
9. Attach video track to `<video>` element
10. Handle `newProducer` and `producerClosed` events

## Cleanup

All resources cleaned idempotently on disconnect:
- Close all consumers
- Close recv transport
- Stop media stream tracks
- Disconnect WebSocket
- Clear device reference

## Troubleshooting

### Video Not Playing

- Check browser console for errors
- Verify Media Server is running and accessible
- Ensure Edge Agent is publishing to same room ID
- Check `announcedIp` in Media Server config

### Transport Connection Fails

- Verify UDP ports 40000-49999 are open
- Check firewall/NAT settings
- Consider TURN server for restrictive networks
- Inspect WebRTC connection state in browser DevTools

### WebSocket Connection Error

- Verify `VITE_SIGNALING_URL` matches Media Server
- Check CORS settings on server
- Ensure WebSocket endpoint is correct

## End-to-End Verification Checklist

1. ✅ Media Server running on port 3001
2. ✅ Edge Agent publishing video to room
3. ✅ Vite dev server running (port 5173)
4. ✅ Page loads without errors
5. ✅ Room ID field populated
6. ✅ Click Connect → Status changes to CONNECTING
7. ✅ Status changes to CONNECTED
8. ✅ Status changes to PLAYING
9. ✅ Video element displays live stream
10. ✅ Click Disconnect → Clean shutdown

## Key Implementation Details

**Type Safety:**
- Uses same protocol as `packages/types` (method names, payloads)
- No type duplication or custom protocol extensions

**Reconnection:**
- Exponential backoff (1s, 2s, 4s, 8s, 16s, max 30s)
- Max 5 attempts before giving up
- Manual reconnect via Disconnect → Connect

**Consumer Lifecycle:**
- Handles `producerClosed` event gracefully
- Removes consumer and updates status
- No memory leaks on producer churn

**Video Element:**
- `autoplay`, `playsinline` for mobile support
- `controls` enabled for user control
- `muted="false"` for audio (if available)

## Comparison with React Viewer

| Feature | React (`web-roboviewx`) | Vanilla (`web-vanilla`) |
|---------|-------------------------|-------------------------|
| Framework | React 18 + Hooks | None (Pure JS) |
| Build Tool | Vite | Vite |
| Styling | TailwindCSS | TailwindCSS |
| Bundle Size | ~150KB (gzipped) | ~80KB (gzipped) |
| State Management | React useState | Plain objects |
| Lifecycle | useEffect | Event listeners |

Both viewers use identical signaling protocol and mediasoup logic.

## License

Proprietary
