import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { compareLines, compareSavedSpeakers, renderComparisonPage } from '../src/speaker-compare.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import type { TranscriptSegment } from '../src/transcript-types.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const line = (start: number, end: number, speaker: string, text = `line at ${start}`): TranscriptSegment => ({ start, end, speaker, text });
const labels = new Map([['REMOTE_00', 'Remote speaker 1'], ['REMOTE_01', 'Remote speaker 2']]);

test('a new engine with different ids but the same voices disagrees on nothing', () => {
  const result = compareLines(
    [line(0, 2, 'REMOTE_00'), line(3, 5, 'REMOTE_01'), line(6, 8, 'REMOTE_00')],
    [{ start: 0, end: 2, speaker: 'B' }, { start: 3, end: 5, speaker: 'A' }, { start: 6, end: 8, speaker: 'B' }],
  );
  expect(result).toMatchObject({ currentVoices: 2, proposedVoices: 2, lines: 3, changedLines: 0, disagreements: [] });
});

test('the microphone is never judged, because it is known to be you', () => {
  const result = compareLines([line(0, 2, 'LOCAL'), line(3, 5, 'REMOTE_00')], [{ start: 0, end: 5, speaker: 'A' }]);
  expect(result).toMatchObject({ lines: 1, currentVoices: 1, changedLines: 0 });
});

test('a line moved to another voice shows both names', () => {
  const result = compareLines(
    [line(0, 10, 'REMOTE_00'), line(11, 20, 'REMOTE_01'), line(21, 23, 'REMOTE_00', 'moved')],
    [{ start: 0, end: 10, speaker: 'A' }, { start: 11, end: 20, speaker: 'B' }, { start: 21, end: 23, speaker: 'B' }],
    labels,
  );
  expect(result.changedLines).toBe(1);
  expect(result.disagreements[0]).toMatchObject({ text: 'moved', current: 'Remote speaker 1', proposed: 'Remote speaker 2' });
});

test('a person the saved transcript merged into someone else appears as a new voice', () => {
  const result = compareLines(
    [line(0, 10, 'REMOTE_00'), line(11, 13, 'REMOTE_00', 'quiet colleague')],
    [{ start: 0, end: 10, speaker: 'A' }, { start: 11, end: 13, speaker: 'B' }],
    labels,
  );
  expect(result).toMatchObject({ currentVoices: 1, proposedVoices: 2, changedLines: 1 });
  expect(result.disagreements[0]).toMatchObject({ current: 'Remote speaker 1', proposed: 'New voice 1' });
});

test('a line saved as unknown is no extra person and no disagreement', () => {
  const result = compareLines(
    [line(0, 5, 'REMOTE_00'), line(6, 8, 'REMOTE_UNKNOWN')],
    [{ start: 0, end: 5, speaker: 'A' }, { start: 6, end: 8, speaker: 'B' }],
  );
  expect(result).toMatchObject({ currentVoices: 1, proposedVoices: 1, lines: 1, changedLines: 0 });
});

test('a line no voice is near stays out of the count rather than reading as a change', () => {
  const result = compareLines([line(0, 2, 'REMOTE_00'), line(30, 31, 'REMOTE_00')], [{ start: 0, end: 2, speaker: 'A' }]);
  expect(result).toMatchObject({ lines: 2, changedLines: 0 });
});

test('the page escapes what was said', () => {
  const page = renderComparisonPage({
    skipped: { private: 0, noAudio: 0 },
    meetings: [{
      id: 'm', title: '<b>Sync</b>', createdAt: '', currentVoices: 1, proposedVoices: 2, lines: 2, changedLines: 1,
      disagreements: [{ start: 1, end: 2, text: '<script>alert(1)</script>', current: 'A', proposed: 'B', clip: 'clips/m-1.wav' }],
    }],
  });
  expect(page).not.toContain('<script>alert');
  expect(page).not.toContain('<b>Sync');
  expect(page).toContain('clips/m-1.wav');
});

/** A saved meeting with one second of captured system audio per chunk. */
function savedMeeting(library: string, aiOff = false) {
  const record = createTranscriptRecord({
    transcript: [line(0, 0.5, 'REMOTE_00'), line(0.5, 1, 'REMOTE_01', 'moved')],
    speakers: [{ id: 'REMOTE_00', label: 'Remote speaker 1' }, { id: 'REMOTE_01', label: 'Remote speaker 2' }],
  }, { title: 'Demo call', source: { kind: 'file' } as never });
  const { directory } = saveTranscriptRecord(library, record);
  if (aiOff) writeFileSync(join(directory, 'meeting.json'), JSON.stringify({ ai: { off: true } }));
  return { record, directory };
}

test('no capture on disk means no comparison, and nothing is written', async () => {
  const library = mkdtempSync(join(tmpdir(), 'seashell-compare-'));
  directories.push(library);
  mkdirSync(library, { recursive: true });
  savedMeeting(library);
  const report = await compareSavedSpeakers(library, { separate: async () => { throw new Error('should not run'); } });
  expect(report.meetings).toEqual([]);
  expect(report.skipped.noAudio).toBe(1);
  expect(existsSync(join(library, '_speaker-comparison'))).toBe(false);
});

test('a private meeting is left alone', async () => {
  const library = mkdtempSync(join(tmpdir(), 'seashell-compare-'));
  directories.push(library);
  savedMeeting(library, true);
  const report = await compareSavedSpeakers(library, { separate: async () => { throw new Error('should not run'); } });
  expect(report.skipped.private).toBe(1);
});
