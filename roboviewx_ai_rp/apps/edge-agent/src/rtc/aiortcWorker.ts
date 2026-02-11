/**
 * Aiortc Worker singleton for mediasoup-client Device and media tracks.
 * Single Python subprocess shared by Device (handlerFactory) and getUserMedia.
 * Always uses venv Python when available so aiortc is importable.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorker, Worker } from 'mediasoup-client-aiortc';
import { Logger } from '@repo/logger';

const WORKER_CREATE_TIMEOUT_MS = 20000;
const WORKER_CLOSE_TIMEOUT_MS = 5000;

// Venv locations: monorepo root (run from ~/edge-agent-monorepo) or edge-agent app dir
const MONOREPO_VENV_PYTHON = join(__dirname, '..', '..', '..', '..', '.venv', 'bin', 'python');
const APP_VENV_PYTHON = join(__dirname, '..', '..', '.venv', 'bin', 'python');

let workerInstance: Worker | null = null;
let workerLog: Logger | null = null;
let resolvedPythonPath: string | null = null;

/**
 * Resolve Python executable for aiortc worker: PYTHON env, or default venv if exists, else python3.
 * Sets process.env.PYTHON so mediasoup-client-aiortc uses it when spawning the worker.
 */
export function resolveAiortcPython(): string {
  if (resolvedPythonPath) {
    return resolvedPythonPath;
  }
  if (process.env.PYTHON) {
    resolvedPythonPath = process.env.PYTHON;
    return resolvedPythonPath;
  }
  if (existsSync(MONOREPO_VENV_PYTHON)) {
    resolvedPythonPath = MONOREPO_VENV_PYTHON;
    process.env.PYTHON = resolvedPythonPath;
    return resolvedPythonPath;
  }
  if (existsSync(APP_VENV_PYTHON)) {
    resolvedPythonPath = APP_VENV_PYTHON;
    process.env.PYTHON = resolvedPythonPath;
    return resolvedPythonPath;
  }
  resolvedPythonPath = 'python3';
  return resolvedPythonPath;
}

/**
 * Ensure PYTHON env is set and log the resolved path. Call at startup so logs show which Python is used.
 */
export function ensureAiortcPythonEnv(logger: Logger): string {
  const python = resolveAiortcPython();
  if (!process.env.PYTHON) {
    process.env.PYTHON = python;
  }
  logger.info({ aiortcPython: python }, 'Aiortc worker will use this Python');
  return python;
}

/**
 * Preflight: verify the resolved Python can import aiortc. Throws with clear message if not.
 */
function preflightAiortc(logger: Logger): void {
  const python = resolveAiortcPython();
  try {
    const out = execFileSync(python, ['-c', 'import aiortc; print(aiortc.__version__)'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const version = (out && out.trim()) || '?';
    logger.info({ aiortcPython: python, aiortcVersion: version }, 'Aiortc preflight OK');
  } catch (e) {
    const msg =
      'aiortc is not importable with the chosen Python. ' +
      'Run: bash apps/edge-agent/scripts/install-aiortc.sh';
    logger.error({ aiortcPython: python, error: e }, msg);
    throw new Error(msg);
  }
}

/**
 * Get or create the Aiortc Worker. Must be used for both Device handlerFactory
 * and for getUserMedia so all resources come from the same Worker.
 * Fails with a clear error (and stops supervisor retry) if worker creation
 * times out or Python/aiortc is missing.
 */
export async function getAiortcWorker(logger: Logger): Promise<Worker> {
  if (workerInstance) {
    if (workerInstance.closed || workerInstance.died) {
      workerInstance = null;
    } else {
      return workerInstance;
    }
  }

  ensureAiortcPythonEnv(logger);
  preflightAiortc(logger);

  logger.info('Creating Aiortc Worker');

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          `Aiortc Worker creation timed out after ${WORKER_CREATE_TIMEOUT_MS / 1000}s. ` +
            'Check [aiortc stdout] / [aiortc stderr] above for Python output. ' +
            'If you see AIORTC_WORKER_BOOT but not AIORTC_WORKER_READY, the worker is stuck before signaling ready. ' +
            'Run: bash apps/edge-agent/scripts/install-aiortc.sh'
        )
      );
    }, WORKER_CREATE_TIMEOUT_MS);
  });

  try {
    workerLog = logger;
    const logLevel = (process.env.AIORTC_LOG_LEVEL as any) || 'warn';
    workerInstance = await Promise.race([
      createWorker({ logLevel }),
      timeoutPromise,
    ]);
  } catch (error: unknown) {
    workerInstance = null;
    workerLog = null;
    const err = error as Error;
    const errAny = err as Error & { cause?: unknown };
    logger.error(
      {
        error: {
          message: errAny.message,
          stack: errAny.stack,
          ...(errAny.cause !== undefined ? { cause: errAny.cause } : {}),
        },
      },
      'Aiortc Worker creation failed'
    );
    throw new Error(
      'Aiortc Worker failed: ' +
        (err.message || String(error)) +
        '. Install aiortc: bash apps/edge-agent/scripts/install-aiortc.sh'
    );
  }

  logger.info({ pid: workerInstance.pid }, 'Aiortc Worker created');
  return workerInstance;
}

/**
 * Close the Aiortc Worker and wait for subprocess to fully exit.
 * Call this on supervisor cleanup to avoid leaking the Python process.
 */
export async function closeAiortcWorker(logger: Logger): Promise<void> {
  if (!workerInstance) {
    return;
  }

  const w = workerInstance;
  workerInstance = null;
  workerLog = null;

  if (w.closed) {
    return;
  }

  logger.info('Closing Aiortc Worker');
  const closePromise = new Promise<void>((resolve) => {
    const onClose = (): void => {
      w.off('subprocessclose', onClose);
      resolve();
    };
    w.once('subprocessclose', onClose);
    w.close();
  });
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      logger.warn(
        { timeoutMs: WORKER_CLOSE_TIMEOUT_MS },
        'Aiortc Worker close timed out, exiting anyway'
      );
      resolve();
    }, WORKER_CLOSE_TIMEOUT_MS);
  });
  await Promise.race([closePromise, timeoutPromise]);
  logger.info('Aiortc Worker closed');
}
