#!/usr/bin/env bash
# Install Python aiortc and system deps required by mediasoup-client-aiortc.
# Uses a venv to avoid PEP 668 "externally-managed-environment" on Ubuntu/Debian.
# Run once on the device (e.g. Raspberry Pi) before starting the edge-agent.
#
# Usage:
#   bash apps/edge-agent/scripts/install-aiortc.sh           # venv at apps/edge-agent/.venv
#   bash apps/edge-agent/scripts/install-aiortc.sh --monorepo # venv at monorepo root .venv (run from repo root)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDGE_AGENT_DIR="$(dirname "$SCRIPT_DIR")"
MONOREPO_ROOT="$(cd "${EDGE_AGENT_DIR}/../.." && pwd)"

if [[ "${1:-}" == "--monorepo" ]]; then
  VENV_DIR="${MONOREPO_ROOT}/.venv"
  echo "Using monorepo root venv: ${VENV_DIR}"
else
  VENV_DIR="${EDGE_AGENT_DIR}/.venv"
fi

echo "=== Installing aiortc and system dependencies ==="

sudo apt-get update
sudo apt-get install -y \
  python3 \
  python3-dev \
  python3-venv \
  build-essential \
  pkg-config \
  libffi-dev \
  libssl-dev \
  libopus-dev \
  libvpx-dev

# ffmpeg optional here; edge-agent also uses it for test video. Install if missing:
if ! command -v ffmpeg &>/dev/null; then
  echo "Installing ffmpeg..."
  sudo apt-get install -y ffmpeg
fi

echo "=== Creating Python venv at ${VENV_DIR} ==="
if [[ ! -d "${VENV_DIR}" ]]; then
  python3 -m venv "${VENV_DIR}"
fi

echo "=== Upgrading pip, setuptools, wheel in venv ==="
"${VENV_DIR}/bin/pip" install --upgrade pip setuptools wheel

echo "=== Installing aiortc in venv ==="
"${VENV_DIR}/bin/pip" install aiortc

echo "=== Installing snapshot dependencies (numpy, OpenCV) ==="
# Used by /snapshot.jpg JPEG encoding in the aiortc worker.
# Prefer headless variant for servers/edge devices.
"${VENV_DIR}/bin/pip" install numpy opencv-python-headless

echo "=== Verifying aiortc ==="
"${VENV_DIR}/bin/python" -c "import aiortc; print('aiortc version:', aiortc.__version__)"

echo "=== Verifying snapshot deps ==="
"${VENV_DIR}/bin/python" -c "import numpy as np; import cv2; print('numpy:', np.__version__, 'cv2:', cv2.__version__)"

echo "=== Done ==="
if [[ "${VENV_DIR}" == "${MONOREPO_ROOT}/.venv" ]]; then
  echo "Run from monorepo root (no need to activate; app will find this Python):"
  echo "  cd $(dirname "${MONOREPO_ROOT}")/$(basename "${MONOREPO_ROOT}")"
  echo "  EDGE_VIDEO_SOURCE=\"v4l2:/dev/video0\" pnpm -C apps/edge-agent run dev"
  echo "To move an existing app venv to monorepo root: mv apps/edge-agent/.venv .venv"
else
  echo "Run the edge-agent with this Python (aiortc is in the venv):"
  echo "  export PYTHON=${VENV_DIR}/bin/python"
  echo "  cd apps/edge-agent && pnpm run build && pnpm start"
  echo "Or add to apps/edge-agent/.env: PYTHON=${VENV_DIR}/bin/python"
fi
