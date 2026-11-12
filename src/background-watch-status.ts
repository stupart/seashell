import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BackgroundWatchProjection {
  phase: 'watching' | 'awaiting-consent' | 'recording' | 'stopped';
  candidate?: { id: string; title: string; appName: string };
  sessionId?: string;
  consentId?: string;
  warning?: string;
}
export interface BackgroundWatchStatus extends Omit<BackgroundWatchProjection, 'phase'> {
  schemaVersion: 1;
  phase: BackgroundWatchProjection['phase'] | 'unavailable';
  pid: number;
  updatedAtUnixMs: number;
  /**
   * Unavailable only: the recorder is alive but has not written for over 30 s,
   * so it is busy, not gone. What it last said, which nothing confirms now.
   */
  lastPhase?: BackgroundWatchProjection['phase'];
}
const filename = '.background-watch.json';
/** Past this, the recorder counts as not responding. It rewrites its status every few seconds while it runs. */
export const BACKGROUND_WATCH_FRESH_MS = 30_000;
const safeText = (value: unknown, limit = 500): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(value);
/** What the reader accepts, so a calendar title with an emoji joiner or a newline never hides a running recorder. */
const tidy = (value: string | undefined, limit = 500): string | undefined =>
  value?.replace(/\p{Cf}/gu, '').replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit).trim() || undefined;

/** Current watcher state is separate from saved meetings. No capture or permissions are opened. */
export function writeBackgroundWatchStatus(libraryDir: string, status: BackgroundWatchProjection, nowUnixMs = Date.now()): void {
  mkdirSync(libraryDir, { recursive: true, mode: 0o700 });
  const path = join(libraryDir, filename);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const candidate = status.candidate && tidy(status.candidate.id) ? {
    id: tidy(status.candidate.id)!, title: tidy(status.candidate.title) ?? tidy(status.candidate.appName) ?? 'Meeting',
    appName: tidy(status.candidate.appName) ?? 'Seashell',
  } : undefined;
  const sessionId = tidy(status.sessionId, 200), consentId = tidy(status.consentId, 200), warning = tidy(status.warning, 2000);
  try {
    writeFileSync(temporary, JSON.stringify({ phase: status.phase, ...(candidate ? { candidate } : {}),
      ...(sessionId ? { sessionId } : {}), ...(consentId ? { consentId } : {}), ...(warning ? { warning } : {}),
      schemaVersion: 1, pid: process.pid, updatedAtUnixMs: nowUnixMs }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function readBackgroundWatchStatus(libraryDir: string, options: {
  nowUnixMs?: number;
  isAlive?: (pid: number) => boolean;
} = {}): BackgroundWatchStatus | undefined {
  try {
    const path = join(libraryDir, filename);
    if (statSync(path).size > 8192) return;
    const v = JSON.parse(readFileSync(path, 'utf8'));
    if (v.schemaVersion !== 1 || !['watching', 'awaiting-consent', 'recording', 'stopped'].includes(v.phase) ||
        !Number.isSafeInteger(v.pid) || v.pid < 1 || !Number.isSafeInteger(v.updatedAtUnixMs)) return;
    if (v.candidate !== undefined && (!safeText(v.candidate?.id) || !safeText(v.candidate?.title) || !safeText(v.candidate?.appName))) return;
    if (v.sessionId !== undefined && !safeText(v.sessionId, 200)) return;
    if (v.consentId !== undefined && !safeText(v.consentId, 200)) return;
    if (v.warning !== undefined && !safeText(v.warning, 2000)) return;
    const now = options.nowUnixMs ?? Date.now();
    const isAlive = options.isAlive ?? ((pid: number) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
    });
    if (v.phase !== 'stopped' && !isAlive(v.pid)) return {
      schemaVersion: 1, pid: v.pid, updatedAtUnixMs: v.updatedAtUnixMs, phase: 'unavailable',
      warning: 'The background recorder is not responding. Recording status is unconfirmed.',
    };
    if (v.phase !== 'stopped' && (now < v.updatedAtUnixMs || now - v.updatedAtUnixMs > BACKGROUND_WATCH_FRESH_MS)) return {
      schemaVersion: 1, pid: v.pid, updatedAtUnixMs: v.updatedAtUnixMs, phase: 'unavailable', lastPhase: v.phase,
      ...(v.sessionId === undefined ? {} : { sessionId: v.sessionId }),
      ...(v.candidate === undefined ? {} : { candidate: v.candidate }),
      warning: 'The background recorder is busy and has not confirmed its status lately. Recording status is unconfirmed.',
    };
    return v as BackgroundWatchStatus;
  } catch { return; }
}
