# Local development: same-host mode

Run the **media-server** (signaling + mediasoup SFU) and the **edge-agent** (producer) on the **same machine**. The viewer (web app) can also run on that machine. No STUN/TURN required for local dev.

## Repos

- **roboviewx_ai** – media-server (signaling + SFU), web viewers (web-roboviewx, web-vanilla)
- **roboviewx_ai_rp** – edge-agent (robot / producer)

## Environment variables

### Same-host mode (default for local dev)

| Where | Variable | Same-host value | Notes |
|-------|----------|-----------------|--------|
| **Edge-agent** | `SIGNALING_URL` | `http://127.0.0.1:3001` | Default if unset. Use `http://` for Socket.IO. |
| **Media-server** | `MEDIASOUP_ANNOUNCED_IP` | *(unset or empty)* | Server uses `127.0.0.1` for ICE so local producer + viewer work without TURN. |
| **Media-server** | `PORT` | `3001` | HTTP + Socket.IO listen port. |
| **Viewer (web)** | `VITE_SIGNALING_URL` | `http://localhost:3001` | Same-host: point to local media-server. |

### Remote mode (edge on another machine)

| Where | Variable | Example | Notes |
|-------|----------|---------|--------|
| **Edge-agent** | `SIGNALING_URL` | `http://<server-ip>:3001` | IP/host of the machine running media-server. |
| **Media-server** | `MEDIASOUP_ANNOUNCED_IP` | `<public-or-lan-ip>` | So viewers (and producer) can reach WebRTC. |
| **Viewer** | `VITE_SIGNALING_URL` | `http://<server-ip>:3001` | Same as media-server host. |

### Optional (both modes)

| Where | Variable | Default | Notes |
|-------|----------|---------|--------|
| Media-server | `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | Bind address for RTC. |
| Media-server | `MEDIASOUP_MIN_PORT` / `MEDIASOUP_MAX_PORT` | `40000` / `49999` | RTC port range (env names used by this project). |
| Edge-agent | `EDGE_ROOM_ID` | `robot-001` | Must match room used by viewer. |
| Edge-agent | `EDGE_VIDEO_SOURCE` | e.g. `v4l2:/dev/video0?size=1280x720&fps=30&format=mjpeg` | Video source for producer. |

---

## Prerequisites

- **Node 18+** (e.g. `node -v`).
- **pnpm** – the repos use pnpm workspaces. If `pnpm` is not installed:
  - **Option A (recommended):** enable via Corepack (uses version from repo):
    ```bash
    corepack enable
    corepack prepare pnpm@9.0.0 --activate
    ```
  - **Option B:** install globally: `npm install -g pnpm`
- If you prefer **npm**, use the app subdirectories and run scripts there (see npm fallbacks below).

---

## Commands (same-host local dev)

From each repo root (or app directory when using npm).

### 1) Start media-server (roboviewx_ai)

```bash
cd roboviewx_ai
pnpm install
# Same-host: leave MEDIASOUP_ANNOUNCED_IP unset
pnpm --filter media-server dev
# Or: pnpm -C apps/media-server run dev
```

**npm fallback:** `cd roboviewx_ai && npm install && cd apps/media-server && npm run dev`

Server listens on **0.0.0.0:3001**. Logs will show `listenIp`, `announcedIp` (127.0.0.1 in same-host), and RTC port range.

### 2) Start edge-agent (roboviewx_ai_rp)

```bash
cd roboviewx_ai_rp
pnpm install
# Same-host: SIGNALING_URL defaults to http://127.0.0.1:3001
EDGE_VIDEO_SOURCE="v4l2:/dev/video0?size=1280x720&fps=30&format=mjpeg" \
  pnpm -C apps/edge-agent run dev
```

Or with a testsrc (no camera):

```bash
EDGE_VIDEO_SOURCE=testsrc pnpm -C apps/edge-agent run dev
```

**npm fallback:** from repo root run `npm install`, then `cd apps/edge-agent && EDGE_VIDEO_SOURCE=testsrc npm run dev` (or set EDGE_VIDEO_SOURCE as above).

Startup log will show **Signaling URL (final)**.

### 3) Start viewer (optional, same machine)

**React app (web-roboviewx):**

```bash
cd roboviewx_ai
# Same-host: VITE_SIGNALING_URL defaults to ws://localhost:3001 in code; or set:
# VITE_SIGNALING_URL=http://localhost:3001 VITE_DEFAULT_ROOM_ID=robot-001
pnpm --filter web-roboviewx dev
```

Open the URL shown (e.g. `http://localhost:5173`), connect to room `robot-001`.

**Vanilla app (web-vanilla):**

```bash
cd roboviewx_ai
VITE_SIGNALING_URL=http://localhost:3001 pnpm --filter web-vanilla dev
```

**npm fallback (viewer):** `cd roboviewx_ai/apps/web-roboviewx && npm install && npm run dev` (or `apps/web-vanilla` for vanilla).

---

## Switching modes via env only

- **Same-host**: do **not** set `MEDIASOUP_ANNOUNCED_IP` (or set empty). Do **not** set `SIGNALING_URL` in edge-agent (defaults to `http://127.0.0.1:3001`).
- **Remote edge**: set `SIGNALING_URL=http://<media-server-ip>:3001` in edge-agent. Set `MEDIASOUP_ANNOUNCED_IP=<ip>` on media-server if viewers are outside the LAN.

---

## Verification

1. **Media-server**: logs show `listenIp: 0.0.0.0`, `announcedIp: 127.0.0.1` (same-host), RTC port range.
2. **Edge-agent**: logs show `Signaling URL (final): http://127.0.0.1:3001`, then Socket connected → joinRoom → transport → producer created.
3. **Viewer**: connect to same room; video should play (host candidates only, no STUN/TURN).

---

## Branch

These instructions apply to the **same-host-dev** branch in both repos. Merge to main when ready.
