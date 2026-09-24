import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readBackgroundMeetingState, writeBackgroundMeetingState, backgroundMeetingMessage } from '../src/background-meeting-status.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { saveTranscriptRecord, trashTranscriptRecord } from '../src/transcript-library.ts';

test('a crashed recorder is shown as interrupted and an active capture cannot be trashed', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-background-state-'));
  try {
    const record = createTranscriptRecord({ transcript: [], speakers: [] });
    const { directory } = saveTranscriptRecord(root, record);
    writeBackgroundMeetingState(directory, 'recording');
    expect(() => trashTranscriptRecord(root, record.id)).toThrow('still recording');
    expect(backgroundMeetingMessage(readBackgroundMeetingState(directory))).toContain('after you leave');
    writeFileSync(join(directory, 'background-capture.json'), JSON.stringify({ state: 'recording', pid: 99999999 }));
    expect(readBackgroundMeetingState(directory)).toBe('interrupted');
    expect(backgroundMeetingMessage(readBackgroundMeetingState(directory))).toContain('recover');
    expect(trashTranscriptRecord(root, record.id)).toContain('_Trash');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
