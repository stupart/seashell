import { spawn, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { createServer } from 'net';
import {
  beginManagedProcessSession,
  trackChildProcess,
} from './process-lifecycle.ts';

export interface LocalAsrProfile {
  readonly id: string;
  readonly modelPath: string;
  readonly threads: number;
  readonly requestTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly disableGpu?: boolean;
}

export interface LiveAsrJob {
  readonly id: string;
  readonly audioFile: string;
  readonly start: number;
  readonly end: number;
  readonly speaker: 'LOCAL' | 'SYSTEM';
  readonly sessionGeneration: number;
}

export type LiveAsrResult =
  | { readonly status: 'completed'; readonly text: string; readonly latencyMs: number }
  | { readonly status: 'superseded' | 'cancelled'; readonly text: ''; readonly latencyMs: 0 };

interface PendingJob {
  readonly job: LiveAsrJob;
  readonly resolve: (result: LiveAsrResult) => void;
  readonly reject: (error: Error) => void;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function terminateOwnedChild(
  child: ChildProcess | undefined,
  graceMs = 1_500,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([closed, delay(graceMs)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([closed, delay(500)]);
  }
}

interface WhisperServerResponse {
  readonly text: string;
}

function parseServerResponse(value: unknown): WhisperServerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Local Whisper server returned a non-object response');
  }
  const text = (value as Record<string, unknown>).text;
  if (typeof text !== 'string') throw new Error('Local Whisper server response has no text');
  return { text: text.replace(/\s+/gu, ' ').trim() };
}

/** One private loopback server. Sea Shell never adopts or terminates foreign daemons. */
export class OwnedWhisperServer {
  private child: ChildProcess | undefined;
  private endpoint: string | undefined;
  private starting: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private activeRequests = 0;
  private stopTrackingChild: (() => void) | undefined;
  private endManagedSession: (() => void) | undefined;
  private forceCpu = false;

  constructor(
    private readonly serverPath: string,
    private readonly profile: LocalAsrProfile,
  ) {}

  async transcribe(audioFile: string, signal?: AbortSignal): Promise<string> {
    await this.ensureStarted();
    const servingChild = this.child;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.activeRequests += 1;
    try {
      const form = new FormData();
      form.set('file', new Blob([await readFile(audioFile)], { type: 'audio/wav' }), 'chunk.wav');
      form.set('language', 'en');
      form.set('response_format', 'verbose_json');
      form.set('temperature', '0.0');
      const timeout = AbortSignal.timeout(this.profile.requestTimeoutMs);
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      const response = await fetch(`${this.endpoint}/inference`, {
        method: 'POST',
        body: form,
        signal: combined,
      });
      if (!response.ok) throw new Error(`Local Whisper server failed (${response.status})`);
      return parseServerResponse(await response.json()).text;
    } catch (error) {
      await delay(25);
      const crashed = servingChild !== undefined && (
        servingChild.signalCode !== null || servingChild.exitCode === 139
      );
      if (!signal?.aborted && !this.profile.disableGpu && !this.forceCpu && crashed) {
        this.forceCpu = true;
        await this.stop();
        return await this.transcribe(audioFile, signal);
      }
      throw error;
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (this.activeRequests === 0) this.deferIdleShutdown();
    }
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const child = this.child;
    const stopTrackingChild = this.stopTrackingChild;
    const endManagedSession = this.endManagedSession;
    this.child = undefined;
    this.endpoint = undefined;
    this.starting = undefined;
    this.stopTrackingChild = undefined;
    this.endManagedSession = undefined;
    await terminateOwnedChild(child);
    stopTrackingChild?.();
    endManagedSession?.();
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.endpoint && this.child.exitCode === null && this.child.signalCode === null) return;
    if (this.starting) return await this.starting;
    this.starting = this.startFresh();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async startFresh(): Promise<void> {
    await this.stop();
    const port = await reserveLoopbackPort();
    const child = spawn(this.serverPath, [
      ...(this.profile.disableGpu || this.forceCpu ? ['-ng'] : []),
      '-m', this.profile.modelPath,
      '-t', String(this.profile.threads),
      '--host', '127.0.0.1',
      '--port', String(port),
      '-nlp',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endManagedSession = beginManagedProcessSession();
    const stopTrackingChild = trackChildProcess(child);
    this.child = child;
    this.endpoint = `http://127.0.0.1:${port}`;
    this.endManagedSession = endManagedSession;
    this.stopTrackingChild = stopTrackingChild;
    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2_000); });
    child.once('close', () => {
      if (this.child === child) {
        this.child = undefined;
        this.endpoint = undefined;
        this.stopTrackingChild = undefined;
        this.endManagedSession = undefined;
        stopTrackingChild();
        endManagedSession();
      }
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Local Whisper server exited during startup: ${stderr.trim() || child.exitCode}`);
      }
      try {
        const response = await fetch(`${this.endpoint}/`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch {}
      await delay(100);
    }
    await this.stop();
    throw new Error('Timed out starting the private local Whisper server');
  }

  private deferIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.stop(); }, this.profile.idleTimeoutMs);
    this.idleTimer.unref();
  }
}

export interface LiveAsrSchedulerOptions {
  readonly maxPending?: number;
  readonly maxConcurrent?: number;
  readonly transcribe: (audioFile: string, signal: AbortSignal) => Promise<string>;
  readonly onDepth?: (depth: number) => void;
}

/**
 * A single inference lane with bounded draft work. At saturation it supersedes
 * the oldest same-track draft; committed capture audio is never deleted.
 */
export class LiveAsrScheduler {
  private readonly maxPending: number;
  private readonly maxConcurrent: number;
  private readonly pending: PendingJob[] = [];
  private readonly active = new Map<PendingJob, AbortController>();
  private stopping = false;

  constructor(private readonly options: LiveAsrSchedulerOptions) {
    this.maxPending = options.maxPending ?? 4;
    this.maxConcurrent = options.maxConcurrent ?? 1;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) {
      throw new Error('Local ASR maxPending must be a positive integer');
    }
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
      throw new Error('ASR maxConcurrent must be a positive integer');
    }
  }

  get depth(): number { return this.pending.length + this.active.size; }

  enqueue(job: LiveAsrJob): Promise<LiveAsrResult> {
    if (this.stopping) return Promise.resolve({ status: 'cancelled', text: '', latencyMs: 0 });
    return new Promise((resolve, reject) => {
      if (this.pending.length >= this.maxPending) {
        const replaceIndex = this.pending.findIndex((entry) => entry.job.speaker === job.speaker);
        const index = replaceIndex >= 0 ? replaceIndex : 0;
        const [superseded] = this.pending.splice(index, 1);
        superseded?.resolve({ status: 'superseded', text: '', latencyMs: 0 });
      }
      this.pending.push({ job, resolve, reject });
      this.pending.sort((left, right) =>
        left.job.end - right.job.end ||
        (left.job.speaker === right.job.speaker ? 0 : left.job.speaker === 'LOCAL' ? -1 : 1));
      this.changed();
      void this.pump();
    });
  }

  cancelGeneration(generation: number): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const entry = this.pending[index];
      if (entry?.job.sessionGeneration !== generation) continue;
      this.pending.splice(index, 1);
      entry.resolve({ status: 'cancelled', text: '', latencyMs: 0 });
    }
    for (const [entry, controller] of this.active) {
      if (entry.job.sessionGeneration !== generation) continue;
      entry.resolve({ status: 'cancelled', text: '', latencyMs: 0 });
      controller.abort();
    }
    this.changed();
  }

  async drain(): Promise<void> {
    while (this.depth > 0) await delay(25);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const entry of this.pending.splice(0)) {
      entry.resolve({ status: 'cancelled', text: '', latencyMs: 0 });
    }
    for (const [entry, controller] of this.active) {
      entry.resolve({ status: 'cancelled', text: '', latencyMs: 0 });
      controller.abort();
    }
    await Promise.race([this.drain(), delay(2_000)]);
    this.changed();
  }

  private async pump(): Promise<void> {
    if (this.stopping) return;
    while (this.active.size < this.maxConcurrent) {
      const entry = this.pending.shift();
      if (!entry) break;
      void this.run(entry);
    }
    this.changed();
  }

  private async run(entry: PendingJob): Promise<void> {
    const controller = new AbortController();
    this.active.set(entry, controller);
    this.changed();
    const started = Date.now();
    try {
      const text = await this.options.transcribe(entry.job.audioFile, controller.signal);
      entry.resolve({ status: 'completed', text, latencyMs: Date.now() - started });
    } catch (error) {
      if (controller.signal.aborted) {
        entry.resolve({ status: 'cancelled', text: '', latencyMs: 0 });
      } else {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.active.delete(entry);
      this.changed();
      void this.pump();
    }
  }

  private changed(): void { this.options.onDepth?.(this.depth); }
}
