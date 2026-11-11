import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createMeetingArtifact, loadMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { getInsights, getMeeting, getTranscript, listActionItems, listMeetings, queryNotes, searchTranscripts } from '../src/meeting-memory.ts';
import { findTranscriptRecord, listTranscriptRecords, saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** `count` made-up meetings, a day apart, each with a decision and an action. */
function library(count: number) {
  const home = mkdtempSync(join(tmpdir(), 'seashell-reads-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  for (let index = 0; index < count; index += 1) {
    const record = createTranscriptRecord({
      transcript: [
        { start: 1, end: 4, text: `We ship pricing change ${index} on Friday.`, speaker: 'LOCAL' },
        { start: 5, end: 8, text: 'Dana will write the email.', speaker: 'REMOTE_SPEAKER_00' },
      ],
      speakers: [{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Dana' }],
    }, { id: `sync-${index}`, now: new Date(Date.UTC(2026, 8, 1 + index, 15)), title: `Sync ${index}` });
    saveTranscriptRecord(root, record);
    saveMeetingArtifact(root, { ...createMeetingArtifact(record), status: 'ready', analysis: { final: true, summary: `Sync ${index}.`, runId: 'r',
      createdAt: record.createdAt, claims: [
        { id: 'd', type: 'decision', text: 'Ship pricing on Friday.', evidenceSegmentIds: ['s000001'], confidence: 0.9 },
        { id: 'a', type: 'action_item', text: 'Write the email.', person: 'Dana', evidenceSegmentIds: ['s000002'], confidence: 0.9 },
      ] } });
  }
  return root;
}

/** Every file in a meeting's folder, with its bytes and modified time. */
function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory, { recursive: true }).map(String).sort()
    .flatMap((name) => statSync(join(directory, name)).isFile()
      ? [[name, `${statSync(join(directory, name)).mtimeMs}:${readFileSync(join(directory, name), 'utf8')}`]] : []));
}

test('reading the library never writes, even when a meeting\'s notes no longer match its transcript', () => {
  const root = library(2);
  const { path, record } = findTranscriptRecord(root, 'sync-1');
  // The transcript was rewritten (an interrupted save, say) and the notes were not brought along yet.
  writeFileSync(path, `${JSON.stringify({ ...record, transcript: [{ ...record.transcript[0]!, text: 'We ship on Monday.' }, record.transcript[1]] }, null, 2)}\n`);
  const before = snapshot(dirname(path));

  listMeetings(root, { query: 'monday' });
  const meeting = getMeeting(root, { id: 'sync-1' });
  getTranscript(root, { id: 'sync-1' });
  searchTranscripts(root, { query: 'monday' });
  listActionItems(root);
  const notes = queryNotes(root, { person: 'Dana' });
  getInsights(root, { id: 'sync-1' });
  expect(snapshot(dirname(path))).toEqual(before);

  // Readers see what loading for the app would make of it: notes for the old words are not shown as current.
  expect(meeting.notes.status).toBe('none');
  expect(notes.items.map((item) => item.meetingId)).toEqual(['sync-0']);
  expect(loadMeetingArtifact(root, 'sync-1')!.analysis).toBeUndefined();
});

test('a read across the library opens each meeting once, not every transcript for every meeting', () => {
  const root = library(30);
  listTranscriptRecords(root);
  const parse = spyOn(JSON, 'parse');
  try {
    expect(queryNotes(root, { kind: 'actions', person: 'dana', limit: 500 }).items).toHaveLength(30);
    expect(listActionItems(root, { limit: 500 }).items).toHaveLength(30);
    expect(listMeetings(root, { query: 'pricing', limit: 200 }).meetings).toHaveLength(30);
    // A transcript and meeting.json each, and meeting.json again for the privacy check: three per meeting per read.
    expect(parse.mock.calls.length).toBeLessThanOrEqual(3 * 3 * 30);
    parse.mockClear();
    getMeeting(root, { id: 'sync-15' });
    expect(parse.mock.calls.length).toBeLessThanOrEqual(3);
  } finally {
    parse.mockRestore();
  }
});
