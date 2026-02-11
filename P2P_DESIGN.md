# Roboviewx P2P WebRTC Architecture (No mediasoup)

This repository was refactored to remove mediasoup/SFU and run **direct P2P WebRTC** between:

- **Viewer (Browser)**: `roboviewx_ai/apps/web-vanilla`
- **Publisher (Python aiortc worker)**: `roboviewx_ai_rp/apps/edge-agent/python/p2p_webrtc_worker.py`
- **Signaling (Node edge-agent)**: `roboviewx_ai_rp/apps/edge-agent` (WebSocket server)

Goals:
- Camera device (`/dev/video0`) is opened by **a single process** (Python worker).
- Video continues even if AI fails/slows (**AI cannot block video**).
- AI results are sent as stable `detection_v1` JSON over WebRTC **DataChannel** labeled `ai`.

---

## Planes

### Control plane (signaling)
**Transport**: WebSocket

**Server**: Node edge-agent WebSocket server
- URL: `ws://<EDGE_HOST>:<SIGNALING_PORT>/ws`
- Implementation: `roboviewx_ai_rp/apps/edge-agent/src/p2p/signalingServer.ts`

**Participants**:
- Viewer (browser) connects to Node server.
- Node relays signaling to/from the Python worker via **stdin/stdout line-delimited JSON**.

#### Browser → Node message types
- `join`
- `offer`
- `iceCandidate`
- `leave`

#### Node → Browser message types
- `joined` (includes ICE servers)
- `answer`
- `iceCandidate`
- `error`

#### Node ↔ Worker IPC message types (stdin/stdout)
Worker prints to stdout (Node parses):
- `{"type":"worker-ready","pid":123}`
- `{"type":"answer","sdp":"...","sdpType":"answer"}`
- `{"type":"iceCandidate","candidate":{...}}`

Node writes to worker stdin:
- `{"type":"offer","sdp":"...","sdpType":"offer"}`
- `{"type":"iceCandidate","candidate":{...}}`
- `{"type":"leave"}`
- `{"type":"shutdown"}`

> **Important**: stderr is reserved for logs only. Do not parse AI from stderr anymore.

---

### Media plane (video)
**Transport**: WebRTC SRTP (P2P)

**Publisher**: Python aiortc worker
- Captures from `/dev/video0` using `aiortc.contrib.media.MediaPlayer` with `v4l2` format.
- Adds a send-only video transceiver to `RTCPeerConnection`.
- Codec preference configurable via `P2P_VIDEO_CODEC` (default: VP8).

**Viewer**: Browser
- Uses `RTCPeerConnection.ontrack` to attach video track to `<video>`.

---

### Data plane (AI metadata)
**Transport**: WebRTC SCTP DataChannel

**Channel label**: `ai`

**Negotiation note**:
- The **browser (offerer)** must create the DataChannel (`pc.createDataChannel("ai")`) **before** `createOffer()`,
  otherwise the SDP offer won't include `m=application` and the worker cannot negotiate the channel in its answer.

**Payload**: `detection_v1` JSON string:
```json
{
  "type":"detection_v1",
  "robotId":"robot-001",
  "ts_ms": 1700000000000,
  "frame": { "w": 1280, "h": 720, "id": 123 },
  "detections": [
    { "label":"person", "classId":0, "score":0.87, "bbox":{"x1":120,"y1":44,"x2":420,"y2":600} }
  ]
}
```

**Heartbeat** (optional):
```json
{ "type":"ai_heartbeat", "ts_ms": 1700000000000 }
```

The Viewer feeds `detection_v1` into `aiOverlay.js` which already implements **object-contain letterbox correction**.

---

## ICE / STUN / TURN configuration

Environment variable: **`ICE_SERVERS_JSON`**

Examples:

### STUN only
```bash
ICE_SERVERS_JSON='[{"urls":["stun:stun.l.google.com:19302"]}]'
```

### TURN (recommended for NAT traversal)
```bash
ICE_SERVERS_JSON='[
  {"urls":["stun:stun.l.google.com:19302"]},
  {"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"USER","credential":"PASS"}
]'
```

The Node signaling server sends the ICE servers to the browser in the `joined` message, and also passes the same JSON to the Python worker env.

---

## Run commands (local)

### 1) Start edge-agent (signaling + python worker)
```bash
SIGNALING_HOST=0.0.0.0 SIGNALING_PORT=8082 \
ICE_SERVERS_JSON='[{"urls":["stun:stun.l.google.com:19302"]}]' \
EDGE_ROOM_ID=robot-001 \
EDGE_VIDEO_SOURCE="v4l2:/dev/video0?size=1280x720&fps=30&format=mjpeg" \
P2P_VIDEO_CODEC=vp8 \
AI_ENABLE=1 AI_MODEL_PATH="/home/spacebank/roboviewx/roboviewx_ai/apps/ai-inference/yolo11n.pt" \
AI_FPS=10 AI_SEND_HZ=12 AI_CONF=0.25 AI_IOU=0.45 AI_INPUT_W=640 AI_INPUT_H=360 \
npm -C roboviewx_ai_rp/apps/edge-agent run dev
```

### 2) Start viewer UI
```bash
VITE_SIGNALING_URL="ws://127.0.0.1:8082/ws" \
VITE_DEFAULT_ROOM_ID="robot-001" \
npm -C roboviewx_ai/apps/web-vanilla run dev
```

Open the UI, click **Connect**.

---

## Smoke test checklist
- **Signaling**
  - browser console shows: `joined, iceServers=...`
  - edge-agent logs show: `P2P: received offer ...` then `P2P: received answer ...`
- **Video**
  - `<video>` starts playing
  - If YOLO is disabled, video still plays
- **AI**
  - browser console shows `[AI] rx { type: 'detection_v1', ... }`
  - bounding boxes render on the overlay
- **Reconnect**
  - Disconnect and reconnect from UI without restarting edge-agent (worker session resets on `leave`)

