import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Logger } from '@repo/logger';
import { resolvePython } from './resolvePython';

export type WorkerToNodeMsg =
  | { type: 'worker-ready'; pid: number }
  | { type: 'answer'; sdp: string; sdpType: string }
  | { type: 'iceCandidate'; candidate: any }
  | { type: string; [k: string]: any };

export type NodeToWorkerMsg =
  | { type: 'offer'; sdp: string; sdpType?: string }
  | { type: 'iceCandidate'; candidate: any }
  | { type: 'leave' }
  | { type: 'shutdown' };

export class P2PWorkerProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private onMsgCb: ((m: WorkerToNodeMsg) => void) | null = null;

  constructor(private logger: Logger) {}

  onMessage(cb: (m: WorkerToNodeMsg) => void): void {
    this.onMsgCb = cb;
  }

  isRunning(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  start(env: Record<string, string | undefined>): void {
    if (this.proc) return;

    const python = resolvePython();
    const script = join(__dirname, '..', '..', 'python', 'p2p_webrtc_worker.py');

    this.logger.info({ python, script }, 'P2P: starting python worker');

    const p = spawn(python, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
        PYTHONUNBUFFERED: '1',
      },
    });
    this.proc = p;

    const rl = createInterface({ input: p.stdout });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        this.onMsgCb?.(msg);
      } catch {
        // ignore non-json lines on stdout (shouldn't happen)
      }
    });

    p.stderr.on('data', (buf) => {
      const s = String(buf || '');
      for (const line of s.split('\n')) {
        if (!line.trim()) continue;
        this.logger.warn({ line }, '[py-worker]');
      }
    });

    p.on('exit', (code, sig) => {
      this.logger.warn({ code, sig }, 'P2P: python worker exited');
      this.proc = null;
    });
  }

  send(msg: NodeToWorkerMsg): void {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    } catch (e: any) {
      this.logger.warn({ err: e?.message }, 'P2P: failed to write to worker stdin');
    }
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try {
      this.send({ type: 'shutdown' });
    } catch {
      // ignore
    }
    try {
      p.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

