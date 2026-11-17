import type { ChildProcess } from 'child_process';

/**
 * Seashell's heavy work gives way to calls. That is the final pass (Whisper on
 * the GPU, speech detection, media preparation) and speaker separation (Core
 * ML on the Neural Engine, or pyannote on the CPU). taskpolicy lowers its CPU
 * priority (inference-priority.ts), but nothing lowers its claim on the GPU,
 * the Neural Engine or memory bandwidth, which the call's own media pipeline
 * shares.
 *
 * So while the gate is held, none of it starts, and what is running is
 * stopped where it stands (SIGSTOP) and continued (SIGCONT) once the gate
 * opens. A stopped process submits no more GPU or Neural Engine work, and
 * loses none it has done: a Core ML or Metal request already submitted
 * finishes within milliseconds, and nothing in Seashell times these
 * processes out.
 *
 * The watcher holds it while anyone is on a call (automatic-meeting-watch.ts).
 * A process that never holds it, like `seashell transcribe`, runs at once.
 */
export class HeavyWorkGate {
  #held = false;
  readonly #running = new Set<ChildProcess>();
  #waiting: Array<() => void> = [];
  #lane: Promise<void> = Promise.resolve();

  get held(): boolean { return this.#held; }

  /** Stop what runs, and start nothing, until release. */
  hold(): void {
    if (this.#held) return;
    this.#held = true;
    for (const child of this.#running) send(child, 'SIGSTOP');
  }

  release(): void {
    if (!this.#held) return;
    this.#held = false;
    for (const child of this.#running) send(child, 'SIGCONT');
    for (const resolve of this.#waiting.splice(0)) resolve();
  }

  /** Resolves when heavy work may start: at once unless the gate is held. */
  ready(): Promise<void> {
    return this.#held ? new Promise((resolve) => { this.#waiting.push(resolve); }) : Promise.resolve();
  }

  /** A heavy process now running: stopped while the gate is held, now or later, until it exits. */
  follow(child: ChildProcess): () => void {
    this.#running.add(child);
    const forget = () => { this.#running.delete(child); };
    child.once('exit', forget);
    child.once('error', forget);
    if (this.#held) send(child, 'SIGSTOP');
    return forget;
  }

  /**
   * Runs `work` once the work before it in this lane has settled. Two Whisper
   * passes on the GPU at once are the heaviest load Seashell can put on a Mac,
   * so the final pass runs one track's Whisper at a time; speaker separation
   * still runs beside it, on the Neural Engine.
   */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#lane.then(work);
    this.#lane = run.then(() => {}, () => {});
    return run;
  }
}

function send(child: ChildProcess, signal: 'SIGSTOP' | 'SIGCONT'): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  // Not child.kill(): that marks the child killed, and cleanup then skips its SIGTERM.
  try { process.kill(child.pid, signal); } catch { /* Exited meanwhile. */ }
}

/** The process's one gate: the watcher holds it, and every heavy process follows it. */
export const heavyWork = new HeavyWorkGate();
