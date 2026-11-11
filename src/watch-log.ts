import { dlopen } from 'bun:ffi';
import { copyFileSync, fstatSync, ftruncateSync, renameSync, rmSync, statSync, writeSync } from 'fs';

/** The same warning is logged at most once in this window. */
export const WARNING_REPEAT_MS = 10 * 60_000;
/** Past this size meeting-watch.jsonl moves to its rotated file and starts again. */
export const WATCH_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Meet and capture warnings can flip between a few messages every few seconds
 * for hours. Each message is shown once per window; the repeats in between are
 * counted, so alternating messages are repeats too.
 */
export class WarningRateLimit {
  readonly #shown = new Map<string, { atUnixMs: number; repeats: number }>();

  constructor(readonly windowMs = WARNING_REPEAT_MS) {}

  /** Undefined to drop the warning; otherwise how many repeats were dropped since it last showed. */
  admit(message: string, nowUnixMs: number): number | undefined {
    const shown = this.#shown.get(message);
    if (shown && nowUnixMs - shown.atUnixMs < this.windowMs) {
      shown.repeats += 1;
      return undefined;
    }
    for (const [key, value] of this.#shown) {
      if (value.repeats === 0 && nowUnixMs - value.atUnixMs >= this.windowMs) this.#shown.delete(key);
    }
    this.#shown.set(message, { atUnixMs: nowUnixMs, repeats: 0 });
    return shown?.repeats ?? 0;
  }
}

export interface WatchLogFiles {
  readonly path: string;
  readonly rotatedPath: string;
}

function loadFileControl() {
  return dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    fcntl: { args: ['i32', 'i32'], returns: 'i32' },
  });
}
let fileControl: ReturnType<typeof loadFileControl> | undefined;

/** Truncating is only safe when every write lands at the end of the file. */
function appendsOnly(descriptor: number): boolean {
  try {
    const flags = (fileControl ??= loadFileControl()).symbols.fcntl(descriptor, 3); // F_GETFL
    return flags >= 0 && (flags & (process.platform === 'darwin' ? 0x8 : 0o2000)) !== 0; // O_APPEND
  } catch {
    return false;
  }
}

/**
 * Write watch events as lines. launchd appends the login agent's stdout to
 * meeting-watch.jsonl and never trims it, and it keeps the descriptor open.
 * So when that file passes the cap, copy it to the rotated file and truncate it
 * in place; append mode puts the next line at the start. Any other output, such
 * as a terminal, a pipe or a redirect to another file, is written untouched.
 */
export function watchLogWriter(
  files: WatchLogFiles | undefined,
  options: { readonly descriptor?: number; readonly maxBytes?: number; readonly fallback?: (line: string) => void } = {},
): (line: string) => void {
  const descriptor = options.descriptor ?? 1;
  const maxBytes = options.maxBytes ?? WATCH_LOG_MAX_BYTES;
  const fallback = options.fallback ?? ((line: string) => { process.stdout.write(line); });
  let toFile = false;
  try { toFile = fstatSync(descriptor).isFile(); } catch {}
  // Pipes and terminals may be non-blocking; a regular file never is.
  if (!toFile) return (line) => fallback(withNewline(line));
  let rotates: boolean | undefined;
  const rotateIfFull = () => {
    if (!files || rotates === false) return;
    const output = fstatSync(descriptor);
    if (output.size < maxBytes) return;
    if (rotates === undefined) {
      let log: ReturnType<typeof statSync> | undefined;
      try { log = statSync(files.path); } catch {}
      rotates = log?.ino === output.ino && log.dev === output.dev && appendsOnly(descriptor);
      if (!rotates) return;
    }
    const temporary = `${files.rotatedPath}.${process.pid}.tmp`;
    try {
      copyFileSync(files.path, temporary);
      renameSync(temporary, files.rotatedPath);
      ftruncateSync(descriptor, 0);
    } catch {
      rmSync(temporary, { force: true });
    }
  };
  return (line) => {
    rotateIfFull();
    writeSync(descriptor, withNewline(line));
  };
}

function withNewline(line: string): string {
  return line.endsWith('\n') ? line : `${line}\n`;
}
