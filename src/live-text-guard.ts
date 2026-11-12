import { availableParallelism, loadavg } from 'os';

/** What the recording says while live drafts are paused: the last row of its transcript, and `seashell` output. */
export const LIVE_TEXT_PAUSED = 'Live text paused while your Mac is busy. Audio is still recording; the full transcript is written after the call.';

/** One poll's view of how busy the Mac is. */
export interface MacLoadReading {
  /** The one-minute load average over the cores. Above 1, threads queue for a core. */
  readonly loadPerCore: number;
  /** Live text has fallen behind the audio (BackgroundLiveTranscriptHandle.behind). */
  readonly draftBehind: boolean;
  /** A probe timed out this poll: the signals detector or Meet's page. */
  readonly probeTimedOut: boolean;
}

export interface LiveTextGuardLimits {
  /** Pause at this load per core: tonight's call ran at 4 to 6. */
  readonly pauseLoadPerCore: number;
  /** Resume only below this, so the guard does not flap at the line. */
  readonly resumeLoadPerCore: number;
  /** This many probe timeouts within timeoutWindowMs pause live text. */
  readonly timeoutsToPause: number;
  readonly timeoutWindowMs: number;
  /** How long everything must stay calm before live text resumes. */
  readonly calmMs: number;
}

export const DEFAULT_LIVE_TEXT_GUARD_LIMITS: LiveTextGuardLimits = Object.freeze({
  pauseLoadPerCore: 1.5, resumeLoadPerCore: 1, timeoutsToPause: 2, timeoutWindowMs: 60_000, calmMs: 60_000,
});

/**
 * The Mac's one-minute load average over its cores. SEASHELL_LOAD_PER_CORE
 * pins it: tests must not depend on how busy the Mac running them is, and
 * setting it to 4 shows what a recording does on an overloaded Mac.
 */
export function macLoadPerCore(env: NodeJS.ProcessEnv = process.env): number {
  const pinned = env.SEASHELL_LOAD_PER_CORE?.trim() ? Number(env.SEASHELL_LOAD_PER_CORE) : Number.NaN;
  if (Number.isFinite(pinned) && pinned >= 0) return pinned;
  return (loadavg()[0] ?? 0) / Math.max(1, availableParallelism());
}

/**
 * Whether live drafts run. Live text is a nicety; the call's audio is not.
 * When the Mac is overloaded during a recording (live text falling behind,
 * the load per core past a line, or probes timing out) drafts pause and the
 * audio keeps recording, so the final pass loses nothing. They come back
 * once everything has been calm for a minute.
 */
export class LiveTextGuard {
  readonly #limits: LiveTextGuardLimits;
  #paused = false;
  #calmSince?: number;
  #timeouts: number[] = [];

  constructor(limits: Partial<LiveTextGuardLimits> = {}) {
    this.#limits = { ...DEFAULT_LIVE_TEXT_GUARD_LIMITS, ...limits };
  }

  get paused(): boolean { return this.#paused; }

  /** Says 'pause' or 'resume' when live text should change, otherwise nothing. */
  observe(nowUnixMs: number, reading: MacLoadReading): 'pause' | 'resume' | undefined {
    const limits = this.#limits;
    if (reading.probeTimedOut) this.#timeouts.push(nowUnixMs);
    this.#timeouts = this.#timeouts.filter((at) => nowUnixMs - at < limits.timeoutWindowMs && at <= nowUnixMs);
    const load = Number.isFinite(reading.loadPerCore) ? reading.loadPerCore : 0;
    const timedOut = this.#timeouts.length >= limits.timeoutsToPause;
    if (!this.#paused) {
      if (load < limits.pauseLoadPerCore && !reading.draftBehind && !timedOut) return undefined;
      this.#paused = true;
      this.#calmSince = undefined;
      return 'pause';
    }
    if (load >= limits.resumeLoadPerCore || reading.draftBehind || this.#timeouts.length > 0) {
      this.#calmSince = undefined;
      return undefined;
    }
    this.#calmSince ??= nowUnixMs;
    if (nowUnixMs - this.#calmSince < limits.calmMs) return undefined;
    this.#paused = false;
    this.#calmSince = undefined;
    return 'resume';
  }
}
