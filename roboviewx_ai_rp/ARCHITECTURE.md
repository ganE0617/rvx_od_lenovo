# Edge Agent Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Raspberry Pi 4                            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Edge Agent Process                       │ │
│  │                                                             │ │
│  │  ┌──────────────┐      ┌──────────────┐                   │ │
│  │  │              │      │              │                   │ │
│  │  │  Supervisor  │──────│  Lifecycle   │                   │ │
│  │  │              │      │   Manager    │                   │ │
│  │  └──────────────┘      └──────────────┘                   │ │
│  │         │                     │                            │ │
│  │         │                     │                            │ │
│  │         ▼                     ▼                            │ │
│  │  ┌──────────────────────────────────────┐                 │ │
│  │  │      Signaling (JSON-RPC/WS)         │                 │ │
│  │  │  ┌────────────┐   ┌───────────────┐  │                 │ │
│  │  │  │ RpcClient  │   │  Signaling    │  │                 │ │
│  │  │  │            │───│   Client      │  │                 │ │
│  │  │  └────────────┘   └───────────────┘  │                 │ │
│  │  └──────────────────────────────────────┘                 │ │
│  │         │                                                  │ │
│  │         │ joinRoom, getRtpCapabilities,                   │ │
│  │         │ createTransport, produce                         │ │
│  │         ▼                                                  │ │
│  │  ┌──────────────────────────────────────┐                 │ │
│  │  │       WebRTC Components               │                 │ │
│  │  │  ┌────────────┐   ┌───────────────┐  │                 │ │
│  │  │  │   Device   │   │ SendTransport │  │                 │ │
│  │  │  │            │───│   Manager     │  │                 │ │
│  │  │  └────────────┘   └───────────────┘  │                 │ │
│  │  │         │                │            │                 │ │
│  │  │         │                ▼            │                 │ │
│  │  │         │         ┌───────────────┐  │                 │ │
│  │  │         │         │   Producer    │  │                 │ │
│  │  │         │         │   Manager     │  │                 │ │
│  │  │         │         └───────────────┘  │                 │ │
│  │  └──────────────────────────────────────┘                 │ │
│  │                       │                                    │ │
│  │                       ▼                                    │ │
│  │  ┌──────────────────────────────────────┐                 │ │
│  │  │        Video Pipeline                 │                 │ │
│  │  │  ┌────────────────────────────────┐  │                 │ │
│  │  │  │  Video Sources                 │  │                 │ │
│  │  │  │  ┌────────────┐ ┌────────────┐ │  │                 │ │
│  │  │  │  │    Test    │ │   File     │ │  │                 │ │
│  │  │  │  │  Pattern   │ │  Source    │ │  │                 │ │
│  │  │  │  └────────────┘ └────────────┘ │  │                 │ │
│  │  │  └────────────────────────────────┘  │                 │ │
│  │  │         │                             │                 │ │
│  │  │         ▼                             │                 │ │
│  │  │  ┌────────────────────────────────┐  │                 │ │
│  │  │  │    FFmpeg Encoder              │  │                 │ │
│  │  │  │    (VP8 / H264)                │  │                 │ │
│  │  │  └────────────────────────────────┘  │                 │ │
│  │  │         │                             │                 │ │
│  │  │         ▼                             │                 │ │
│  │  │  ┌────────────────────────────────┐  │                 │ │
│  │  │  │    wrtc Video Track            │  │                 │ │
│  │  │  │    (RTCVideoSource)            │  │                 │ │
│  │  │  └────────────────────────────────┘  │                 │ │
│  │  └──────────────────────────────────────┘                 │ │
│  │                                                             │ │
│  │  ┌──────────────────────────────────────┐                 │ │
│  │  │        Tilt Control Service           │                 │ │
│  │  │  ┌────────────┐   ┌───────────────┐  │                 │ │
│  │  │  │   Express  │   │     Tilt      │  │                 │ │
│  │  │  │   Server   │───│  Controller   │  │                 │ │
│  │  │  │  (REST)    │   │   (Hardware)  │  │                 │ │
│  │  │  └────────────┘   └───────────────┘  │                 │ │
│  │  └──────────────────────────────────────┘                 │ │
│  └─────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────┘
         │                              │
         │ WebSocket                    │ HTTP REST
         │ (JSON-RPC)                   │ (Tilt Control)
         │                              │
         ▼                              ▼
┌──────────────────┐          ┌──────────────────┐
│  Media Server    │          │  Control Client  │
│  (mediasoup SFU) │          │  (Web/Mobile)    │
└──────────────────┘          └──────────────────┘
         │
         │ WebRTC (RTP)
         ▼
┌──────────────────┐
│   Web Viewers    │
│   (Browsers)     │
└──────────────────┘
```

## Component Details

### Supervisor
- **Purpose**: Orchestrates the entire agent lifecycle
- **Responsibilities**:
  - Connection management
  - Reconnection with exponential backoff
  - Component initialization order
  - Graceful shutdown

### Signaling (JSON-RPC/WS)
- **RpcClient**: Low-level WebSocket client with request/response mapping
- **SignalingClient**: High-level typed methods for protocol
- **Protocol**: JSON-RPC 2.0 over WebSocket
- **Methods**:
  - `joinRoom`: Join as publisher
  - `getRtpCapabilities`: Get router capabilities
  - `createWebRtcTransport`: Create send transport
  - `connectWebRtcTransport`: Connect transport with DTLS params
  - `produce`: Produce video track

### WebRTC Components
- **Device**: mediasoup-client Device wrapper
  - Loads router RTP capabilities
  - Validates codec support
- **SendTransport**: Manages send transport lifecycle
  - Handles `connect` event → signals DTLS parameters
  - Handles `produce` event → signals RTP parameters
- **Producer**: Creates and manages video track
  - Creates video source (test pattern or file)
  - Generates video track using wrtc
  - Produces track via transport

### Video Pipeline
- **Sources**:
  - **TestPattern**: FFmpeg testsrc (color bars)
  - **FileSource**: FFmpeg file playback
  - (Future: USB webcam, Insta360)
- **Encoder**: FFmpeg wrapper
  - VP8: `libvpx` (default, best compatibility)
  - H264: `libx264` (optional)
  - Outputs raw YUV frames
- **Track**: wrtc RTCVideoSource
  - Converts frames to MediaStreamTrack
  - Fed to mediasoup Producer

### Tilt Control
- **Server**: Express REST API
  - GET `/health`: Health check
  - GET `/tilt`: Get current angle
  - POST `/tilt`: Set target angle
- **Controller**: Hardware interface (stubbed)
  - Validates angle range (-90° to +90°)
  - Logs commands (hardware driver TODO)

## Data Flow

### Startup Sequence
1. Load configuration from environment
2. Start tilt REST server
3. Supervisor.start()
4. Connect to signaling server (WebSocket)
5. Send `joinRoom` request
6. Receive room info and peers
7. Send `getRtpCapabilities` request
8. Initialize Device with capabilities
9. Send `createWebRtcTransport` request
10. Create local send transport
11. Transport fires `connect` event
12. Send `connectWebRtcTransport` with DTLS params
13. Start video source (FFmpeg)
14. Create video track (wrtc)
15. Call `transport.produce(track)`
16. Transport fires `produce` event
17. Send `produce` request with RTP params
18. Receive `producerId`
19. ✓ Producing video

### Reconnection Sequence
1. WebSocket closes or connection fails
2. Supervisor detects disconnection
3. Cleanup: close producer, transport, signaling
4. Calculate backoff delay (exponential)
5. Wait for delay
6. Retry connection (go to startup sequence)
7. If max retries reached → exit

### Video Frame Flow
1. FFmpeg generates frames (testsrc or file)
2. Frames output as raw YUV420
3. wrtc VideoSource receives frames
4. VideoSource creates MediaStreamTrack
5. Track fed to mediasoup Producer
6. Producer encodes with VP8/H264
7. RTP packets sent over WebRTC transport
8. Media server receives and routes to subscribers

### Tilt Control Flow
1. Client sends HTTP POST /tilt with angle
2. Express middleware parses JSON
3. Controller validates angle (-90 to +90)
4. Controller.setAngle() called
5. Log command (hardware stub)
6. Return success response
7. (Future: actual hardware driver controls servo/motor)

## State Management

### Connection States
- `disconnected`: Initial state or after close
- `connecting`: WebSocket connecting
- `connected`: WebSocket connected
- `joined`: Room joined
- `producing`: Video track producing
- `reconnecting`: Attempting reconnection
- `failed`: Max retries reached

### Transport States (WebRTC)
- `new`: Just created
- `connecting`: ICE connecting
- `connected`: ICE connected
- `failed`: Connection failed
- `closed`: Transport closed

### Producer States
- `null`: Not created
- `active`: Producing frames
- `paused`: Paused (not used in MVP)
- `closed`: Producer closed

## Error Handling

### Connection Errors
- WebSocket connection fails → Retry with backoff
- WebSocket closes → Trigger reconnection
- Max retries reached → Exit process

### WebRTC Errors
- Transport connection fails → Log error, trigger reconnection
- Producer fails → Log error, cleanup, trigger reconnection
- ICE failure → Log error (TURN may be needed)

### Video Source Errors
- FFmpeg process crashes → Log error, emit event
- FFmpeg fails to start → Throw error, prevent startup
- Frame generation errors → Log error, continue

### API Errors
- Invalid tilt angle → Return 400 Bad Request
- Missing angle field → Return 400 Bad Request
- Internal error → Return 500 Internal Server Error

## Configuration

### Required
- `EDGE_ROOM_ID`: Room to join
- `SIGNALING_URL`: Media server WebSocket URL

### Optional
- `EDGE_PEER_ID`: Peer ID (default: auto-generated)
- `VIDEO_SOURCE`: test|file (default: test)
- `VIDEO_FILE`: Path to video file (if source=file)
- `VIDEO_WIDTH/HEIGHT/FRAMERATE`: Video settings
- `CODEC`: VP8|H264 (default: VP8)
- `TURN_URLS/USERNAME/CREDENTIAL`: TURN server config
- `RECONNECT_*`: Reconnection settings
- `TILT_PORT`: REST API port (default: 8080)
- `LOG_LEVEL`: Logging level (default: info)

## Logging Strategy

All logs include context:
- `roomId`: Current room
- `peerId`: This peer's ID
- `transportId`: Transport ID (when applicable)
- `producerId`: Producer ID (when applicable)

Log levels:
- `trace`: Very detailed (not used in MVP)
- `debug`: Detailed flow (JSON-RPC messages, frames)
- `info`: Normal operations (connection, startup, state changes)
- `warn`: Recoverable issues (reconnection, transport close)
- `error`: Errors (connection failures, invalid config)

## Security Considerations

### Network
- WebSocket: Can use WSS (secure) with `wss://` URL
- WebRTC: DTLS encrypted by default
- REST API: No authentication (add JWT/API key in production)

### Process
- Runs as unprivileged user (e.g., `admin`)
- No root privileges required
- Restart policy in systemd: `on-failure`

### Input Validation
- Tilt angle: Validated range (-90 to +90)
- Config: Validated at startup
- JSON-RPC: Schema validated by protocol

## Performance

### Resource Usage (Typical)
- CPU: 20-40% (one core, encoding VP8 640x480@30fps)
- Memory: ~200-300 MB
- Network: ~1-2 Mbps (depends on bitrate config)

### Optimization Tips
- Lower resolution: Reduce CPU load
- Lower framerate: Reduce CPU and bandwidth
- VP8 vs H264: VP8 is faster on Pi 4
- Hardware encoding: Not implemented (requires V4L2/OMX)

## Future Enhancements

### Short-term
- [ ] USB webcam support (V4L2)
- [ ] Hardware tilt driver (GPIO/I2C)
- [ ] Audio track production
- [ ] Better error recovery (ICE restart)

### Medium-term
- [ ] Insta360 SDK integration
- [ ] Multiple video sources
- [ ] Simulcast support
- [ ] Adaptive bitrate

### Long-term
- [ ] Hardware video encoding (Pi 4 GPU)
- [ ] Multi-room support
- [ ] Peer-to-peer mode
- [ ] Edge AI processing (object detection, etc.)
