import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { CaptureSessionStore } from '../src/capture-session.ts';
import type { runHumainMeeting } from '../src/humain-client.ts';
import { createMeetingArtifact, loadMeetingArtifact, MeetingAiOffError, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { askDuringCall, catchUpQuestion, chatWithMeeting, claimsForHumain, enrichMeeting } from '../src/meeting-enrichment.ts';
import { FROM_YOUR_NOTES, meetingViewLines } from '../src/meeting-tui.ts';
import {
  addMeetingNote,
  addRecordingNote,
  carryCaptureNotes,
  consumeNoteCommands,
  meetingOwnerNotes,
  noteText,
  readBundleNotes,
  recordingBundle,
  writeNoteCommand,
} from '../src/owner-notes.ts';
import { findTranscriptRecord, saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const route = { backend: 'codex' as const, model: 'fixture' };
const rev4 = async () => new Set(['observe', 'reconcile', 'chat', 'extract', 'brief', 'draft']);
const rev3 = async () => new Set(['observe', 'reconcile', 'chat', 'extract']);

function library() {
  const home = mkdtempSync(join(tmpdir(), 'seashell-owner-notes-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const record = createTranscriptRecord({
    transcript: [
      { start: 0, end: 4, speaker: 'REMOTE_00', text: 'We can start the pilot in November.' },
      { start: 4, end: 8, speaker: 'LOCAL', text: 'I will send the security summary.' },
    ],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_00', label: 'Remote speaker 1' }],
  }, { id: 'design-review', title: 'Design review', now: new Date('2026-11-10T15:00:00Z') });
  saveTranscriptRecord(root, record);
  saveMeetingArtifact(root, createMeetingArtifact(record));
  return { home, root, record };
}

/** A recording still in progress: its bundle under _Capture, its clock started at 15:00. */
function recording(root: string, id = 'design-review') {
  return new CaptureSessionStore({ libraryDir: root, sessionId: id, startedAtUnixMs: Date.parse('2026-11-10T15:00:00Z') });
}

/** A fake Humain that records requests and answers reconcile with what it is given. */
function fake(output: (request: any) => unknown) {
  const requests: any[] = [];
  const runner: typeof runHumainMeeting = async (action, request) => {
    requests.push({ action, ...(request as object) });
    return { runId: `run-${requests.length}`, compiledRunId: 'c', status: 'succeeded', receipt: {}, output: output(request) };
  };
  return { requests, runner };
}

test('a note is one line of text, up to 2,000 characters', () => {
  expect(noteText('  Dana sounded\nunsure  ')).toBe('Dana sounded unsure');
  expect(() => noteText('   ')).toThrow('A note needs some text.');
  expect(() => noteText('x'.repeat(2_001))).toThrow('up to 2,000 characters');
});

test('during a call a note is kept beside the audio, on the call\'s clock, and survives a crash', () => {
  const { root } = library();
  const store = recording(root);
  expect(recordingBundle(root, 'design-review')).toBe(store.root);
  // Typed 2 min 5 s into the call; saved later does not move it.
  const note = addRecordingNote(store.root, 'Dana sounded unsure about November', Date.parse('2026-11-10T15:02:05Z'));
  expect(note).toMatchObject({ text: 'Dana sounded unsure about November', at: 125 });
  // A torn last line, as a crash mid-write leaves, does not lose the notes before it.
  appendFileSync(join(store.root, 'owner-notes.jsonl'), '{"id":"n-torn","te');
  expect(readBundleNotes(store.root).map((saved) => saved.text)).toEqual(['Dana sounded unsure about November']);
  expect(meetingOwnerNotes(root, 'design-review').map((saved) => saved.at)).toEqual([125]);
});

test('when the meeting is saved its notes move into meeting.json, once, and the readable copy says them', () => {
  const { root, record } = library();
  const store = recording(root);
  addRecordingNote(store.root, 'Ask about the Canada question', Date.parse('2026-11-10T15:00:20Z'));
  store.setStatus('completed', 'test');
  const { path } = findTranscriptRecord(root, record.id);
  store.attachTo(dirname(path));
  expect(carryCaptureNotes(root, record.id)?.ownerNotes?.map((note) => note.text)).toEqual(['Ask about the Canada question']);
  expect(carryCaptureNotes(root, record.id)?.ownerNotes).toHaveLength(1);
  expect(readFileSync(join(dirname(path), 'documents', 'your-notes.md'), 'utf8')).toContain('- 00:20 Ask about the Canada question');
});

test('after the call a note joins meeting.json, at a moment or about the whole meeting', () => {
  const { root, record } = library();
  addMeetingNote(root, record.id, 'Send Priya the admin guide');
  addMeetingNote(root, record.id, 'This is where the date moved', { at: 4 });
  expect(loadMeetingArtifact(root, record.id)?.ownerNotes?.map((note) => [note.at, note.text]))
    .toEqual([[4, 'This is where the date moved'], [undefined, 'Send Priya the admin guide']]);
  expect(() => addMeetingNote(root, record.id, 'Late', { at: 3_600 })).not.toThrow();
});

test('notes from a terminal wait as one file each, are read once, and an old one is dropped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'seashell-note-commands-'));
  roots.push(directory);
  writeNoteCommand('First', 1_000_000, directory);
  writeNoteCommand('Second', 1_000_500, directory);
  writeNoteCommand('Stale', 1_000_000 - 11 * 60_000, directory);
  // Ten minutes is the most a recorder can lag; the stale one is gone either way.
  expect(consumeNoteCommands(directory, 1_001_000)).toEqual([{ text: 'First', createdAtUnixMs: 1_000_000 }, { text: 'Second', createdAtUnixMs: 1_000_500 }]);
  expect(consumeNoteCommands(directory, 1_001_000)).toEqual([]);
});

test('final notes read your notes, and a point from them may cite no transcript', async () => {
  const { root, record } = library();
  addMeetingNote(root, record.id, 'Check the Canada question before kickoff', { at: 2 });
  const noteId = loadMeetingArtifact(root, record.id)!.ownerNotes![0]!.id;
  const humain = fake(() => ({ summary: 'Pilot in November.', claims: [
    { id: 'c1', type: 'follow_up', text: 'Check the Canada question before kickoff.', evidenceSegmentIds: [], ownerNoteIds: [noteId], confidence: 0.8 },
    { id: 'c2', type: 'decision', text: 'Pilot in November.', evidenceSegmentIds: ['s000001'], confidence: 0.9 },
  ] }));
  const artifact = await enrichMeeting(root, record.id, { mode: 'post-session', route, runner: humain.runner, engine: rev4, instructions: null });
  expect(humain.requests[0].ownerNotes).toEqual([{ id: noteId, text: 'Check the Canada question before kickoff', at: 2 }]);
  expect(artifact.analysis?.claims[0]?.ownerNoteIds).toEqual([noteId]);
  // Sent back to Humain, a point only your notes support stays home; the rest lose the field.
  expect(claimsForHumain(artifact.analysis!.claims)).toEqual([{ id: 'c2', type: 'decision', text: 'Pilot in November.', evidenceSegmentIds: ['s000001'], confidence: 0.9 }]);
  // ✎ leads the time on the right; the note's own time places a point with no transcript to cite.
  const lines = meetingViewLines(artifact, 'notes', record);
  expect(lines).toContain(`- Check the Canada question before kickoff.\t\t${FROM_YOUR_NOTES} 00:02`);
  expect(lines).not.toContain('Your notes');
});

test('a point citing a note that was not sent, or nothing at all, is refused', async () => {
  const { root, record } = library();
  addMeetingNote(root, record.id, 'A note');
  for (const claim of [
    { id: 'c1', type: 'note', text: 'Invented.', evidenceSegmentIds: [], ownerNoteIds: ['n-nope'], confidence: 0.5 },
    { id: 'c1', type: 'note', text: 'Uncited.', evidenceSegmentIds: [], confidence: 0.5 },
  ]) {
    const humain = fake(() => ({ summary: 'S', claims: [claim] }));
    await expect(enrichMeeting(root, record.id, { mode: 'post-session', route, runner: humain.runner, engine: rev4, instructions: null }))
      .rejects.toThrow(/cites (missing owner note n-nope|nothing)/u);
  }
});

test('an engine before revision 4 is sent no notes and no vocabulary, and the notes say so', async () => {
  const { root, record } = library();
  const vocabulary = process.env.SEASHELL_VOCABULARY_FILE!;
  mkdirSync(dirname(vocabulary), { recursive: true });
  writeFileSync(vocabulary, 'Priya Raman\n');
  try {
    addMeetingNote(root, record.id, 'Dana sounded unsure', { at: 1 });
    const older = fake(() => ({ summary: 'S', claims: [] }));
    const statuses: string[] = [];
    const artifact = await enrichMeeting(root, record.id, { mode: 'post-session', route, runner: older.runner, engine: rev3, onStatus: (status) => statuses.push(status) });
    expect(older.requests[0].ownerNotes).toBeUndefined();
    expect(older.requests[0].instructions?.vocabulary).toBeUndefined();
    expect(statuses).toContain('Your notes are kept, but this AI engine cannot read them. Install a newer AI engine: seashell ai install <humain-package.tgz>');
    expect(artifact.analysis?.ownerNotesUnread).toBe(true);
    const lines = meetingViewLines(artifact, 'notes', record);
    expect(lines.slice(lines.indexOf('# Your notes'))).toEqual(['# Your notes', '- Dana sounded unsure\t\t00:01',
      'The AI engine that wrote these notes could not read yours. Install a newer AI engine: seashell ai install <humain-package.tgz>']);
    // A current engine gets both.
    const current = fake(() => ({ summary: 'S', claims: [] }));
    await enrichMeeting(root, record.id, { mode: 'post-session', route, runner: current.runner, engine: rev4 });
    expect(current.requests[0].instructions.vocabulary).toEqual(['Priya Raman']);
    expect(current.requests[0].ownerNotes).toHaveLength(1);
  } finally { rmSync(vocabulary, { force: true }); }
});

test('a private meeting keeps your notes and shows them, and sends nothing', async () => {
  const { root, record } = library();
  addMeetingNote(root, record.id, 'Only for me');
  saveMeetingArtifact(root, { ...loadMeetingArtifact(root, record.id)!, ai: { off: true } });
  const humain = fake(() => ({}));
  await expect(enrichMeeting(root, record.id, { mode: 'post-session', route, runner: humain.runner, engine: rev4 })).rejects.toThrow(MeetingAiOffError);
  await expect(askDuringCall(root, record.id, 'What did I miss?', route, { runner: humain.runner, engine: rev4 })).rejects.toThrow(MeetingAiOffError);
  expect(humain.requests).toEqual([]);
  expect(meetingViewLines(loadMeetingArtifact(root, record.id)!, 'notes', record).slice(-2)).toEqual(['# Your notes', '- Only for me']);
});

test('during the call, the Notes view lists your notes and says when the notes come', () => {
  const { root, record } = library();
  const store = recording(root);
  addRecordingNote(store.root, 'Dana sounded unsure', Date.parse('2026-11-10T15:00:03Z'));
  const artifact = loadMeetingArtifact(root, record.id)!;
  expect(meetingViewLines(artifact, 'notes', record, meetingOwnerNotes(root, record.id, artifact), true))
    .toEqual(['Notes are written when the call ends.', '', '# Your notes', '- Dana sounded unsure\t\t00:03']);
});

test('a question during the call reads the transcript so far, is marked partial, and saves nothing', async () => {
  const { root, record } = library();
  const humain = fake(() => ({ answer: 'They want to start in November.', evidenceSegmentIds: ['s000001'] }));
  const catchUp = catchUpQuestion(20 * 60, 12 * 60);
  expect(catchUp.from).toBe(12 * 60);
  expect(catchUp.question).toStartWith('What did I miss? Cover what was said from 12:00 to 20:00');
  // Looking a minute ago still covers the last five minutes.
  expect(catchUpQuestion(20 * 60, 19 * 60).from).toBe(15 * 60);
  const answer = await askDuringCall(root, record.id, catchUp.question, route, { runner: humain.runner, engine: rev4 });
  expect(humain.requests[0]).toMatchObject({ action: 'chat', partial: true, question: catchUp.question });
  expect(humain.requests[0].segments).toHaveLength(2);
  expect(answer).toEqual({ question: catchUp.question, answer: 'They want to start in November.',
    moments: [{ id: 's000001', start: 0, speakerId: 'REMOTE_00', speaker: 'Remote speaker 1', text: 'We can start the pilot in November.' }] });
  expect(loadMeetingArtifact(root, record.id)?.chat).toEqual([]);
  // Asked after the call, chat is not partial and is saved.
  const after = fake(() => ({ answer: 'November.', evidenceSegmentIds: [] }));
  await chatWithMeeting(root, record.id, 'When?', route, undefined, after.runner, rev4);
  expect(after.requests[0].partial).toBeUndefined();
  expect(loadMeetingArtifact(root, record.id)?.chat).toHaveLength(2);
});
