/**
 * How long a helper has been silent, as a watchdog tick can trust it.
 *
 * A tick that runs late measures this process's own lag (a long synchronous
 * write, a garbage collection, a Mac too busy to schedule it), not the
 * helper's: its output may be waiting in the pipe behind the tick. Killing a
 * healthy capture helper then costs a gap in the audio and, for computer
 * audio, a rebuilt tap that can click on the speakers. So a late tick is
 * excused once, which lets the waiting output arrive; the next tick judges,
 * late or not, so a real stall is caught at most one tick later.
 */
export class StallClock {
  readonly #tickMs: number;
  #lastTickAt: number;
  #lastDataAt: number;
  #excused = false;

  constructor(tickMs: number, nowUnixMs = Date.now()) {
    this.#tickMs = tickMs;
    this.#lastTickAt = nowUnixMs;
    this.#lastDataAt = nowUnixMs;
  }

  /** Output arrived. */
  data(nowUnixMs = Date.now()): void {
    this.#lastDataAt = nowUnixMs;
  }

  /** Start counting again from now, as after a restart. */
  reset(nowUnixMs = Date.now()): void {
    this.#lastTickAt = nowUnixMs;
    this.#lastDataAt = nowUnixMs;
    this.#excused = false;
  }

  /** At a watchdog tick: how long the helper has been silent, or 0 when this tick ran too late to tell. */
  silentFor(nowUnixMs = Date.now()): number {
    const late = nowUnixMs - this.#lastTickAt > this.#tickMs * 2;
    this.#lastTickAt = nowUnixMs;
    if (late && !this.#excused) {
      this.#excused = true;
      return 0;
    }
    this.#excused = false;
    return nowUnixMs - this.#lastDataAt;
  }
}
