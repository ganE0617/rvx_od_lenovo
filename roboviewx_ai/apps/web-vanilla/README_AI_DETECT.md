# AI Overlay (edge inference over WebRTC DataChannel)

This vanilla viewer renders **person detection overlays** on top of the existing WebRTC `<video>` stream.

Inference runs on the **edge-agent** (the producer that already owns the camera raw frames). The browser receives **metadata only** via a **mediasoup DataChannel** (SCTP DataProducer/DataConsumer), which keeps latency low and naturally synced with the video transport.

## How it works

- Edge-agent produces video to mediasoup SFU (unchanged)
- Edge-agent also creates a **DataProducer** with label `ai`
- The edge aiortc worker taps outgoing **raw `av.VideoFrame`** objects, runs Ultralytics YOLO person detection, and sends `detection_v1` JSON over the `ai` data channel
- Viewer consumes the **DataConsumer** and draws boxes on a canvas overlay

## Run (npm)

1) Start media-server:

```bash
cd apps/media-server
npm install
npm run dev
```

2) Start vanilla UI:

```bash
cd apps/web-vanilla
npm install
npm run dev
```

3) Start edge-agent with AI enabled (on the edge device / same machine):

```bash
AI_ENABLE=1 \
AI_MODEL_PATH="/path/to/yolo11n.pt" \
AI_FPS=10 \
AI_SEND_HZ=12 \
AI_CONF=0.2 \
AI_INPUT_W=640 AI_INPUT_H=360 \
EDGE_ROOM_ID=robot-001 \
SIGNALING_URL="http://127.0.0.1:3001" \
EDGE_VIDEO_SOURCE="v4l2:/dev/video0?size=640x360&fps=30&format=mjpeg" \
npm -C /home/spacebank/roboviewx_ai_rp/apps/edge-agent run dev
```

Verification:

- In browser devtools console: you should see `[Viewer] DataConsumer created: ... ai`
- The AI HUD should show: `AI: rx <fps> dets=<n> age=<ms>`

## Use in UI

- Connect so the stream is **PLAYING**
- Toggle **AI Overlay: ON**
- You should see green `person 0.xx` boxes

## Debug-only: snapshot endpoint

The edge-agent also exposes a snapshot endpoint for debugging (not required for main path):

```bash
curl http://127.0.0.1:8082/snapshot/status
curl http://127.0.0.1:8082/snapshot.jpg --output /tmp/snap.jpg
file /tmp/snap.jpg
```

