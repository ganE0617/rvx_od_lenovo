# Run commands (P2P WebRTC)

This repo runs **P2P WebRTC** (no mediasoup).

## 1) Start edge-agent (signaling + python aiortc worker)

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

## 2) Start web viewer (web-vanilla)

```bash
VITE_SIGNALING_URL="ws://127.0.0.1:8082/ws" \
VITE_DEFAULT_ROOM_ID="robot-001" \
npm -C roboviewx_ai/apps/web-vanilla run dev
```

Open the UI and click **Connect**.

## TURN example

```bash
ICE_SERVERS_JSON='[
  {"urls":["stun:stun.l.google.com:19302"]},
  {"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"USER","credential":"PASS"}
]'
```

## Notes
- The browser must create the `ai` DataChannel **before** `createOffer()` so the SDP includes `m=application`.
- AI is best-effort: inference may drop frames; video should remain smooth.

