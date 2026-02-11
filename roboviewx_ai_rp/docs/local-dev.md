# Edge-agent: same-host local dev

Run the edge-agent on the **same machine** as the media-server (roboviewx_ai).

## Signaling URL

- **Same-host**: default is `http://127.0.0.1:3001`. Do not set `SIGNALING_URL` or set:
  ```bash
  export SIGNALING_URL=http://127.0.0.1:3001
  ```
- **Remote**: set to the media-server host:
  ```bash
  export SIGNALING_URL=http://<server-ip>:3001
  ```

Use `http://` (not `ws://`) for Socket.IO.

## Run (same-host)

1. Start **media-server** in repo **roboviewx_ai** (see that repo’s `docs/local-dev.md`).
2. From this repo:

```bash
# With camera
EDGE_VIDEO_SOURCE="v4l2:/dev/video0?size=1280x720&fps=30&format=mjpeg" \
  pnpm -C apps/edge-agent run dev
```

```bash
# Test pattern (no camera)
EDGE_VIDEO_SOURCE=testsrc pnpm -C apps/edge-agent run dev
```

Startup log prints **Signaling URL (final)**. No other code changes needed; switch between same-host and remote with env only.

## Env reference

| Variable | Default (same-host) | Description |
|----------|---------------------|-------------|
| `SIGNALING_URL` | `http://127.0.0.1:3001` | Media-server Socket.IO URL. |
| `EDGE_ROOM_ID` | `robot-001` | Room to join. |
| `EDGE_VIDEO_SOURCE` | `v4l2:/dev/video0` or `testsrc` | Video source. |

See `apps/edge-agent/.env.example` for more options.
