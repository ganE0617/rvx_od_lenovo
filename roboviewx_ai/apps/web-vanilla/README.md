# RoboViewX Vanilla Web Viewer

Pure JavaScript (no frameworks) live video viewer for RoboViewX **P2P WebRTC**.

## Features

- **No Frameworks**: Pure HTML5 + Vanilla JavaScript + TailwindCSS
- **Native WebRTC P2P**: Browser ↔ Python aiortc worker direct connection
- **WebSocket Signaling**: Simple join/offer/answer/candidate via edge-agent
- **AI Overlay**: `detection_v1` JSON over DataChannel (`label="ai"`) rendered on canvas overlay

## Prerequisites

- Node.js 18+
- Edge Agent running (signaling + python worker)

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
VITE_SIGNALING_URL=ws://localhost:8082/ws
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
│   ├── viewer.js          # P2P viewer orchestration (RTCPeerConnection + WS signaling)
│   ├── ui.js              # DOM manipulation & UI state
│   ├── aiOverlay.js       # Canvas overlay rendering (object-contain letterbox correction)
│   └── styles.css         # Tailwind entry
├── vite.config.js         # Vite configuration
├── tailwind.config.js     # Tailwind configuration
├── postcss.config.js      # PostCSS (Tailwind processing)
└── package.json           # Dependencies
```

## Usage

1. **Start Edge Agent** (signaling + python worker)
2. **Open Vanilla Viewer**: `npm run dev` (this directory)
4. **Enter Room ID**: Default is `robot-001`
5. **Click Connect**: Viewer joins and consumes video
6. **AI Overlay**: AI results are sent from the worker over DataChannel and drawn automatically.

## Viewer Flow (P2P)

1. WebSocket connect to edge-agent signaling server
2. `join` → receive `iceServers`
3. Create `RTCPeerConnection({iceServers})`
4. Create offer → send `offer`
5. Receive `answer` → setRemoteDescription
6. Trickle ICE: exchange `iceCandidate`
7. `ontrack` → attach video to `<video>`
8. `ondatachannel(label="ai")` → receive `detection_v1` → `aiOverlay.pushDetection()`

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
- Verify edge-agent signaling is reachable (`VITE_SIGNALING_URL`)
- Ensure camera is available and worker can open `/dev/video0`

### Transport Connection Fails

- Check firewall/NAT settings
- Configure TURN via `ICE_SERVERS_JSON` on edge-agent
- Inspect WebRTC connection state in browser DevTools

### WebSocket Connection Error

- Verify `VITE_SIGNALING_URL` points to edge-agent `/ws`
- Ensure edge-agent is running and port is reachable

## End-to-End Verification Checklist

1. ✅ Edge Agent running (signaling + python worker)
2. ✅ Vite dev server running (port 5173)
3. ✅ Click Connect → video plays
4. ✅ `detection_v1` received (console) and overlay boxes render

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
