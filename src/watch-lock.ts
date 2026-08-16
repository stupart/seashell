import { randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

export interface MeetingWatchLock {
  readonly path: string;
  readonly pid: number;
  release(): void;
}

export interface MeetingWatchLockOptions {
  readonly path?: string;
  readonly pid?: number;
  readonly pidAlive?: (pid: number) => boolean;
}

export function defaultMeetingWatchLockPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Sea Shell', 'meeting-watch.lock');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(path: string): { pid: number; token: string } | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const owner = value as Record<string, unknown>;
    if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 ||
        typeof owner.token !== 'string' || !owner.token) return undefined;
    return { pid: Number(owner.pid), token: owner.token };
  } catch {
    return undefined;
  }
}

/** Acquire one exact per-user watcher lease; stale process-owned leases are recoverable. */
export function acquireMeetingWatchLock(
  options: MeetingWatchLockOptions = {},
): MeetingWatchLock | undefined {
  const path = resolve(options.path ?? defaultMeetingWatchLockPath());
  const pid = options.pid ?? process.pid;
  const pidAlive = options.pidAlive ?? processAlive;
  const token = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify({ pid, token, createdAt: new Date().toISOString() })}\n`);
      } finally {
        closeSync(descriptor);
      }
      let released = false;
      return Object.freeze({
        path,
        pid,
        release() {
          if (released) return;
          released = true;
          const owner = readOwner(path);
          if (owner?.pid === pid && owner.token === token) rmSync(path, { force: true });
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readOwner(path);
      if (owner && pidAlive(owner.pid)) return undefined;
      if (existsSync(path)) rmSync(path, { force: true });
    }
  }
  return undefined;
}
