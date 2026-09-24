import { randomUUID } from 'crypto';
import { readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

export type BackgroundMeetingState = 'recording' | 'processing' | 'ready' | 'failed' | 'interrupted';

/** Small UI projection; the capture journal remains the audio authority. */
export function writeBackgroundMeetingState(directory: string, state: BackgroundMeetingState): void {
  const path = join(directory, 'background-capture.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ state, pid: process.pid }), { mode: 0o600 });
  renameSync(temporary, path);
}

export function readBackgroundMeetingState(directory: string): BackgroundMeetingState | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'background-capture.json'), 'utf8'));
    if (!['recording', 'processing', 'ready', 'failed', 'interrupted'].includes(value.state)) return;
    if (value.state === 'recording' || value.state === 'processing') {
      if (!Number.isSafeInteger(value.pid) || value.pid < 1) return 'interrupted';
      try { process.kill(value.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return 'interrupted'; }
    }
    return value.state;
  } catch { return undefined; }
}

export function backgroundMeetingMessage(state?: BackgroundMeetingState): string | undefined {
  switch (state) {
    case 'recording': return 'Recording in the background. Your transcript will appear after you leave the meeting.';
    case 'processing': return 'Meeting ended · preparing your transcript and notes. The next meeting can record now.';
    case 'failed': case 'interrupted': return 'Capture needs attention · run seashell capture list to recover saved audio.';
    default: return undefined;
  }
}
