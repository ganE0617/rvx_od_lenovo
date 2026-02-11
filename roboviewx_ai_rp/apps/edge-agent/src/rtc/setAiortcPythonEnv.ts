/**
 * Set process.env.PYTHON before any code loads mediasoup-client-aiortc.
 * Worker.js reads PYTHON at module load time, so it must be set at import time.
 * Import this module first in index.ts (before Supervisor / device / aiortcWorker).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// From src/rtc: monorepo root = ../../../../, app root = ../..
const MONOREPO_VENV_PYTHON = join(__dirname, '..', '..', '..', '..', '.venv', 'bin', 'python');
const APP_VENV_PYTHON = join(__dirname, '..', '..', '.venv', 'bin', 'python');
const EDGE_AGENT_PYTHON_DIR = join(__dirname, '..', '..', 'python');
// Optional: if the "vision app" exists in sibling repo, allow importing it too.
const EDGE_AGENT_VISION_DIR = '/home/spacebank/roboviewx_ai/apps/edge-agent-vision';

if (!process.env.PYTHON) {
  if (existsSync(MONOREPO_VENV_PYTHON)) {
    process.env.PYTHON = MONOREPO_VENV_PYTHON;
  } else if (existsSync(APP_VENV_PYTHON)) {
    process.env.PYTHON = APP_VENV_PYTHON;
  }
}

// Ensure the aiortc worker can import edge-local Python modules (snapshot store).
// Worker.js prepends its pip_deps dir to PYTHONPATH but keeps existing PYTHONPATH too.
if (existsSync(EDGE_AGENT_PYTHON_DIR)) {
  const existing = process.env.PYTHONPATH || '';
  if (!existing.split(':').includes(EDGE_AGENT_PYTHON_DIR)) {
    process.env.PYTHONPATH = existing ? `${EDGE_AGENT_PYTHON_DIR}:${existing}` : EDGE_AGENT_PYTHON_DIR;
  }
}

if (existsSync(EDGE_AGENT_VISION_DIR)) {
  const existing = process.env.PYTHONPATH || '';
  if (!existing.split(':').includes(EDGE_AGENT_VISION_DIR)) {
    process.env.PYTHONPATH = existing ? `${EDGE_AGENT_VISION_DIR}:${existing}` : EDGE_AGENT_VISION_DIR;
  }
}
