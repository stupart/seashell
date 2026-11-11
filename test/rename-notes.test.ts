import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMeetingArtifact, loadMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { getMeeting, getTranscript, queryNotes, searchTranscripts } from '../src/meeting-memory.ts';
import { meetingViewLines } from '../src/meeting-tui.ts';
import { renameMeetingSpeaker } from '../src/transcript-edits.ts';
import { findTranscriptRecord, saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import type { Speaker } from '../src/transcript-types.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// Renaming teaches the voice library; keep it out of the real one.
const voices = process.env.SEASHELL_VOICES_DIR;
beforeAll(() => { process.env.SEASHELL_VOICES_DIR = mkdtempSync(join(tmpdir(), 'seashell-voices-')); });
afterAll(() => {
  rmSync(process.env.SEASHELL_VOICES_DIR!, { recursive: true, force: true });
  if (voices === undefined) delete process.env.SEASHELL_VOICES_DIR; else process.env.SEASHELL_VOICES_DIR = voices;
});

/** A made-up call where Seashell suggested "Dana" for the remote voice, and the notes were written under that name. */
function library(speakers: Speaker[] = [
  { id: 'LOCAL', label: 'Microphone' },
  { id: 'REMOTE_SPEAKER_00', label: 'Dana', suggestion: { source: 'voice', previous: 'Remote speaker 1', similarity: 0.91 } },
]) {
  const home = mkdtempSync(join(tmpdir(), 'seashell-rename-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const record = createTranscriptRecord({
    transcript: [
      { start: 1, end: 3, text: 'Can you send the deck?', speaker: 'LOCAL' },
      { start: 4, end: 7, text: 'I will send it Friday.', speaker: 'REMOTE_SPEAKER_00' },
    ],
    speakers,
  }, { id: 'vendor-call', now: new Date('2026-10-05T15:00:00Z'), title: 'Vendor call' });
  saveTranscriptRecord(root, record);
  saveMeetingArtifact(root, { ...createMeetingArtifact(record), status: 'ready', analysis: {
    final: true, summary: 'Dana will send the deck. Danae from legal was mentioned.', runId: 'r', createdAt: '2026-10-05T16:00:00Z',
    template: 'Dana 1:1',
    claims: [
      { id: 'c1', type: 'action_item', text: 'Dana sends the deck.', person: 'Dana', due: 'Friday', evidenceSegmentIds: ['s000002'], confidence: 0.9, speakerId: 'REMOTE_SPEAKER_00' },
      { id: 'c2', type: 'follow_up', text: 'Check the deck.', person: 'You', evidenceSegmentIds: ['s000001'], confidence: 0.8 },
    ],
    notes: [{ heading: 'Next steps', items: [{ text: 'Dana: the deck by Friday.', evidenceSegmentIds: ['s000002'] }] }],
  } });
  return { root, record };
}

test('undoing a suggested name takes it out of the notes, and says the notes may be out of date', () => {
  const { root, record } = library();
  renameMeetingSpeaker(root, record.id, 'REMOTE_SPEAKER_00', 'Remote speaker 1');
  const artifact = loadMeetingArtifact(root, record.id)!;
  expect(artifact.analysis!.summary).toBe('Remote speaker 1 will send the deck. Danae from legal was mentioned.');
  expect(artifact.analysis!.claims.map((claim) => [claim.text, claim.person])).toEqual([
    ['Remote speaker 1 sends the deck.', 'Remote speaker 1'], ['Check the deck.', 'You']]);
  expect(artifact.analysis!.notes![0]!.items[0]!.text).toBe('Remote speaker 1: the deck by Friday.');
  // Only words in the notes change: the template's name is not a mention of Dana.
  expect(artifact.analysis!.template).toBe('Dana 1:1');
  expect(artifact.notesOutdated?.reason).toBe('Dana was renamed to Remote speaker 1');
  expect(meetingViewLines(artifact, 'notes', findTranscriptRecord(root, record.id).record).at(-1))
    .toBe('Dana was renamed to Remote speaker 1 after these notes were written, so they may be out of date. Press g to rewrite them.');
  expect(queryNotes(root, { person: 'Dana' }).items).toEqual([]);
  expect(getMeeting(root, { id: record.id }).notes.possiblyOutOfDate).toBe('Dana was renamed to Remote speaker 1');
});

test('correcting a real name moves its actions to the new name; naming a placeholder still keeps the notes current', () => {
  const { root, record } = library([{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' }]);
  const artifact = loadMeetingArtifact(root, record.id)!;
  saveMeetingArtifact(root, { ...artifact, analysis: { ...artifact.analysis!, summary: 'Remote speaker 1 will send the deck.' } });
  renameMeetingSpeaker(root, record.id, 'Remote speaker 1', 'Dana');
  expect(loadMeetingArtifact(root, record.id)!.analysis!.summary).toBe('Dana will send the deck.');
  expect(loadMeetingArtifact(root, record.id)!.notesOutdated).toBeUndefined();

  renameMeetingSpeaker(root, record.id, 'Dana', 'Diana');
  const corrected = loadMeetingArtifact(root, record.id)!;
  expect(corrected.analysis!.summary).toBe('Diana will send the deck.');
  expect(corrected.analysis!.claims[0]!.person).toBe('Diana');
  expect(corrected.notesOutdated?.reason).toBe('Dana was renamed to Diana');
  expect(queryNotes(root, { person: 'Diana' }).items.map((item) => item.text)).toEqual(['Diana sends the deck.']);
});

test('a fuller form of the same name changes nothing; a name another speaker shares is only flagged', () => {
  const fuller = library([{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Dana' }]);
  renameMeetingSpeaker(fuller.root, fuller.record.id, 'Dana', 'Dana Lee');
  const same = loadMeetingArtifact(fuller.root, fuller.record.id)!;
  expect(same.analysis!.summary).toBe('Dana will send the deck. Danae from legal was mentioned.');
  expect(same.notesOutdated).toBeUndefined();

  const shared = library([{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Dana' },
    { id: 'REMOTE_SPEAKER_01', label: 'Dana' }]);
  renameMeetingSpeaker(shared.root, shared.record.id, 'REMOTE_SPEAKER_00', 'Sam');
  const flagged = loadMeetingArtifact(shared.root, shared.record.id)!;
  expect(flagged.analysis!.summary).toBe('Dana will send the deck. Danae from legal was mentioned.');
  expect(flagged.analysis!.claims[0]!.person).toBe('Dana');
  expect(flagged.notesOutdated?.reason).toBe('Dana was renamed to Sam');
});

test('agents see which speaker names are only Seashell\'s suggestion', () => {
  const { root, record } = library();
  expect(getMeeting(root, { id: record.id }).speakers).toEqual([
    { id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Dana', suggested: true }]);
  expect(getTranscript(root, { id: record.id }).segments.map((segment) => [segment.speaker, segment.speakerSuggested])).toEqual([
    ['Microphone', undefined], ['Dana', true]]);
  expect(searchTranscripts(root, { query: 'friday' }).matches[0]).toMatchObject({ speaker: 'Dana', speakerSuggested: true });
  // Keeping the name confirms it.
  renameMeetingSpeaker(root, record.id, 'REMOTE_SPEAKER_00', 'Dana');
  expect(getMeeting(root, { id: record.id }).speakers[1]).toEqual({ id: 'REMOTE_SPEAKER_00', label: 'Dana' });
});
