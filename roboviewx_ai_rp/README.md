# Edge Agent Monorepo

A WebRTC-based edge agent system for Raspberry Pi 4 that streams video to mediasoup SFU servers.

## Project Structure

```
edge-agent-monorepo/
├── apps/
│   └── edge-agent/          # Edge agent application
├── packages/
│   ├── types/               # Shared signaling protocol types
│   └── logger/              # Shared logging utilities
├── package.json
├── turbo.json
└── README.md
```

## Quick Start

### Prerequisites

1. **Node.js 18+**
2. **pnpm** (recommended)
   ```bash
   npm install -g pnpm
   ```
3. **FFmpeg** (for video encoding)
   ```bash
   sudo apt-get install -y ffmpeg
   ```
4. **Build tools**
   ```bash
   sudo apt-get install -y build-essential python3
   ```

### Installation

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Running the Edge Agent

```bash
# Configure environment
cd apps/edge-agent
cp .env.example .env
# Edit .env with your settings

# Run in development mode
pnpm dev

# Or build and run in production mode
pnpm build
pnpm start
```

See `apps/edge-agent/README.md` for detailed documentation.

## Packages

### @repo/types
Shared TypeScript types for the JSON-RPC signaling protocol between edge agent and media server.

### @repo/logger
Shared logging utilities using Pino.

## Development

### Adding New Packages

```bash
mkdir packages/new-package
cd packages/new-package
pnpm init
```

### Building

```bash
# Build all packages
pnpm build

# Build specific package
cd packages/types
pnpm build
```

### Testing

```bash
# Run tests (when implemented)
pnpm test
```

## Architecture

The edge agent connects to a mediasoup SFU server via WebSocket signaling (JSON-RPC 2.0) and establishes a WebRTC connection to stream video. It also exposes a REST API for tilt control.

```
┌─────────────────┐         WebSocket          ┌──────────────────┐
│                 │◄────── (JSON-RPC) ────────►│                  │
│   Edge Agent    │                             │  Media Server    │
│  (Raspberry Pi) │         WebRTC              │   (mediasoup)    │
│                 │◄──────── (RTP) ───────────►│                  │
└─────────────────┘                             └──────────────────┘
        │
        │ HTTP REST
        ▼
   Tilt Control
```

## License

MIT
