import { createHash, randomUUID } from 'crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';

export const CAPTURE_SESSION_SCHEMA_VERSION = '0.1' as const;

export type CaptureTrackId = 'microphone' | 'system-audio';
export type CaptureSessionStatus = 'recording' | 'paused' | 'captured' | 'completed' | 'interrupted';

export interface CaptureTrack {
  readonly id: CaptureTrackId;
  readonly kind: CaptureTrackId;
  readonly label: string;
  readonly sampleRate: 16_000;
  readonly channels: 1;
  readonly encoding: 'pcm-s16le-wav';
}

export interface CaptureChunk {
  readonly id: string;
  readonly trackId: CaptureTrackId;
  readonly sequence: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly audible: boolean;
  readonly clock?: CaptureClockEvidence;
  readonly committedAt: string;
}

export interface CaptureClockEvidence {
  readonly kind: 'device-sample-clock' | 'process-start-estimate';
  readonly originUnixMs: number;
  readonly sampleRate: 16_000;
  readonly uncertaintyMs: number;
  readonly hostTime?: string;
  readonly sampleTime?: number;
}

export interface CaptureDiscontinuity {
  readonly id: string;
  readonly trackId: CaptureTrackId;
  readonly atMs: number;
  readonly durationMs: number;
  readonly reason: 'capture-overrun' | 'device-reset' | 'clock-reset';
  readonly recordedAt: string;
}

export interface CaptureSessionManifest {
  readonly schemaVersion: '0.1';
  readonly sessionId: string;
  readonly status: CaptureSessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAtUnixMs: number;
  readonly endedAtUnixMs?: number;
  readonly clock: {
    readonly kind: 'live-session';
    readonly unit: 'milliseconds';
    readonly originUnixMs: number;
  };
  readonly provider: {
    readonly integrationId: 'product.seashell';
    readonly capability: 'capture.seashell.macos.live';
    readonly boundary: 'local';
  };
  readonly tracks: readonly CaptureTrack[];
  readonly chunks: readonly CaptureChunk[];
  readonly discontinuities: readonly CaptureDiscontinuity[];
}

type CaptureSessionEvent =
  | { readonly type: 'session.started'; readonly at: string; readonly manifest: CaptureSessionManifest }
  | { readonly type: 'chunk.committed'; readonly at: string; readonly chunk: CaptureChunk }
  | { readonly type: 'capture.discontinuity'; readonly at: string; readonly discontinuity: CaptureDiscontinuity }
  | {
      readonly type: 'session.status';
      readonly at: string;
      readonly status: CaptureSessionStatus;
      readonly endedAtUnixMs?: number;
      readonly reason?: string;
    };

export interface CommittedCaptureChunk extends CaptureChunk {
  readonly path: string;
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const descriptor = openSync(temporary, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function appendDurably(path: string, event: CaptureSessionEvent): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, 'a', 0o600);
  try {
    appendFileSync(descriptor, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function sha256Async(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function atomicWriteAsync(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const descriptor = await open(temporary, 'r');
    try { await descriptor.sync(); } finally { await descriptor.close(); }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function appendDurablyAsync(path: string, event: CaptureSessionEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = await open(path, 'a', 0o600);
  try {
    await appendFile(descriptor, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

function captureRoot(libraryDir: string): string {
  return join(resolve(libraryDir), '_Capture');
}

function sessionRoot(libraryDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error('Capture session ID is unsafe');
  return join(captureRoot(libraryDir), sessionId);
}

function track(trackId: CaptureTrackId): CaptureTrack {
  return Object.freeze({
    id: trackId,
    kind: trackId,
    label: trackId === 'microphone' ? 'Microphone' : 'System audio',
    sampleRate: 16_000,
    channels: 1,
    encoding: 'pcm-s16le-wav',
  });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseEvent(line: string, path: string): CaptureSessionEvent {
  let value: unknown;
  try { value = JSON.parse(line); } catch (error) {
    throw new Error(`${path} contains malformed capture journal JSON`, { cause: error });
  }
  if (!plainRecord(value) || typeof value.type !== 'string' || typeof value.at !== 'string') {
    throw new Error(`${path} contains an invalid capture event`);
  }
  return value as unknown as CaptureSessionEvent;
}

function assertChunk(chunk: CaptureChunk, root: string): void {
  if (
    !chunk.id ||
    (chunk.trackId !== 'microphone' && chunk.trackId !== 'system-audio') ||
    !Number.isSafeInteger(chunk.sequence) || chunk.sequence < 1 ||
    !Number.isSafeInteger(chunk.startMs) || chunk.startMs < 0 ||
    !Number.isSafeInteger(chunk.endMs) || chunk.endMs < chunk.startMs ||
    !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 44 ||
    !/^[a-f0-9]{64}$/.test(chunk.sha256) ||
    typeof chunk.audible !== 'boolean' ||
    typeof chunk.committedAt !== 'string'
  ) throw new Error('Capture manifest contains an invalid chunk');
  if (chunk.clock !== undefined && (
    (chunk.clock.kind !== 'device-sample-clock' && chunk.clock.kind !== 'process-start-estimate') ||
    !Number.isSafeInteger(chunk.clock.originUnixMs) ||
    chunk.clock.sampleRate !== 16_000 ||
    !Number.isFinite(chunk.clock.uncertaintyMs) || chunk.clock.uncertaintyMs < 0
  )) throw new Error('Capture manifest contains invalid chunk clock evidence');
  const absolute = resolve(root, chunk.relativePath);
  if (!absolute.startsWith(`${resolve(root)}/`)) {
    throw new Error('Capture chunk path escapes its session');
  }
}

export function parseCaptureSessionManifest(value: unknown, root: string): CaptureSessionManifest {
  if (!plainRecord(value) || value.schemaVersion !== CAPTURE_SESSION_SCHEMA_VERSION) {
    throw new Error('Capture session manifest schemaVersion must be 0.1');
  }
  const rawManifest = value as unknown as CaptureSessionManifest;
  const manifest: CaptureSessionManifest = rawManifest.discontinuities === undefined
    ? { ...rawManifest, discontinuities: [] }
    : rawManifest;
  if (
    typeof manifest.sessionId !== 'string' ||
    !['recording', 'paused', 'captured', 'completed', 'interrupted'].includes(manifest.status) ||
    typeof manifest.createdAt !== 'string' ||
    typeof manifest.updatedAt !== 'string' ||
    !Number.isSafeInteger(manifest.startedAtUnixMs) ||
    manifest.clock?.kind !== 'live-session' ||
    manifest.clock.unit !== 'milliseconds' ||
    manifest.clock.originUnixMs !== manifest.startedAtUnixMs ||
    manifest.provider?.integrationId !== 'product.seashell' ||
    manifest.provider.capability !== 'capture.seashell.macos.live' ||
    manifest.provider.boundary !== 'local' ||
    !Array.isArray(manifest.tracks) ||
    !Array.isArray(manifest.chunks) ||
    !Array.isArray(manifest.discontinuities)
  ) throw new Error('Capture session manifest is invalid');
  for (const chunk of manifest.chunks) assertChunk(chunk, root);
  for (const discontinuity of manifest.discontinuities) {
    if (
      !discontinuity.id ||
      (discontinuity.trackId !== 'microphone' && discontinuity.trackId !== 'system-audio') ||
      !Number.isSafeInteger(discontinuity.atMs) || discontinuity.atMs < 0 ||
      !Number.isSafeInteger(discontinuity.durationMs) || discontinuity.durationMs < 1 ||
      !['capture-overrun', 'device-reset', 'clock-reset'].includes(discontinuity.reason) ||
      typeof discontinuity.recordedAt !== 'string'
    ) throw new Error('Capture manifest contains an invalid discontinuity');
  }
  const ids = manifest.chunks.map((chunk) => chunk.id);
  if (new Set(ids).size !== ids.length) throw new Error('Capture manifest has duplicate chunk IDs');
  return Object.freeze({
    ...manifest,
    tracks: Object.freeze(manifest.tracks.map((entry) => Object.freeze({ ...entry }))),
    chunks: Object.freeze(manifest.chunks.map((entry) => Object.freeze({ ...entry }))),
    discontinuities: Object.freeze(manifest.discontinuities.map((entry) => Object.freeze({ ...entry }))),
  });
}

/** Load the atomic projection, then replay any journal entries committed after it. */
export function loadCaptureSession(path: string): CaptureSessionManifest {
  const root = dirname(resolve(path));
  const projected = parseCaptureSessionManifest(JSON.parse(readFileSync(path, 'utf8')), root);
  const journalPath = join(root, 'events.jsonl');
  if (!existsSync(journalPath)) return projected;
  let manifest = projected;
  const events = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => parseEvent(line, journalPath));
  for (const event of events) {
    if (event.type === 'chunk.committed' && !manifest.chunks.some((chunk) => chunk.id === event.chunk.id)) {
      assertChunk(event.chunk, root);
      manifest = { ...manifest, updatedAt: event.at, chunks: [...manifest.chunks, event.chunk] };
    } else if (event.type === 'capture.discontinuity' &&
        !manifest.discontinuities.some((entry) => entry.id === event.discontinuity.id)) {
      manifest = {
        ...manifest,
        updatedAt: event.at,
        discontinuities: [...manifest.discontinuities, event.discontinuity],
      };
    } else if (event.type === 'session.status') {
      manifest = {
        ...manifest,
        status: event.status,
        updatedAt: event.at,
        ...(event.endedAtUnixMs === undefined ? {} : { endedAtUnixMs: event.endedAtUnixMs }),
      };
    }
  }
  return parseCaptureSessionManifest(manifest, root);
}

export function listRecoverableCaptureSessions(libraryDir: string): CaptureSessionManifest[] {
  const root = captureRoot(libraryDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const path = join(root, entry.name, 'manifest.json');
    if (!existsSync(path)) return [];
    try {
      const manifest = loadCaptureSession(path);
      return manifest.status === 'completed' ? [] : [manifest];
    } catch {
      return [];
    }
  }).toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export class CaptureSessionStore {
  readonly root: string;
  readonly manifestPath: string;
  readonly journalPath: string;
  private manifestValue: CaptureSessionManifest;
  private commitTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly libraryDir: string;
    readonly sessionId: string;
    readonly startedAtUnixMs: number;
    readonly createdAt?: string;
  }) {
    this.root = sessionRoot(options.libraryDir, options.sessionId);
    this.manifestPath = join(this.root, 'manifest.json');
    this.journalPath = join(this.root, 'events.jsonl');
    if (existsSync(this.manifestPath)) {
      this.manifestValue = loadCaptureSession(this.manifestPath);
      return;
    }
    mkdirSync(join(this.root, 'tracks', 'microphone'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, 'tracks', 'system-audio'), { recursive: true, mode: 0o700 });
    const createdAt = options.createdAt ?? new Date().toISOString();
    this.manifestValue = Object.freeze({
      schemaVersion: CAPTURE_SESSION_SCHEMA_VERSION,
      sessionId: options.sessionId,
      status: 'recording',
      createdAt,
      updatedAt: createdAt,
      startedAtUnixMs: options.startedAtUnixMs,
      clock: Object.freeze({
        kind: 'live-session',
        unit: 'milliseconds',
        originUnixMs: options.startedAtUnixMs,
      }),
      provider: Object.freeze({
        integrationId: 'product.seashell',
        capability: 'capture.seashell.macos.live',
        boundary: 'local',
      }),
      tracks: Object.freeze([track('microphone'), track('system-audio')]),
      chunks: Object.freeze([]),
      discontinuities: Object.freeze([]),
    });
    atomicWrite(this.manifestPath, `${JSON.stringify(this.manifestValue, null, 2)}\n`);
    appendDurably(this.journalPath, {
      type: 'session.started',
      at: createdAt,
      manifest: this.manifestValue,
    });
  }

  get manifest(): CaptureSessionManifest {
    return this.manifestValue;
  }

  commitChunk(options: {
    readonly sourcePath: string;
    readonly trackId: CaptureTrackId;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly audible: boolean;
    readonly clock?: CaptureClockEvidence;
  }): CommittedCaptureChunk {
    if (!existsSync(options.sourcePath)) throw new Error(`Capture chunk is missing: ${options.sourcePath}`);
    if (!Number.isFinite(options.startSeconds) || options.startSeconds < 0 ||
        !Number.isFinite(options.endSeconds) || options.endSeconds < options.startSeconds) {
      throw new Error('Capture chunk has invalid timing');
    }
    const sequence = this.manifestValue.chunks.filter(
      (chunk) => chunk.trackId === options.trackId,
    ).length + 1;
    const relativePath = join('tracks', options.trackId, `${String(sequence).padStart(6, '0')}.wav`);
    const destination = join(this.root, relativePath);
    const temporary = `${destination}.partial`;
    copyFileSync(options.sourcePath, temporary);
    chmodSync(temporary, 0o600);
    const descriptor = openSync(temporary, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, destination);
    try { unlinkSync(options.sourcePath); } catch {}
    const committedAt = new Date().toISOString();
    const chunk = Object.freeze({
      id: `${options.trackId}.${String(sequence).padStart(6, '0')}`,
      trackId: options.trackId,
      sequence,
      startMs: Math.max(0, Math.round(options.startSeconds * 1_000)),
      endMs: Math.max(0, Math.round(options.endSeconds * 1_000)),
      relativePath,
      bytes: statSync(destination).size,
      sha256: sha256(destination),
      audible: options.audible,
      ...(options.clock === undefined ? {} : { clock: Object.freeze({ ...options.clock }) }),
      committedAt,
    });
    appendDurably(this.journalPath, { type: 'chunk.committed', at: committedAt, chunk });
    this.manifestValue = Object.freeze({
      ...this.manifestValue,
      status: 'recording',
      updatedAt: committedAt,
      chunks: Object.freeze([...this.manifestValue.chunks, chunk]),
    });
    this.project();
    return Object.freeze({ ...chunk, path: destination });
  }

  /**
   * Serialize durable commits while keeping copy/hash/fsync work off the UI turn.
   * The journal is still synced before the atomic manifest projection is replaced.
   */
  commitChunkAsync(options: {
    readonly sourcePath: string;
    readonly trackId: CaptureTrackId;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly audible: boolean;
    readonly clock?: CaptureClockEvidence;
  }): Promise<CommittedCaptureChunk> {
    const task = this.commitTail.then(async () => {
      if (!Number.isFinite(options.startSeconds) || options.startSeconds < 0 ||
          !Number.isFinite(options.endSeconds) || options.endSeconds < options.startSeconds) {
        throw new Error('Capture chunk has invalid timing');
      }
      const sequence = this.manifestValue.chunks.filter(
        (chunk) => chunk.trackId === options.trackId,
      ).length + 1;
      const relativePath = join('tracks', options.trackId, `${String(sequence).padStart(6, '0')}.wav`);
      const destination = join(this.root, relativePath);
      const temporary = `${destination}.partial`;
      try {
        await copyFile(options.sourcePath, temporary);
        await chmod(temporary, 0o600);
        const descriptor = await open(temporary, 'r');
        try { await descriptor.sync(); } finally { await descriptor.close(); }
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      await unlink(options.sourcePath).catch(() => {});
      const committedAt = new Date().toISOString();
      const details = await stat(destination);
      const chunk = Object.freeze({
        id: `${options.trackId}.${String(sequence).padStart(6, '0')}`,
        trackId: options.trackId,
        sequence,
        startMs: Math.max(0, Math.round(options.startSeconds * 1_000)),
        endMs: Math.max(0, Math.round(options.endSeconds * 1_000)),
        relativePath,
        bytes: details.size,
        sha256: await sha256Async(destination),
        audible: options.audible,
        ...(options.clock === undefined ? {} : { clock: Object.freeze({ ...options.clock }) }),
        committedAt,
      });
      await appendDurablyAsync(this.journalPath, { type: 'chunk.committed', at: committedAt, chunk });
      this.manifestValue = Object.freeze({
        ...this.manifestValue,
        status: 'recording',
        updatedAt: committedAt,
        chunks: Object.freeze([...this.manifestValue.chunks, chunk]),
      });
      await atomicWriteAsync(this.manifestPath, `${JSON.stringify(this.manifestValue, null, 2)}\n`);
      return Object.freeze({ ...chunk, path: destination });
    });
    this.commitTail = task.then(() => {}, () => {});
    return task;
  }

  async drainCommits(): Promise<void> {
    await this.commitTail;
  }

  recordDiscontinuity(options: {
    readonly trackId: CaptureTrackId;
    readonly atSeconds: number;
    readonly durationSeconds: number;
    readonly reason: CaptureDiscontinuity['reason'];
  }): CaptureDiscontinuity {
    if (!Number.isFinite(options.atSeconds) || options.atSeconds < 0 ||
        !Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) {
      throw new Error('Capture discontinuity has invalid timing');
    }
    const recordedAt = new Date().toISOString();
    const discontinuity = Object.freeze({
      id: `${options.trackId}.gap.${String(this.manifestValue.discontinuities.length + 1).padStart(6, '0')}`,
      trackId: options.trackId,
      atMs: Math.round(options.atSeconds * 1_000),
      durationMs: Math.max(1, Math.round(options.durationSeconds * 1_000)),
      reason: options.reason,
      recordedAt,
    });
    appendDurably(this.journalPath, {
      type: 'capture.discontinuity',
      at: recordedAt,
      discontinuity,
    });
    this.manifestValue = Object.freeze({
      ...this.manifestValue,
      updatedAt: recordedAt,
      discontinuities: Object.freeze([...this.manifestValue.discontinuities, discontinuity]),
    });
    this.project();
    return discontinuity;
  }

  recordDiscontinuityAsync(options: {
    readonly trackId: CaptureTrackId;
    readonly atSeconds: number;
    readonly durationSeconds: number;
    readonly reason: CaptureDiscontinuity['reason'];
  }): Promise<CaptureDiscontinuity> {
    const task = this.commitTail.then(async () => {
      if (!Number.isFinite(options.atSeconds) || options.atSeconds < 0 ||
          !Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) {
        throw new Error('Capture discontinuity has invalid timing');
      }
      const recordedAt = new Date().toISOString();
      const discontinuity = Object.freeze({
        id: `${options.trackId}.gap.${String(this.manifestValue.discontinuities.length + 1).padStart(6, '0')}`,
        trackId: options.trackId,
        atMs: Math.round(options.atSeconds * 1_000),
        durationMs: Math.max(1, Math.round(options.durationSeconds * 1_000)),
        reason: options.reason,
        recordedAt,
      });
      await appendDurablyAsync(this.journalPath, {
        type: 'capture.discontinuity',
        at: recordedAt,
        discontinuity,
      });
      this.manifestValue = Object.freeze({
        ...this.manifestValue,
        updatedAt: recordedAt,
        discontinuities: Object.freeze([...this.manifestValue.discontinuities, discontinuity]),
      });
      await atomicWriteAsync(this.manifestPath, `${JSON.stringify(this.manifestValue, null, 2)}\n`);
      return discontinuity;
    });
    this.commitTail = task.then(() => {}, () => {});
    return task;
  }

  setStatus(status: CaptureSessionStatus, reason?: string): CaptureSessionManifest {
    const at = new Date().toISOString();
    const endedAtUnixMs = status === 'captured' || status === 'completed' || status === 'interrupted'
      ? Date.now()
      : undefined;
    appendDurably(this.journalPath, {
      type: 'session.status',
      at,
      status,
      ...(endedAtUnixMs === undefined ? {} : { endedAtUnixMs }),
      ...(reason ? { reason } : {}),
    });
    this.manifestValue = Object.freeze({
      ...this.manifestValue,
      status,
      updatedAt: at,
      ...(endedAtUnixMs === undefined ? {} : { endedAtUnixMs }),
    });
    this.project();
    return this.manifestValue;
  }

  attachTo(transcriptDirectory: string): string {
    const destination = join(resolve(transcriptDirectory), 'capture');
    if (resolve(destination) === resolve(this.root)) return destination;
    if (existsSync(destination)) throw new Error(`Transcript already has a capture bundle: ${destination}`);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    renameSync(this.root, destination);
    return destination;
  }

  /** Remove only this exact completed capture bundle (used by the signal test). */
  discardCompleted(): void {
    if (this.manifestValue.status !== 'completed') {
      throw new Error('Only a completed capture session can be discarded');
    }
    const expectedParent = captureRoot(dirname(dirname(this.root)));
    if (dirname(this.root) !== expectedParent) throw new Error('Capture session root is unsafe');
    rmSync(this.root, { recursive: true, force: true });
  }

  private project(): void {
    atomicWrite(this.manifestPath, `${JSON.stringify(this.manifestValue, null, 2)}\n`);
  }
}

export function captureChunkPath(manifestPath: string, chunk: CaptureChunk): string {
  const root = dirname(resolve(manifestPath));
  const path = resolve(root, chunk.relativePath);
  if (!path.startsWith(`${root}/`)) throw new Error('Capture chunk path escapes its session');
  return path;
}

export function captureManifestPath(libraryDir: string, sessionId: string): string {
  return join(sessionRoot(libraryDir, sessionId), 'manifest.json');
}
