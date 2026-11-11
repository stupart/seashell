import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { createMeetingArtifact, loadMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { meetingEvidence } from '../src/meeting-evidence.ts';
import { meetingViewLines } from '../src/meeting-tui.ts';
import { cleanPhantoms, editTranscriptSegment, renameMeetingSpeaker } from '../src/transcript-edits.ts';
import { findTranscriptRecord, renameTranscriptSpeaker, saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { listVoiceprints, saveMeetingVoices } from '../src/voiceprints.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function library() {
  const home = mkdtempSync(join(tmpdir(), 'seashell-edits-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const record = createTranscriptRecord({
    transcript: [
      { start: 1, end: 2, text: 'Thank you.', speaker: 'LOCAL' },
      { start: 6, end: 8, text: 'We ship on Fryday.', speaker: 'LOCAL' },
      { start: 2, end: 3, text: 'Okay.', speaker: 'REMOTE_SPEAKER_00' },
      { start: 9, end: 9.5, text: 'Sure.', speaker: 'REMOTE_SPEAKER_00' },
    ],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' }],
  }, { id: 'standup', now: new Date('2026-10-02T09:00:00Z'), title: 'Standup' });
  saveTranscriptRecord(root, record);
  saveMeetingArtifact(root, { ...createMeetingArtifact(record), status: 'ready', analysis: {
    final: true, summary: 'Remote speaker 1 agreed to ship Friday.', runId: 'r', createdAt: '2026-10-02T09:30:00Z',
    claims: [{ id: 'd', type: 'decision', text: 'Ship on Friday.', evidenceSegmentIds: ['s000002'], confidence: 0.9 }],
  } });
  const directory = dirname(findTranscriptRecord(root, record.id).path);
  return { root, record, directory };
}

test('fixing a line keeps the notes, marks them possibly out of date, and keeps the old transcript', () => {
  const { root, record, directory } = library();
  expect(editTranscriptSegment(root, record.id, 's000002', '  We ship on   Friday. ')).toEqual({
    id: record.id, segmentId: 's000002', before: 'We ship on Fryday.', after: 'We ship on Friday.' });
  const { record: saved } = findTranscriptRecord(root, record.id);
  expect(saved.transcript[1]!.text).toBe('We ship on Friday.');
  const artifact = loadMeetingArtifact(root, record.id)!;
  expect(artifact.analysis?.claims[0]?.text).toBe('Ship on Friday.');
  expect(artifact.notesOutdated?.reason).toBe('A transcript line was corrected');
  expect(artifact.transcriptEvidence?.revision).toBe(meetingEvidence(saved).revision);
  const history = readdirSync(join(directory, 'history', 'transcripts'));
  expect(history).toHaveLength(1);
  expect(readFileSync(join(directory, 'history', 'transcripts', history[0]!), 'utf8')).toContain('Fryday');
  // The Notes view says so, in place of offering to throw them away.
  expect(meetingViewLines(artifact, 'notes', saved).at(-1)).toBe('A transcript line was corrected after these notes were written, so they may be out of date. Press g to rewrite them.');
  expect(() => editTranscriptSegment(root, record.id, 's000099', 'x')).toThrow('Segment s000099 is not in this meeting');
  expect(() => editTranscriptSegment(root, record.id, 's000002', '  ')).toThrow('empty');
});

test('a speaker can be named by their current label, and the notes take the name', () => {
  const { root, record } = library();
  expect(renameMeetingSpeaker(root, record.id, 'remote speaker 1', 'Dana')).toEqual({ id: record.id, speakerId: 'REMOTE_SPEAKER_00', from: 'Remote speaker 1', to: 'Dana' });
  const artifact = loadMeetingArtifact(root, record.id)!;
  expect(artifact.analysis?.summary).toBe('Dana agreed to ship Friday.');
  expect(artifact.notesOutdated).toBeUndefined();
  expect(() => renameMeetingSpeaker(root, record.id, 'Nobody', 'X')).toThrow('No speaker "Nobody"');
});

/** 10 s of 16 kHz mono: silence, except a loud tone from `loudFrom` seconds. */
function wav(path: string, loudFrom: number): string {
  const pcm = Buffer.alloc(16_000 * 2 * 10);
  for (let offset = loudFrom * 32_000; offset < pcm.length; offset += 2) pcm.writeInt16LE(Math.round(8_000 * Math.sin(offset / 6)), offset);
  writeFileSync(path, pcmS16leToWav(pcm));
  return path;
}

function attachCapture(root: string, id: string, directory: string, systemLoudFrom: number) {
  const scratch = mkdtempSync(join(tmpdir(), 'seashell-edits-audio-'));
  roots.push(scratch);
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: id, startedAtUnixMs: 1 });
  store.commitChunk({ sourcePath: wav(join(scratch, 'mic.wav'), 5), trackId: 'microphone', startSeconds: 0, endSeconds: 10, audible: true });
  store.commitChunk({ sourcePath: wav(join(scratch, 'system.wav'), systemLoudFrom), trackId: 'system-audio', startSeconds: 0, endSeconds: 10, audible: true });
  store.setStatus('completed', 'test');
  store.attachTo(directory);
}

test('clean-phantoms finds lines heard in silence, on each line\'s own source, and removes them only when asked', async () => {
  const { root, record, directory } = library();
  // Computer audio is loud from the start, so its lines are never phantom even without detected speech.
  attachCapture(root, record.id, directory, 0);
  // Speech detected only in the loud part of each track.
  const detect = async (path: string) => path.endsWith('microphone.wav') ? [{ start: 5.2, end: 10 }] : [{ start: 8.8, end: 10 }];

  const dry = await cleanPhantoms(root, { dryRun: true, detect });
  expect(dry).toEqual([{ id: record.id, title: 'Standup', segments: 4, phantoms: 1, removed: false }]);
  expect(findTranscriptRecord(root, record.id).record.transcript).toHaveLength(4);
  expect(existsSync(join(directory, 'history', 'transcripts'))).toBeFalse();

  const done = await cleanPhantoms(root, { detect });
  expect(done).toEqual([{ id: record.id, title: 'Standup', segments: 4, phantoms: 1, removed: true }]);
  const { record: saved } = findTranscriptRecord(root, record.id);
  expect(saved.transcript.map((segment) => [segment.id, segment.text])).toEqual([
    ['s000002', 'We ship on Fryday.'], ['s000003', 'Okay.'], ['s000004', 'Sure.']]);
  // The decision still cites the line it cited, and the notes stay.
  const artifact = loadMeetingArtifact(root, record.id)!;
  expect(artifact.analysis?.claims[0]?.evidenceSegmentIds).toEqual(['s000002']);
  expect(artifact.notesOutdated?.reason).toBe('Lines heard in silence were removed');
  expect(readdirSync(join(directory, 'history', 'transcripts'))).toHaveLength(1);
  // A second pass finds nothing more.
  expect((await cleanPhantoms(root, { detect }))[0]?.phantoms).toBe(0);
});

test('clean-phantoms leaves meetings alone without saved audio or speech detection', async () => {
  const { root, record, directory } = library();
  expect(await cleanPhantoms(root, { dryRun: true, detect: async () => [] })).toEqual([
    { id: record.id, title: 'Standup', segments: 4, phantoms: 0, removed: false, skipped: 'no saved audio' }]);
  attachCapture(root, record.id, directory, 0);
  expect((await cleanPhantoms(root, { detect: async () => undefined }))[0]?.skipped).toBe('speech detection is not available');
  expect(findTranscriptRecord(root, record.id).record.transcript).toHaveLength(4);
  await expect(cleanPhantoms(root, { ids: ['nope'] })).rejects.toThrow('Transcript not found: nope');
});

test('a speaker an agent names keeps the old transcript in history and teaches no voice', () => {
  const { root, record, directory } = library();
  const voices = mkdtempSync(join(tmpdir(), 'seashell-edit-voices-'));
  roots.push(voices);
  const original = process.env.SEASHELL_VOICES_DIR;
  process.env.SEASHELL_VOICES_DIR = voices;
  try {
    // A long, clean voice for the speaker, as the finalizer keeps it: a name would normally teach it.
    saveMeetingVoices(record.id, new Map([['REMOTE_SPEAKER_00', { embedding: [1, 0, 0, 0], seconds: 30, spans: [[0, 10]] }]]));
    renameMeetingSpeaker(root, record.id, 'Remote speaker 1', 'Dana');
    expect(listVoiceprints()).toEqual([]);
    const history = readdirSync(join(directory, 'history', 'transcripts'));
    expect(history).toEqual([expect.stringContaining('renamed-speaker')]);
    expect(JSON.parse(readFileSync(join(directory, 'history', 'transcripts', history[0]!), 'utf8')).speakers[1].label).toBe('Remote speaker 1');
    // The owner naming the same speaker does teach it.
    renameTranscriptSpeaker(root, record.id, 'REMOTE_SPEAKER_00', 'Dana');
    expect(listVoiceprints()).toEqual([{ name: 'Dana', meetings: 1 }]);
  } finally {
    if (original === undefined) delete process.env.SEASHELL_VOICES_DIR;
    else process.env.SEASHELL_VOICES_DIR = original;
  }
});
