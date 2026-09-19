import { randomUUID } from 'crypto';
import { dlopen } from 'bun:ffi';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
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

function readOwner(path: string): { pid: number; token: string; protocol?: string } | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const owner = value as Record<string, unknown>;
    if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 ||
        typeof owner.token !== 'string' || !owner.token) return undefined;
    return { pid: Number(owner.pid), token: owner.token,
      ...(typeof owner.protocol === 'string' ? { protocol: owner.protocol } : {}) };
  } catch {
    return undefined;
  }
}

function loadLockLibrary() {
  return dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    flock: { args: ['i32', 'i32'], returns: 'i32' },
  });
}
let lockLibrary: ReturnType<typeof loadLockLibrary> | undefined;

/**
 * The kernel owns exclusion and releases it on crash. Keep one stable inode:
 * unlinking a PID file allows stale-owner cleanup to delete a newer owner's lease.
 * The JSON is diagnostic metadata, never the authority for a flock lease.
 */
export function acquireMeetingWatchLock(
  options: MeetingWatchLockOptions = {},
): MeetingWatchLock | undefined {
  const path = resolve(options.path ?? defaultMeetingWatchLockPath());
  const pid = options.pid ?? process.pid;
  const pidAlive = options.pidAlive ?? processAlive;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, 'a+', 0o600);
  let held = false;
  try {
    const flock = (lockLibrary ??= loadLockLibrary()).symbols.flock;
    if (flock(descriptor, 2 | 4) !== 0) return undefined; // LOCK_EX | LOCK_NB
    // Respect a still-running watcher from the older PID-file implementation.
    const owner = readOwner(path);
    if (owner && owner.protocol !== 'flock-1' && pidAlive(owner.pid)) return undefined;
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, `${JSON.stringify({
      protocol: 'flock-1', pid, token: randomUUID(), createdAt: new Date().toISOString(),
    })}\n`);
    held = true;
    let released = false;
    return Object.freeze({
      path, pid,
      release() {
        if (released) return;
        released = true;
        // Closing the descriptor releases the lease without a pathname race.
        closeSync(descriptor);
      },
    });
  } finally {
    if (!held) closeSync(descriptor);
  }
}
