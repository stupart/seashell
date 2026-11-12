import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCaptureSession, type CaptureChunk } from './capture-session.ts';
import type { PcmSignalLevel, SystemAudioStateUpdate } from './live-system-audio.ts';

export type CaptureHealthSource = 'microphone' | 'systemAudio';
/** `released`: Seashell let go of the source on purpose, as when the call app released its microphone. Not a failure. */
export type CaptureHealthState = 'starting' | 'receiving' | 'quiet' | 'reconnecting' | 'unavailable' | 'stopped' | 'disabled' | 'released';
/** one-sided: the others are talking and your microphone hears nothing. */
export type CaptureHealthWarningKind = 'quiet' | 'reconnecting' | 'unavailable' | 'no-audio' | 'one-sided';
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
/** What your microphone captured compared with the other side, over a whole meeting. */
export interface CaptureCoverage {
  /** Seconds of saved microphone audio with sound in it. */
  readonly yourSideAudibleSeconds: number;
  /** Seconds of saved computer audio with sound in it: the others talking. */
  readonly otherSideAudibleSeconds: number;
  /** Your audible time over theirs. Absent until they have talked for a few minutes. */
  readonly yourSideAudibleShare?: number;
  /** They talked for minutes and your microphone heard almost nothing. */
  readonly yourSideMissing: boolean;
}
export type CaptureVideoState = 'starting' | 'recording' | 'waiting' | 'stopped' | 'unavailable';
/** The video track, when the recording has one: what it films, in words, never a window's title. */
export interface CaptureVideoHealth {
  readonly state: CaptureVideoState;
  /** "the Google Meet window", "display 1, the whole screen". */
  readonly filming?: string;
  /** A whole display was filmed in this recording; said for as long as the recording shows. */
  readonly screenFilmed?: boolean;
}
export interface CaptureHealthSnapshot {
  readonly schemaVersion: 1;
  readonly updatedAtUnixMs: number;
  readonly microphone: CaptureSourceHealth;
  readonly systemAudio: CaptureSourceHealth;
  /** Set when capture stops, from the meeting's saved audio. */
  readonly coverage?: CaptureCoverage;
  readonly video?: CaptureVideoHealth;
}
export type CoverageChunk = Pick<CaptureChunk, 'trackId' | 'audible' | 'startMs' | 'endMs'>;

export const ONE_SIDED_MESSAGE = "Your microphone hasn't picked you up for a minute. Are you muted, or is the wrong mic selected?";
export const YOUR_SIDE_MISSING_NOTICE = "Your side wasn't recorded. Your microphone picked up almost nothing while the others talked.";
/** The others count as talking when their audio had sound this recently. */
const OTHERS_TALKING_MS = 10_000;
/** "A few minutes" of the others talking before a meeting's coverage is judged. */
const JUDGE_AFTER_OTHERS_SECONDS = 180;
/** A working microphone hears room sound most of the time: healthy calls measured
 * two to four times the other side's audible time, broken ones 0 to 5 percent. */
const YOUR_SIDE_MISSING_SHARE = 0.1;

const sources = ['microphone', 'systemAudio'] as const;
const states: readonly CaptureHealthState[] = ['starting', 'receiving', 'quiet', 'reconnecting', 'unavailable', 'stopped', 'disabled', 'released'];
const kinds: readonly CaptureHealthWarningKind[] = ['quiet', 'reconnecting', 'unavailable', 'no-audio', 'one-sided'];
const videoStates: readonly CaptureVideoState[] = ['starting', 'recording', 'waiting', 'stopped', 'unavailable'];
/** Warnings that only sound, not just more PCM, resolves. */
const untilSignal: readonly CaptureHealthWarningKind[] = ['quiet', 'one-sided'];
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const clean = (text: string | undefined, limit = 600): string | undefined => text?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, limit) || undefined;
const label = (source: CaptureHealthSource) => source === 'microphone' ? 'Microphone' : 'Computer audio';

/** Bounded in-memory projection. Silence is a caution, never a permission verdict. */
export class CaptureHealthTracker {
  #value: CaptureHealthSnapshot;
  readonly #startedAt: number;
  readonly #quietAfterMs: number;
  readonly #oneSidedAfterMs: number;
  #microphoneSince?: number;
  constructor(options: { microphone?: boolean; systemAudio?: boolean; nowUnixMs?: number; quietAfterMs?: number; oneSidedAfterMs?: number } = {}) {
    this.#startedAt = options.nowUnixMs ?? Date.now();
    this.#quietAfterMs = options.quietAfterMs ?? 30_000;
    this.#oneSidedAfterMs = options.oneSidedAfterMs ?? 60_000;
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
    if (previous.state === 'disabled' || previous.state === 'stopped' || previous.state === 'released') return this.#value;
    const now = Math.max(this.#value.updatedAtUnixMs, nowUnixMs);
    // This mirrors only the capture meter's signal floor, not speech recognition.
    const signal = audible === true || (audible === undefined && Boolean(level && level.peak >= 64 && level.rmsDbfs >= -60));
    const quiet = !signal && now - (previous.lastSignalAtUnixMs ?? this.#startedAt) >= this.#quietAfterMs;
    let value: CaptureSourceHealth = {
      ...previous, state: quiet ? 'quiet' : 'receiving', lastPcmAtUnixMs: now,
      ...(signal ? { lastSignalAtUnixMs: now } : {}),
      code: quiet ? `${source === 'microphone' ? 'microphone' : 'system_audio'}_quiet` : undefined,
      message: quiet ? `${label(source)} is quiet. This may be silence or mute; check the input if sound is expected.` : undefined,
      warnings: previous.warnings.map(warning => warning.resolvedAtUnixMs === undefined && (!untilSignal.includes(warning.kind) || signal)
        ? { ...warning, resolvedAtUnixMs: now } : warning),
    };
    if (quiet && (previous.state !== 'quiet' || !previous.warnings.some(warning => warning.kind === 'quiet' && warning.resolvedAtUnixMs === undefined))) {
      value = this.warn(value, 'quiet', value.message!, now, value.code);
    }
    if (source === 'microphone') this.#microphoneSince ??= now;
    this.set(source, value, now);
    return this.oneSided(now);
  }
  /** Others talking while your microphone delivers PCM with nothing in it, for
   * about a minute: muted, or the wrong input. Raised once until you are heard. */
  private oneSided(now: number): CaptureHealthSnapshot {
    const mic = this.#value.microphone, others = this.#value.systemAudio;
    if (mic.warnings.some(warning => warning.kind === 'one-sided' && warning.resolvedAtUnixMs === undefined)) return this.#value;
    const silentSince = Math.max(mic.lastSignalAtUnixMs ?? 0, this.#microphoneSince ?? now);
    const delivering = (mic.state === 'receiving' || mic.state === 'quiet') && now - (mic.lastPcmAtUnixMs ?? -Infinity) <= 8_000;
    const othersTalking = now - (others.lastSignalAtUnixMs ?? -Infinity) <= OTHERS_TALKING_MS;
    if (!delivering || !othersTalking || now - silentSince < this.#oneSidedAfterMs) return this.#value;
    return this.set('microphone', this.warn(mic, 'one-sided', ONE_SIDED_MESSAGE, now, 'microphone_one_sided'), now);
  }
  /**
   * Seashell let go of the source on purpose: the call app released its
   * microphone, so a headset can leave call mode. Opening it again starts it afresh.
   */
  release(source: CaptureHealthSource, nowUnixMs = Date.now()): CaptureHealthSnapshot {
    const previous = this.#value[source];
    if (previous.state === 'disabled' || previous.state === 'stopped') return this.#value;
    return this.set(source, { ...previous, state: 'released', code: undefined,
      message: `${label(source)} released: the call let go of it.` }, Math.max(this.#value.updatedAtUnixMs, nowUnixMs));
  }
  /** What the video track is doing and filming. Once a display is filmed, that stays said. */
  video(state: CaptureVideoState, filming?: { readonly kind: 'window' | 'display'; readonly name: string }, nowUnixMs = Date.now()): CaptureHealthSnapshot {
    const previous = this.#value.video;
    const name = clean(filming?.name, 100) ?? previous?.filming;
    const screenFilmed = previous?.screenFilmed === true || filming?.kind === 'display';
    this.#value = { ...this.#value, updatedAtUnixMs: Math.max(this.#value.updatedAtUnixMs, nowUnixMs),
      video: Object.freeze({ state, ...(name ? { filming: name } : {}), ...(screenFilmed ? { screenFilmed: true } : {}) }) };
    return this.#value;
  }
  /** Pass the meeting's saved chunks to keep its coverage with the final health. */
  stop(nowUnixMs = Date.now(), chunks?: readonly CoverageChunk[]): CaptureHealthSnapshot {
    for (const source of sources) if (this.#value[source].state !== 'disabled') {
      this.set(source, { ...this.#value[source], state: 'stopped', code: undefined, message: undefined }, Math.max(this.#value.updatedAtUnixMs, nowUnixMs));
    }
    if (chunks) {
      const coverage = captureCoverage(chunks, { microphone: this.#value.microphone.state !== 'disabled' });
      this.#value = { ...this.#value, coverage: Object.freeze(coverage) };
    }
    return this.#value;
  }
}

/**
 * Judge a meeting by how much of the call your microphone heard compared with
 * the others, not by whether it heard anything at all: a broken microphone
 * still lets through a few seconds of an hour.
 */
export function captureCoverage(chunks: readonly CoverageChunk[], options: { readonly microphone?: boolean } = {}): CaptureCoverage {
  const audible = (track: CoverageChunk['trackId']) => chunks.reduce((total, chunk) =>
    chunk.trackId === track && chunk.audible ? total + Math.max(0, chunk.endMs - chunk.startMs) / 1_000 : total, 0);
  const yours = audible('microphone'), theirs = audible('system-audio');
  const judged = theirs >= JUDGE_AFTER_OTHERS_SECONDS;
  return {
    yourSideAudibleSeconds: Math.round(yours), otherSideAudibleSeconds: Math.round(theirs),
    ...(judged ? { yourSideAudibleShare: Math.round(yours / theirs * 1_000) / 1_000 } : {}),
    yourSideMissing: options.microphone !== false && judged && yours < theirs * YOUR_SIDE_MISSING_SHARE,
  };
}

/** A saved meeting's coverage: kept by the recorder when it stopped, or worked
 * out from the saved audio for meetings recorded before it kept one. Pass the
 * library entry's captureHealth when you have it. */
export function readMeetingCoverage(directory: string, health = readCaptureHealth(join(directory, 'capture'))): CaptureCoverage | undefined {
  if (health?.coverage) return health.coverage;
  try {
    return captureCoverage(loadCaptureSession(join(directory, 'capture', 'manifest.json')).chunks,
      { microphone: health?.microphone.state !== 'disabled' });
  } catch { return undefined; }
}

/** "Your side wasn't recorded", for the meeting view and MCP to show, or nothing. */
export function yourSideNotice(coverage: CaptureCoverage | undefined): string | undefined {
  return coverage?.yourSideMissing ? YOUR_SIDE_MISSING_NOTICE : undefined;
}

/** The watch events the notice follows. Structural, so health does not depend on the watcher. */
interface WatchEventLike { readonly type: string; readonly sessionId?: string; readonly message?: string }

/**
 * Tells you once per meeting that your side is not being heard. Muting on
 * purpose is normal, so a meeting never gets a second notice, even after a pause.
 */
export function oneSidedNotifier(notify: (message: string) => void): (event: WatchEventLike) => void {
  let meeting: string | undefined, notified: string | undefined;
  return (event) => {
    if (event.type === 'meeting.started' || event.type === 'meeting.resumed') meeting = event.sessionId;
    else if (event.type === 'watch.warning' && meeting !== undefined && notified !== meeting && event.message?.includes(ONE_SIDED_MESSAGE)) {
      notified = meeting;
      notify(ONE_SIDED_MESSAGE);
    }
  };
}

const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validCoverage(value: unknown): value is CaptureCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const coverage = value as CaptureCoverage;
  return seconds(coverage.yourSideAudibleSeconds) && seconds(coverage.otherSideAudibleSeconds) &&
    (coverage.yourSideAudibleShare === undefined || seconds(coverage.yourSideAudibleShare)) && typeof coverage.yourSideMissing === 'boolean';
}

export function parseCaptureHealth(value: unknown): CaptureHealthSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as CaptureHealthSnapshot;
  if (raw.schemaVersion !== 1 || !timestamp(raw.updatedAtUnixMs)) return;
  if (raw.coverage !== undefined && !validCoverage(raw.coverage)) return;
  const video = raw.video as CaptureVideoHealth | undefined;
  if (video !== undefined && (!video || typeof video !== 'object' || !videoStates.includes(video.state) ||
      (video.filming !== undefined && (typeof video.filming !== 'string' || clean(video.filming, 100) !== video.filming)) ||
      (video.screenFilmed !== undefined && video.screenFilmed !== true))) return;
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
  const coverage = raw.coverage && { yourSideAudibleSeconds: raw.coverage.yourSideAudibleSeconds, otherSideAudibleSeconds: raw.coverage.otherSideAudibleSeconds,
    ...(raw.coverage.yourSideAudibleShare === undefined ? {} : { yourSideAudibleShare: raw.coverage.yourSideAudibleShare }),
    yourSideMissing: raw.coverage.yourSideMissing };
  return { schemaVersion: 1, updatedAtUnixMs: raw.updatedAtUnixMs, microphone: copy(raw.microphone), systemAudio: copy(raw.systemAudio),
    ...(coverage ? { coverage } : {}),
    ...(video ? { video: { state: video.state, ...(video.filming ? { filming: video.filming } : {}), ...(video.screenFilmed ? { screenFilmed: true } : {}) } } : {}) };
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
  return JSON.stringify([...sources.map(source => {
    const { state, code, message, warnings } = health[source];
    return { state, code, message, signal: health[source].lastSignalAtUnixMs !== undefined,
      warnings: warnings.map(w => ({ kind: w.kind, code: w.code, message: w.message, resolved: w.resolvedAtUnixMs !== undefined })) };
  }), health.video ?? null]);
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
