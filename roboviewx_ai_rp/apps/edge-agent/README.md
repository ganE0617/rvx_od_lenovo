# Edge Agent

<!-- Run with camera: EDGE_VIDEO_SOURCE=v4l2:/dev/video0 pnpm run dev -->
<!-- With size/fps: EDGE_VIDEO_SOURCE=v4l2:/dev/video2?size=1280x720&fps=30 pnpm run dev -->

WebRTC-based edge agent for Raspberry Pi 4 that streams video to a mediasoup SFU server and provides tilt control.

## Architecture

The edge agent:
- Connects to a mediasoup SFU server via WebSocket (JSON-RPC signaling)
- Joins a room as a `publisher` role
- Creates a WebRTC send transport
- Produces a video track (test pattern or file source)
- Provides HTTP REST API for tilt control
- Handles reconnection with exponential backoff

## Prerequisites

### Hardware
- Raspberry Pi 4 (ARM64)
- Internet connection
- (Optional) USB webcam
- (Optional) Insta360 camera (future)

### Software

1. **Node.js 18+**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   node --version  # Should be v18.x or higher
   ```

2. **FFmpeg**
   ```bash
   sudo apt-get update
   sudo apt-get install -y ffmpeg
   ffmpeg -version  # Verify installation
   ```

3. **Build tools** (required for native modules)
   ```bash
   sudo apt-get install -y build-essential python3 git
   ```

4. **pnpm** (recommended for monorepo)
   ```bash
   npm install -g pnpm
   ```

## Installation

From the monorepo root:

```bash
# Install all dependencies
pnpm install

# Build shared packages
pnpm build

# Or build just the edge-agent
cd apps/edge-agent
pnpm build
```

## Configuration

Create a `.env` file in `apps/edge-agent/` (or set environment variables):

```bash
# Room & Peer Identity
EDGE_ROOM_ID=robot-001
EDGE_PEER_ID=edge-pi-001

# Signaling Server
SIGNALING_URL=ws://192.168.1.100:3000

# Video Source (default: v4l2 camera)
EDGE_VIDEO_SOURCE=v4l2:/dev/video0   # Default. Or: v4l2:/dev/video0?size=1280x720&fps=30&format=mjpeg, testsrc, file
VIDEO_SOURCE=test                    # Used when EDGE_VIDEO_SOURCE=file or testsrc
VIDEO_FILE=/path/to/video.mp4  # Required if VIDEO_SOURCE=file
VIDEO_WIDTH=640
VIDEO_HEIGHT=480
VIDEO_FRAMERATE=30

# Codec
CODEC=VP8                      # Options: VP8, H264 (VP8 recommended)

# TURN/STUN (optional)
TURN_URLS=turn:turn.example.com:3478
TURN_USERNAME=username
TURN_CREDENTIAL=password

# Reconnection
RECONNECT_ENABLED=true
RECONNECT_MAX_RETRIES=10
RECONNECT_BASE_DELAY_MS=1000
RECONNECT_MAX_DELAY_MS=30000

# Tilt REST API
TILT_PORT=8080

# Logging
LOG_LEVEL=info                 # Options: trace, debug, info, warn, error
```

## Running

### Development Mode

**From monorepo root (recommended; use single directory):**  
Python venv can live at monorepo root so you don’t need to `cd` into `apps/edge-agent`. Create it once with `bash apps/edge-agent/scripts/install-aiortc.sh --monorepo`, or move an existing one: `mv apps/edge-agent/.venv .venv`. Then from the repo root:

```bash
# From ~/edge-agent-monorepo (or your repo root)
EDGE_VIDEO_SOURCE="v4l2:/dev/video0?size=1280x720&fps=30&format=mjpeg" pnpm -C apps/edge-agent run dev
```

## Snapshot feed (for AI inference, no second camera open)

The aiortc worker process (which owns the camera via `MediaPlayer(..., format='v4l2')`) exposes:

- `GET http://127.0.0.1:8082/snapshot.jpg`

Configure (optional env vars when starting the edge-agent):

- `AIORTC_SNAPSHOT_PORT` (default `8082`, set `0` to disable)
- `AIORTC_SNAPSHOT_FPS` (default `5`, recommended `2-5` for stability)
- `AIORTC_SNAPSHOT_W` / `AIORTC_SNAPSHOT_H` (optional fixed encode size)
- `AIORTC_SNAPSHOT_QUALITY` (default `80`)

## Edge AI (YOLO) over WebRTC DataChannel (main path)

The edge-agent can run person detection **on the same raw frames used for WebRTC video** and send `detection_v1` JSON to viewers over a mediasoup **DataChannel** (label `ai`).

Enable with env vars:

- `AI_ENABLE=1`
- `AI_MODEL_PATH=/path/to/yolo11n.pt`
- `AI_FPS=10` (inference rate)
- `AI_SEND_HZ=12` (send rate over DataChannel)
- `AI_CONF=0.2`
- `AI_IOU=0.45`
- `AI_INPUT_W=640` / `AI_INPUT_H=360` (downscale for inference)

Python deps (same venv used by aiortc worker):

```bash
bash apps/edge-agent/scripts/install-aiortc.sh --monorepo
/home/spacebank/roboviewx_ai_rp/.venv/bin/pip install ultralytics
```

Run example:

```bash
AI_ENABLE=1 \
AI_MODEL_PATH="/home/spacebank/roboviewx_ai/apps/ai-inference/yolo11n.pt" \
AI_FPS=10 AI_SEND_HZ=12 AI_CONF=0.2 AI_INPUT_W=640 AI_INPUT_H=360 \
EDGE_ROOM_ID=robot-001 \
SIGNALING_URL="http://127.0.0.1:3001" \
EDGE_VIDEO_SOURCE="v4l2:/dev/video0?size=640x360&fps=30&format=mjpeg" \
npm run dev
```

Quick checks:

```bash
ss -ltnp | grep 8082
curl http://127.0.0.1:8082/snapshot/ping
curl http://127.0.0.1:8082/snapshot/status
curl -I http://127.0.0.1:8082/snapshot.jpg
curl http://127.0.0.1:8082/snapshot.jpg --output /tmp/snap.jpg
curl "http://127.0.0.1:8082/snapshot.jpg?w=640&h=360" --output /tmp/snap_640.jpg  # non-blocking: may 503 until next encode tick
file /tmp/snap.jpg /tmp/snap_640.jpg
```

**From apps/edge-agent:**
```bash
cd apps/edge-agent
pnpm dev
```

**Camera (V4L2) examples:**
```bash
EDGE_VIDEO_SOURCE=v4l2:/dev/video0 pnpm -C apps/edge-agent run dev
EDGE_VIDEO_SOURCE="v4l2:/dev/video0?size=1280x720&fps=30&format=mjpeg" pnpm -C apps/edge-agent run dev
```

### Production Mode
```bash
cd apps/edge-agent
pnpm build
pnpm start
```

### Run as systemd service (optional)

Create `/etc/systemd/system/edge-agent.service`:

```ini
[Unit]
Description=Edge Agent
After=network.target

[Service]
Type=simple
User=admin
WorkingDirectory=/home/admin/edge-agent-monorepo/apps/edge-agent
Environment="NODE_ENV=production"
EnvironmentFile=/home/admin/edge-agent-monorepo/apps/edge-agent/.env
ExecStart=/usr/bin/node /home/admin/edge-agent-monorepo/apps/edge-agent/dist/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable edge-agent
sudo systemctl start edge-agent
sudo systemctl status edge-agent
```

## Tilt Control API

The edge agent exposes a REST API for tilt control on port 8080 (configurable via `TILT_PORT`).

### Endpoints

**GET /tilt** - Get current tilt angle
```bash
curl http://localhost:8080/tilt
```
Response:
```json
{
  "angle": 0,
  "min": -90,
  "max": 90
}
```

**POST /tilt** - Set tilt angle
```bash
curl -X POST http://localhost:8080/tilt \
  -H "Content-Type: application/json" \
  -d '{"angle": 45}'
```
Response:
```json
{
  "success": true,
  "angle": 45
}
```

**GET /health** - Health check
```bash
curl http://localhost:8080/health
```
Response:
```json
{
  "status": "ok"
}
```

## End-to-End Testing

### 1. Start the media server
```bash
cd apps/media-server
pnpm start
```

### 2. Start the edge agent
```bash
cd apps/edge-agent
pnpm start
```

You should see logs indicating:
```
✓ Tilt REST API listening on port 8080
Connecting to signaling server
WebSocket connected
Joined room
Device initialized
Send transport created
Video producer created
✓ Edge agent connected and producing video
```

### 3. Open a web viewer
Open a browser and navigate to your media server's viewer URL (typically `http://localhost:3000` or similar).

### 4. Verify video is visible
You should see the test pattern (color bars) streaming from the edge agent.

### 5. Test tilt control
```bash
# Get current angle
curl http://localhost:8080/tilt

# Set angle to 45 degrees
curl -X POST http://localhost:8080/tilt \
  -H "Content-Type: application/json" \
  -d '{"angle": 45}'

# Set angle to -30 degrees
curl -X POST http://localhost:8080/tilt \
  -H "Content-Type: application/json" \
  -d '{"angle": -30}'
```

## Troubleshooting

### Video Source Issues

**Test pattern not working:**
```bash
# Verify FFmpeg can generate test pattern
ffmpeg -f lavfi -i testsrc=size=640x480:rate=30 -t 5 -f null -

# Check logs for FFmpeg errors
LOG_LEVEL=debug pnpm start
```

**File source not working:**
```bash
# Verify file exists and is readable
ls -la /path/to/video.mp4

# Test with FFmpeg directly
ffmpeg -i /path/to/video.mp4 -f null -
```

### Connection Issues

**WebSocket connection fails:**
- Verify `SIGNALING_URL` is correct
- Check media server is running and accessible
- Check firewall rules: `sudo ufw status`
- Test connectivity: `curl -v ws://192.168.1.100:3000`

**announcedIp mismatch:**
- Ensure media server's `announcedIp` matches the actual IP
- On Raspberry Pi, find your IP: `hostname -I`
- Update media server configuration if needed

**UDP ports blocked:**
- Check if UDP ports 10000-59999 are open (mediasoup default range)
- Test with: `sudo netstat -tulpn | grep LISTEN`
- Configure TURN server if behind restrictive NAT/firewall

### Codec Issues

**Codec negotiation fails:**
- Use VP8 (best browser compatibility): `CODEC=VP8`
- Check device capabilities in logs: "Device initialized" message shows `canProduce`
- Verify browser supports VP8 (all modern browsers do)

**H264 not working:**
- Install `libx264`: `sudo apt-get install libx264-dev`
- Some browsers require specific H264 profiles
- VP8 is recommended for maximum compatibility

### Protocol Mismatch

**JSON-RPC errors:**
- Check that media server and edge agent use the same protocol version
- Inspect logs for request/response mismatches
- Verify `packages/types` is up to date in both server and agent

### Performance Issues

**High CPU usage:**
- Lower video resolution: `VIDEO_WIDTH=320 VIDEO_HEIGHT=240`
- Lower framerate: `VIDEO_FRAMERATE=15`
- Use hardware encoding if available (requires additional setup)

**Choppy video:**
- Check network bandwidth: `iperf3 -c <server-ip>`
- Monitor CPU: `top` or `htop`
- Check for packet loss in logs

### Debugging Tips

1. **Enable verbose logging:**
   ```bash
   LOG_LEVEL=debug pnpm start
   ```

2. **Check WebSocket messages:**
   Look for JSON-RPC request/response logs showing method names and parameters.

3. **Verify mediasoup state:**
   Logs will show transport and producer states (connecting, connected, failed, closed).

4. **Test network connectivity:**
   ```bash
   # Ping media server
   ping <server-ip>
   
   # Test WebSocket
   wscat -c ws://<server-ip>:<port>
   ```

5. **Check process status:**
   ```bash
   # If running as systemd service
   sudo journalctl -u edge-agent -f
   ```

## Development Notes

### Adding a New Video Source

Video sources are implemented in `src/media/aiortcVideoSource.ts` (v4l2, file, testsrc). To add a new kind: extend `EDGE_VIDEO_SOURCE` parsing in `config.ts`, add a getter in aiortcVideoSource, and branch in `producer.ts` `getVideoTrack()`.

### Modifying Signaling Protocol

1. Update types in `packages/types/src/index.ts`
2. Rebuild types: `cd packages/types && pnpm build`
3. Update `src/signaling/messages.ts` to add new methods
4. Ensure media server implements the same protocol

### Testing Reconnection

```bash
# While edge agent is running, stop the media server
# Edge agent should retry with exponential backoff
# Restart media server - edge agent should reconnect automatically
```

## Project Structure

```
apps/edge-agent/
├── src/
│   ├── index.ts              # Main entry point
│   ├── config.ts             # Configuration and env parsing
│   ├── logger.ts             # Logger wrapper
│   ├── signaling/
│   │   ├── rpcClient.ts      # JSON-RPC WebSocket client
│   │   └── messages.ts       # Typed signaling methods
│   ├── media/
│   │   └── aiortcVideoSource.ts   # Video track (v4l2, file, testsrc)
│   ├── rtc/
│   │   ├── aiortcWorker.ts   # Python aiortc worker
│   │   ├── device.ts        # mediasoup Device wrapper
│   │   ├── producer.ts      # Video producer
│   │   └── sendTransport.ts # Send transport manager
│   ├── tilt/
│   │   ├── server.ts         # HTTP REST server
│   │   └── controller.ts     # Tilt state and hardware stub
│   ├── lifecycle/
│   │   ├── supervisor.ts     # Lifecycle manager with reconnection
│   │   └── cleanup.ts        # Resource cleanup
│   └── utils/
│       └── backoff.ts        # Exponential backoff helper
├── package.json
├── tsconfig.json
└── README.md
```

## Known Limitations (MVP)

1. **Video source:** Supports v4l2 camera, file (MP4), and testsrc. Insta360 support can be added later.

2. **Hardware tilt control:** Stubbed - logs commands but doesn't control actual hardware. Integrate your servo/motor driver here.

3. **Audio:** Not implemented in MVP. Video only.

4. **Multiple streams:** Produces only one video track. Multi-stream support can be added.

5. **ICE restart:** Not implemented. Connection issues require full reconnect.

## Next Steps

- [ ] Add USB webcam support (use V4L2 or GStreamer)
- [ ] Add Insta360 SDK integration
- [ ] Implement hardware tilt driver (GPIO control)
- [ ] Add audio track production
- [ ] Implement ICE restart on connection issues
- [ ] Add metrics/telemetry (CPU, memory, bandwidth)
- [ ] Create web-based control panel
- [ ] Add E2E tests

## License

MIT
