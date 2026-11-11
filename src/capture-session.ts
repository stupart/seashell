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

/** Where a movie came from. Window titles stay in the movie's sidecar. */
export interface CaptureVideoTarget {
  readonly kind: 'window' | 'display';
  readonly app?: string;
  readonly bundleId?: string;
  readonly display?: number;
}

/**
 * One movie of the optional video track. It is listed at its first frame, so a
 * crash still finds it, and again when final. Its first frame sits at
 * firstFrameMs on the session clock: transcript time t is movie time
 * t - firstFrameMs / 1000.
 */
export interface CaptureVideoSegment {
  readonly id: string;
  readonly sequence: number;
  readonly relativePath: string;
  readonly sidecarRelativePath: string;
  readonly firstFrameMs: number;
  readonly durationMs?: number;
  readonly frames?: number;
  readonly bytes?: number;
  readonly codec?: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps: number;
  readonly quality: string;
  readonly target?: CaptureVideoTarget;
  readonly finished: boolean;
  readonly recordedAt: string;
}

/** Paths reserved for the next movie in a capture bundle. */
export interface CaptureVideoSlot {
  readonly id: string;
  readonly sequence: number;
  readonly relativePath: string;
  readonly sidecarRelativePath: string;
  readonly path: string;
  readonly sidecarPath: string;
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
  /** Present once a movie of the call's window or screen has been recorded. */
  readonly video?: { readonly segments: readonly CaptureVideoSegment[] };
}

type CaptureSessionEvent =
  | { readonly type: 'session.started'; readonly at: string; readonly manifest: CaptureSessionManifest }
  | { readonly type: 'chunk.committed'; readonly at: string; readonly chunk: CaptureChunk }
  | { readonly type: 'capture.discontinuity'; readonly at: string; readonly discontinuity: CaptureDiscontinuity }
  | { readonly type: 'video.segment'; readonly at: string; readonly segment: CaptureVideoSegment }
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

/** The library whose capture store holds this manifest; undefined once the capture sits beside its meeting. */
export function captureStoreLibrary(manifestPath: string): string | undefined {
  const store = dirname(dirname(resolve(manifestPath)));
  return captureRoot(dirname(store)) === store ? dirname(store) : undefined;
}

function sessionRoot(libraryDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) throw new Error('Capture session ID is unsafe');
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

function assertVideoSegment(segment: CaptureVideoSegment, root: string): void {
  const count = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
  if (
    !plainRecord(segment) ||
    typeof segment.id !== 'string' || !segment.id ||
    !Number.isSafeInteger(segment.sequence) || segment.sequence < 1 ||
    typeof segment.relativePath !== 'string' || typeof segment.sidecarRelativePath !== 'string' ||
    !Number.isSafeInteger(segment.firstFrameMs) ||
    !count(segment.durationMs) || !count(segment.frames) || !count(segment.bytes) ||
    !Number.isSafeInteger(segment.fps) || segment.fps < 1 || segment.fps > 30 ||
    typeof segment.quality !== 'string' ||
    typeof segment.finished !== 'boolean' ||
    typeof segment.recordedAt !== 'string' ||
    (segment.target !== undefined && segment.target.kind !== 'window' && segment.target.kind !== 'display')
  ) throw new Error('Capture manifest contains an invalid video segment');
  for (const path of [segment.relativePath, segment.sidecarRelativePath]) {
    if (!resolve(root, path).startsWith(`${resolve(root)}/`)) throw new Error('Capture video path escapes its session');
  }
}

/** Replace a movie's earlier listing, or add it. */
function withVideoSegment(manifest: CaptureSessionManifest, segment: CaptureVideoSegment): CaptureSessionManifest {
  const segments = (manifest.video?.segments ?? []).filter((entry) => entry.id !== segment.id);
  return {
    ...manifest,
    video: { segments: [...segments, segment].toSorted((left, right) => left.sequence - right.sequence) },
  };
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
  if (manifest.video !== undefined) {
    if (!plainRecord(manifest.video) || !Array.isArray(manifest.video.segments)) {
      throw new Error('Capture manifest video must list segments');
    }
    for (const segment of manifest.video.segments) assertVideoSegment(segment, root);
  }
  return Object.freeze({
    ...manifest,
    tracks: Object.freeze(manifest.tracks.map((entry) => Object.freeze({ ...entry }))),
    chunks: Object.freeze(manifest.chunks.map((entry) => Object.freeze({ ...entry }))),
    discontinuities: Object.freeze(manifest.discontinuities.map((entry) => Object.freeze({ ...entry }))),
    ...(manifest.video === undefined ? {} : {
      video: Object.freeze({ segments: Object.freeze(manifest.video.segments.map((entry) => Object.freeze({ ...entry }))) }),
    }),
  });
}

/** Load the atomic projection, then replay any journal entries committed after it. */
export function loadCaptureSession(path: string): CaptureSessionManifest {
  const root = dirname(resolve(path));
  const projected = parseCaptureSessionManifest(JSON.parse(readFileSync(path, 'utf8')), root);
  const journalPath = join(root, 'events.jsonl');
  if (!existsSync(journalPath)) return projected;
  let manifest = projected;
  const journal = readFileSync(journalPath, 'utf8');
  // Only newline-terminated records were fully appended. A torn tail must not
  // hide prior committed audio; corruption inside committed records still fails.
  const committed = journal.slice(0, journal.lastIndexOf('\n') + 1);
  const events = committed.split('\n').filter(Boolean)
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
    } else if (event.type === 'video.segment') {
      assertVideoSegment(event.segment, root);
      manifest = { ...withVideoSegment(manifest, event.segment), updatedAt: event.at };
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
      if (existsSync(this.journalPath)) {
        const journal = readFileSync(this.journalPath);
        const committedBytes = journal.lastIndexOf(0x0a) + 1;
        if (committedBytes < journal.length) {
          // Preserve incomplete bytes for inspection before allowing new appends.
          writeFileSync(`${this.journalPath}.partial-${randomUUID()}`, journal.subarray(committedBytes), {
            mode: 0o600, flag: 'wx',
          });
          atomicWrite(this.journalPath, journal.subarray(0, committedBytes).toString('utf8'));
        }
      }
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

  /** Reserve paths for the next movie. Numbers are never reused while files remain. */
  nextVideoSegment(): CaptureVideoSlot {
    const directory = join(this.root, 'video');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const used = readdirSync(directory).flatMap((name) => /^(\d{6})\./u.exec(name)?.[1] ?? []).map(Number);
    const listed = (this.manifestValue.video?.segments ?? []).map((segment) => segment.sequence);
    const sequence = Math.max(0, ...used, ...listed) + 1;
    const name = String(sequence).padStart(6, '0');
    const relativePath = join('video', `${name}.mp4`);
    const sidecarRelativePath = join('video', `${name}.json`);
    return Object.freeze({
      id: `video.${name}`,
      sequence,
      relativePath,
      sidecarRelativePath,
      path: join(this.root, relativePath),
      sidecarPath: join(this.root, sidecarRelativePath),
    });
  }

  /** List a movie (again): at its first frame, then when it is final. */
  recordVideoSegmentAsync(details: Omit<CaptureVideoSegment, 'recordedAt'>): Promise<CaptureVideoSegment> {
    const task = this.commitTail.then(async () => {
      const recordedAt = new Date().toISOString();
      const segment: CaptureVideoSegment = Object.freeze({ ...details, recordedAt });
      assertVideoSegment(segment, this.root);
      await appendDurablyAsync(this.journalPath, { type: 'video.segment', at: recordedAt, segment });
      this.manifestValue = Object.freeze({ ...withVideoSegment(this.manifestValue, segment), updatedAt: recordedAt });
      await atomicWriteAsync(this.manifestPath, `${JSON.stringify(this.manifestValue, null, 2)}\n`);
      return segment;
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
    if (resolve(destination) === resolve(this.root)) {
      this.publishVideo(transcriptDirectory, destination);
      return destination;
    }
    if (existsSync(destination)) throw new Error(`Transcript already has a capture bundle: ${destination}`);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    renameSync(this.root, destination);
    this.publishVideo(transcriptDirectory, destination);
    return destination;
  }

  /** The movies now have their final home: tell the meeting where they are. */
  private publishVideo(transcriptDirectory: string, bundleRoot: string): void {
    const map = captureVideoMap(this.manifestValue, bundleRoot);
    if (!map) return;
    // Best effort: the transcript is saved either way, and meetingVideo()
    // rebuilds this map from the bundle when it is missing.
    try { atomicWrite(join(resolve(transcriptDirectory), MEETING_VIDEO_FILE), `${JSON.stringify(map, null, 2)}\n`); }
    catch {}
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

export const MEETING_VIDEO_FILE = 'video.json';

/** One movie on the transcript's timeline: video time = transcript time + startOffsetSeconds. */
export interface MeetingVideoSegment {
  readonly file: string;
  readonly startOffsetSeconds: number;
  readonly durationSeconds?: number;
}

/**
 * video.json in a meeting folder. `file` and `startOffsetSeconds` describe the
 * first movie, which is usually the only one; `segments` lists every movie in
 * order (a resumed call or a restarted recorder adds one). Other readers rely
 * on this shape: add fields, never rename them.
 */
export interface MeetingVideoMap extends MeetingVideoSegment {
  readonly target?: CaptureVideoTarget;
  readonly segments: readonly MeetingVideoSegment[];
}

export function captureVideoMap(manifest: CaptureSessionManifest, bundleRoot: string): MeetingVideoMap | undefined {
  const root = resolve(bundleRoot);
  const listed = manifest.video?.segments ?? [];
  const segments = listed.flatMap((segment): MeetingVideoSegment[] => {
    const file = resolve(root, segment.relativePath);
    if (!file.startsWith(`${root}/`) || !existsSync(file)) return [];
    return [Object.freeze({
      file,
      // Rounded to the millisecond; `+ 0` keeps -0 out of the JSON.
      startOffsetSeconds: Math.round(-segment.firstFrameMs) / 1_000 + 0,
      ...(segment.durationMs === undefined ? {} : { durationSeconds: segment.durationMs / 1_000 }),
    })];
  });
  const first = segments[0];
  if (!first) return undefined;
  const target = listed.find((segment) => resolve(root, segment.relativePath) === first.file)?.target;
  return Object.freeze({ ...first, ...(target ? { target } : {}), segments: Object.freeze(segments) });
}

export function captureChunkPath(manifestPath: string, chunk: CaptureChunk): string {
  const root = dirname(resolve(manifestPath));
  const path = resolve(root, chunk.relativePath);
  if (!path.startsWith(`${root}/`)) throw new Error('Capture chunk path escapes its session');
  return path;
}

/** Read exactly the bytes attested by the durable chunk journal. */
export function readVerifiedCaptureChunk(manifestPath: string, chunk: CaptureChunk): Buffer {
  const data = readFileSync(captureChunkPath(manifestPath, chunk));
  if (data.length !== chunk.bytes || createHash('sha256').update(data).digest('hex') !== chunk.sha256) {
    throw new Error(`Capture chunk integrity check failed: ${chunk.id}`);
  }
  return data;
}

export function captureManifestPath(libraryDir: string, sessionId: string): string {
  return join(sessionRoot(libraryDir, sessionId), 'manifest.json');
}
