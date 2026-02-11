#!/bin/bash
set -e

echo "================================================"
echo "Edge Agent - Raspberry Pi Setup Script"
echo "================================================"
echo ""

# Check if running on Linux ARM64
ARCH=$(uname -m)
if [[ "$ARCH" != "aarch64" ]] && [[ "$ARCH" != "arm64" ]]; then
    echo "⚠️  Warning: This script is designed for ARM64 architecture"
    echo "   Current architecture: $ARCH"
    echo ""
fi

# Check Node.js
echo "Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found"
    echo "   Installing Node.js 18.x..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    NODE_VERSION=$(node --version)
    echo "✓ Node.js found: $NODE_VERSION"
fi

# Check npm
echo "Checking npm..."
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found (should be installed with Node.js)"
    exit 1
else
    NPM_VERSION=$(npm --version)
    echo "✓ npm found: $NPM_VERSION"
fi

# Install pnpm
echo "Checking pnpm..."
if ! command -v pnpm &> /dev/null; then
    echo "Installing pnpm..."
    sudo npm install -g pnpm
else
    PNPM_VERSION=$(pnpm --version)
    echo "✓ pnpm found: $PNPM_VERSION"
fi

# Check FFmpeg
echo "Checking FFmpeg..."
if ! command -v ffmpeg &> /dev/null; then
    echo "Installing FFmpeg..."
    sudo apt-get update
    sudo apt-get install -y ffmpeg
else
    FFMPEG_VERSION=$(ffmpeg -version | head -n1)
    echo "✓ FFmpeg found: $FFMPEG_VERSION"
fi

# Check build tools
echo "Checking build tools..."
if ! command -v gcc &> /dev/null; then
    echo "Installing build tools..."
    sudo apt-get install -y build-essential python3 git
else
    echo "✓ Build tools found"
fi

echo ""
echo "================================================"
echo "Installing dependencies..."
echo "================================================"
echo ""

# Install dependencies
pnpm install

echo ""
echo "================================================"
echo "Building packages..."
echo "================================================"
echo ""

# Build
pnpm build

echo ""
echo "================================================"
echo "✓ Setup complete!"
echo "================================================"
echo ""
echo "Next steps:"
echo "1. Configure environment:"
echo "   cd apps/edge-agent"
echo "   cp .env.example .env"
echo "   # Edit .env with your settings"
echo ""
echo "2. Run the edge agent:"
echo "   cd apps/edge-agent"
echo "   pnpm start"
echo ""
echo "For detailed documentation, see:"
echo "   apps/edge-agent/README.md"
echo ""
