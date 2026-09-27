import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readBackgroundMeetingState, readBackgroundMeetingStatus, writeBackgroundMeetingState, backgroundMeetingMessage } from '../src/background-meeting-status.ts';
import { CaptureHealthTracker } from '../src/capture-health.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { listTranscriptRecords, saveTranscriptRecord, trashTranscriptRecord } from '../src/transcript-library.ts';

test('a crashed recorder is shown as interrupted and an active capture cannot be trashed', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-background-state-'));
  try {
    const record = createTranscriptRecord({ transcript: [], speakers: [] });
    const { directory } = saveTranscriptRecord(root, record);
    writeBackgroundMeetingState(directory, 'recording');
    expect(() => trashTranscriptRecord(root, record.id)).toThrow('still recording');
    expect(backgroundMeetingMessage(readBackgroundMeetingState(directory))).toContain('Live text updates');
    writeFileSync(join(directory, 'background-capture.json'), JSON.stringify({ state: 'recording', pid: 99999999 }));
    expect(readBackgroundMeetingState(directory)).toBe('interrupted');
    expect(backgroundMeetingMessage(readBackgroundMeetingState(directory))).toContain('recover');
    expect(trashTranscriptRecord(root, record.id)).toContain('_Trash');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('saved health and durable progress survive processing, ready and legacy state reader compatibility', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-background-health-'));
  try {
    const record = createTranscriptRecord({ transcript: [], speakers: [] });
    const { directory } = saveTranscriptRecord(root, record);
    const health = new CaptureHealthTracker({ nowUnixMs: 1 });
    health.state('microphone', { state: 'unavailable', message: 'Input stopped delivering samples' }, 2);
    health.stop(3);
    writeBackgroundMeetingState(directory, 'recording', { captureHealth: health.snapshot, audioSavedThroughMs: 12000,
      draftStatus: { stage: 'delayed', detail: 'Transcript catching up', queueDepth: 3 } });
    writeBackgroundMeetingState(directory, 'processing');
    writeBackgroundMeetingState(directory, 'ready');
    expect(readBackgroundMeetingState(directory)).toBe('ready');
    expect(readBackgroundMeetingStatus(directory)).toMatchObject({ state: 'ready', captureHealth: health.snapshot, audioSavedThroughMs: 12000,
      draftStatus: { stage: 'delayed', queueDepth: 3 } });
    expect(listTranscriptRecords(root)[0]?.captureHealth?.microphone.warnings[0]?.kind).toBe('unavailable');
    expect(listTranscriptRecords(root)[0]?.audioSavedThroughMs).toBe(12000);
    writeFileSync(join(directory, 'background-capture.json'), JSON.stringify({ state: 'ready', captureHealth: { bad: true } }));
    expect(readBackgroundMeetingState(directory)).toBe('ready');
    expect(readBackgroundMeetingStatus(directory)?.captureHealth).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
