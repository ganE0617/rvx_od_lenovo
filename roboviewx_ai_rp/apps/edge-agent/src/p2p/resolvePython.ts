import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Same heuristic as previous aiortcWorker.ts but without importing mediasoup-client-aiortc.
const MONOREPO_VENV_PYTHON = join(__dirname, '..', '..', '..', '..', '.venv', 'bin', 'python');
const APP_VENV_PYTHON = join(__dirname, '..', '..', '.venv', 'bin', 'python');

export function resolvePython(): string {
  if (process.env.PYTHON && process.env.PYTHON.trim()) return process.env.PYTHON.trim();
  if (existsSync(MONOREPO_VENV_PYTHON)) return MONOREPO_VENV_PYTHON;
  if (existsSync(APP_VENV_PYTHON)) return APP_VENV_PYTHON;
  return 'python3';
}

