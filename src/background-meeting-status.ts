import { randomUUID } from 'crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseCaptureHealth, type CaptureHealthSnapshot } from './capture-health.ts';

export type BackgroundMeetingState = 'recording' | 'processing' | 'ready' | 'failed' | 'interrupted';
export interface BackgroundDraftStatus {
  readonly stage: 'waiting' | 'transcribing' | 'live' | 'delayed' | 'stopped';
  readonly detail: string;
  readonly queueDepth: number;
}
export interface BackgroundMeetingStatus {
  readonly state: BackgroundMeetingState;
  readonly pid?: number;
  readonly updatedAtUnixMs?: number;
  readonly captureHealth?: CaptureHealthSnapshot;
  readonly audioSavedThroughMs?: number;
  readonly draftStatus?: BackgroundDraftStatus;
}
export type BackgroundMeetingStatusOptions = Pick<BackgroundMeetingStatus, 'captureHealth' | 'audioSavedThroughMs' | 'draftStatus'>;

/** Small UI projection; the capture journal remains the audio authority. */
export function writeBackgroundMeetingState(directory: string, state: BackgroundMeetingState, options: BackgroundMeetingStatusOptions = {}): void {
  const path = join(directory, 'background-capture.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const previous = readBackgroundMeetingStatus(directory);
  try {
    writeFileSync(temporary, JSON.stringify({ ...previous, ...options, state, pid: process.pid, updatedAtUnixMs: Date.now() }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function readBackgroundMeetingStatus(directory: string): BackgroundMeetingStatus | undefined {
  try {
    const path = join(directory, 'background-capture.json');
    if (statSync(path).size > 16_384) return;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!['recording', 'processing', 'ready', 'failed', 'interrupted'].includes(value.state)) return;
    let state: BackgroundMeetingState = value.state;
    if (value.state === 'recording' || value.state === 'processing') {
      if (!Number.isSafeInteger(value.pid) || value.pid < 1) state = 'interrupted';
      else try { process.kill(value.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') state = 'interrupted'; }
    }
    const health = parseCaptureHealth(value.captureHealth);
    const draft = value.draftStatus;
    const draftValid = draft && ['waiting', 'transcribing', 'live', 'delayed', 'stopped'].includes(draft.stage) &&
      typeof draft.detail === 'string' && draft.detail.length <= 1000 && !/[\p{Cc}\p{Cf}]/u.test(draft.detail) &&
      Number.isSafeInteger(draft.queueDepth) && draft.queueDepth >= 0 && draft.queueDepth <= 1000;
    return { state,
      ...(Number.isSafeInteger(value.pid) && value.pid > 0 ? { pid: value.pid } : {}),
      ...(Number.isSafeInteger(value.updatedAtUnixMs) && value.updatedAtUnixMs >= 0 ? { updatedAtUnixMs: value.updatedAtUnixMs } : {}),
      ...(health ? { captureHealth: health } : {}),
      ...(Number.isSafeInteger(value.audioSavedThroughMs) && value.audioSavedThroughMs >= 0 ? { audioSavedThroughMs: value.audioSavedThroughMs } : {}),
      ...(draftValid ? { draftStatus: { stage: draft.stage, detail: draft.detail, queueDepth: draft.queueDepth } } : {}),
    };
  } catch { return undefined; }
}

export function readBackgroundMeetingState(directory: string): BackgroundMeetingState | undefined {
  return readBackgroundMeetingStatus(directory)?.state;
}

export function backgroundMeetingMessage(state?: BackgroundMeetingState): string | undefined {
  switch (state) {
    case 'recording': return 'Recording in the background. Live text updates as speech is processed; the final transcript follows after the meeting.';
    case 'processing': return 'Meeting ended · preparing your transcript and notes. The next meeting can record now.';
    case 'failed': case 'interrupted': return 'Capture needs attention · run seashell capture list to recover saved audio.';
    default: return undefined;
  }
}
