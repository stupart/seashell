import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PcmSignalLevel, SystemAudioStateUpdate } from './live-system-audio.ts';

export type CaptureHealthSource = 'microphone' | 'systemAudio';
export type CaptureHealthState = 'starting' | 'receiving' | 'quiet' | 'reconnecting' | 'unavailable' | 'stopped' | 'disabled';
export type CaptureHealthWarningKind = 'quiet' | 'reconnecting' | 'unavailable' | 'no-audio';
export interface CaptureHealthWarning {
  readonly kind: CaptureHealthWarningKind;
  readonly message: string;
  readonly code?: string;
  readonly firstAtUnixMs: number;
  readonly lastAtUnixMs: number;
  readonly resolvedAtUnixMs?: number;
}
export interface CaptureSourceHealth {
  readonly state: CaptureHealthState;
  readonly updatedAtUnixMs: number;
  /** PCM arrived. This does not establish audibility or successful recognition. */
  readonly lastPcmAtUnixMs?: number;
  /** Nonquiet signal observed; not a speech/identity verification. */
  readonly lastSignalAtUnixMs?: number;
  readonly code?: string;
  readonly message?: string;
  /** At most one entry per kind, retained through recovery and finalization. */
  readonly warnings: readonly CaptureHealthWarning[];
}
export interface CaptureHealthSnapshot {
  readonly schemaVersion: 1;
  readonly updatedAtUnixMs: number;
  readonly microphone: CaptureSourceHealth;
  readonly systemAudio: CaptureSourceHealth;
}

const sources = ['microphone', 'systemAudio'] as const;
const states: readonly CaptureHealthState[] = ['starting', 'receiving', 'quiet', 'reconnecting', 'unavailable', 'stopped', 'disabled'];
const kinds: readonly CaptureHealthWarningKind[] = ['quiet', 'reconnecting', 'unavailable', 'no-audio'];
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const clean = (text: string | undefined, limit = 600): string | undefined => text?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, limit) || undefined;
const label = (source: CaptureHealthSource) => source === 'microphone' ? 'Microphone' : 'Computer audio';

/** Bounded in-memory projection. Silence is a caution, never a permission verdict. */
export class CaptureHealthTracker {
  #value: CaptureHealthSnapshot;
  readonly #startedAt: number;
  readonly #quietAfterMs: number;
  constructor(options: { microphone?: boolean; systemAudio?: boolean; nowUnixMs?: number; quietAfterMs?: number } = {}) {
    this.#startedAt = options.nowUnixMs ?? Date.now();
    this.#quietAfterMs = options.quietAfterMs ?? 30_000;
    const initial = (enabled?: boolean): CaptureSourceHealth => ({ state: enabled === false ? 'disabled' : 'starting', updatedAtUnixMs: this.#startedAt, warnings: [] });
    this.#value = { schemaVersion: 1, updatedAtUnixMs: this.#startedAt, microphone: initial(options.microphone), systemAudio: initial(options.systemAudio) };
  }
  get snapshot(): CaptureHealthSnapshot { return this.#value; }
  private set(source: CaptureHealthSource, value: CaptureSourceHealth, now: number): CaptureHealthSnapshot {
    const { code, message, ...fields } = value;
    this.#value = { ...this.#value, updatedAtUnixMs: now, [source]: Object.freeze({ ...fields, updatedAtUnixMs: now,
      ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }),
      warnings: Object.freeze(value.warnings.map(warning => Object.freeze({ ...warning }))) }) };
    return this.#value;
  }
  private warn(value: CaptureSourceHealth, kind: CaptureHealthWarningKind, message: string, now: number, code?: string): CaptureSourceHealth {
    const previous = value.warnings.find(warning => warning.kind === kind);
    const warning: CaptureHealthWarning = { kind, message: clean(message)!, ...(clean(code, 100) ? { code: clean(code, 100) } : {}),
      firstAtUnixMs: previous?.firstAtUnixMs ?? now, lastAtUnixMs: now };
    return { ...value, warnings: [...value.warnings.filter(item => item.kind !== kind), warning] };
  }
  state(source: CaptureHealthSource, update: SystemAudioStateUpdate, nowUnixMs = Date.now()): CaptureHealthSnapshot {
    const previous = this.#value[source];
    if (previous.state === 'disabled' || previous.state === 'stopped') return this.#value;
    const now = Math.max(this.#value.updatedAtUnixMs, nowUnixMs);
    const code = clean(update.code, 100), message = clean(update.message);
    const kind: CaptureHealthWarningKind | undefined = code?.endsWith('_quiet') ? 'quiet'
      : code?.endsWith('_reconnecting') ? 'reconnecting'
      : code?.endsWith('_no_audio') ? 'no-audio'
      : update.state === 'unavailable' ? 'unavailable' : undefined;
    const state: CaptureHealthState = kind === 'quiet' ? 'quiet' : kind === 'reconnecting' ? 'reconnecting'
      : update.state === 'active' ? 'receiving' : update.state === 'ready' ? 'starting'
      : update.state === 'starting' && previous.state === 'reconnecting' ? 'reconnecting' : update.state;
    let value: CaptureSourceHealth = { ...previous, state, code, message };
    if (kind) value = this.warn(value, kind, message ?? `${label(source)} ${kind === 'no-audio' ? 'has not supplied audio yet' : kind}.`, now, code);
    return this.set(source, value, now);
  }
  pcm(source: CaptureHealthSource, level?: PcmSignalLevel, audible?: boolean, nowUnixMs = Date.now()): CaptureHealthSnapshot {
    const previous = this.#value[source];
    if (previous.state === 'disabled' || previous.state === 'stopped') return this.#value;
    const now = Math.max(this.#value.updatedAtUnixMs, nowUnixMs);
    // This mirrors only the capture meter's signal floor, not speech recognition.
    const signal = audible === true || (audible === undefined && Boolean(level && level.peak >= 64 && level.rmsDbfs >= -60));
    const quiet = !signal && now - (previous.lastSignalAtUnixMs ?? this.#startedAt) >= this.#quietAfterMs;
    let value: CaptureSourceHealth = {
      ...previous, state: quiet ? 'quiet' : 'receiving', lastPcmAtUnixMs: now,
      ...(signal ? { lastSignalAtUnixMs: now } : {}),
      code: quiet ? `${source === 'microphone' ? 'microphone' : 'system_audio'}_quiet` : undefined,
      message: quiet ? `${label(source)} is quiet. This may be silence or mute; check the input if sound is expected.` : undefined,
      warnings: previous.warnings.map(warning => warning.resolvedAtUnixMs === undefined && (warning.kind !== 'quiet' || signal)
        ? { ...warning, resolvedAtUnixMs: now } : warning),
    };
    if (quiet && (previous.state !== 'quiet' || !previous.warnings.some(warning => warning.kind === 'quiet' && warning.resolvedAtUnixMs === undefined))) {
      value = this.warn(value, 'quiet', value.message!, now, value.code);
    }
    return this.set(source, value, now);
  }
  stop(nowUnixMs = Date.now()): CaptureHealthSnapshot {
    for (const source of sources) if (this.#value[source].state !== 'disabled') {
      this.set(source, { ...this.#value[source], state: 'stopped', code: undefined, message: undefined }, Math.max(this.#value.updatedAtUnixMs, nowUnixMs));
    }
    return this.#value;
  }
}

export function parseCaptureHealth(value: unknown): CaptureHealthSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as CaptureHealthSnapshot;
  if (raw.schemaVersion !== 1 || !timestamp(raw.updatedAtUnixMs)) return;
  const optionalTime = (value: unknown) => value === undefined || timestamp(value);
  const optionalText = (value: unknown, limit: number) => value === undefined || (typeof value === 'string' && value.length <= limit && clean(value, limit) === value);
  for (const source of sources) {
    const item = raw[source];
    if (!item || !states.includes(item.state) || !timestamp(item.updatedAtUnixMs) || !optionalTime(item.lastPcmAtUnixMs) ||
        !optionalTime(item.lastSignalAtUnixMs) || !optionalText(item.code, 100) || !optionalText(item.message, 600) ||
        !Array.isArray(item.warnings) || item.warnings.length > kinds.length) return;
    const seen = new Set<string>();
    for (const warning of item.warnings) {
      if (!warning || !kinds.includes(warning.kind) || seen.has(warning.kind) || typeof warning.message !== 'string' ||
          !optionalText(warning.message, 600) || !optionalText(warning.code, 100) || !timestamp(warning.firstAtUnixMs) ||
          !timestamp(warning.lastAtUnixMs) || warning.lastAtUnixMs < warning.firstAtUnixMs || !optionalTime(warning.resolvedAtUnixMs)) return;
      seen.add(warning.kind);
    }
  }
  // Copy only the supported fields; readers never expose arbitrary sidecar data.
  const copy = (item: CaptureSourceHealth): CaptureSourceHealth => ({
    state: item.state, updatedAtUnixMs: item.updatedAtUnixMs, warnings: item.warnings.map(w => ({ kind: w.kind, message: w.message,
      firstAtUnixMs: w.firstAtUnixMs, lastAtUnixMs: w.lastAtUnixMs, ...(w.code === undefined ? {} : { code: w.code }),
      ...(w.resolvedAtUnixMs === undefined ? {} : { resolvedAtUnixMs: w.resolvedAtUnixMs }) })),
    ...(item.lastPcmAtUnixMs === undefined ? {} : { lastPcmAtUnixMs: item.lastPcmAtUnixMs }),
    ...(item.lastSignalAtUnixMs === undefined ? {} : { lastSignalAtUnixMs: item.lastSignalAtUnixMs }),
    ...(item.code === undefined ? {} : { code: item.code }), ...(item.message === undefined ? {} : { message: item.message }),
  });
  return { schemaVersion: 1, updatedAtUnixMs: raw.updatedAtUnixMs, microphone: copy(raw.microphone), systemAudio: copy(raw.systemAudio) };
}

export function readCaptureHealth(directory: string): CaptureHealthSnapshot | undefined {
  try {
    const path = join(directory, 'capture-health.json');
    if (statSync(path).size > 16_384) return;
    return parseCaptureHealth(JSON.parse(readFileSync(path, 'utf8')));
  } catch { return undefined; }
}

/** Key excludes continuous PCM timestamps, which are persisted at most once/sec. */
export function captureHealthTransitionKey(health: CaptureHealthSnapshot): string {
  return JSON.stringify(sources.map(source => {
    const { state, code, message, warnings } = health[source];
    return { state, code, message, signal: health[source].lastSignalAtUnixMs !== undefined,
      warnings: warnings.map(w => ({ kind: w.kind, code: w.code, message: w.message, resolved: w.resolvedAtUnixMs !== undefined })) };
  }));
}

export class CaptureHealthWriter {
  #writtenAt = -Infinity;
  #key?: string;
  constructor(readonly directory: string) {}
  write(health: CaptureHealthSnapshot, force = false): boolean {
    const key = captureHealthTransitionKey(health);
    if (!force && key === this.#key && health.updatedAtUnixMs - this.#writtenAt < 1_000) return false;
    const path = join(this.directory, 'capture-health.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(health)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
      this.#key = key; this.#writtenAt = health.updatedAtUnixMs;
      return true;
    } finally { rmSync(temporary, { force: true }); }
  }
}
