import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { finalizeCaptureTranscript } from '../src/capture-finalizer.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import type { SpeakerVoice } from '../src/diarize.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { applySpeakerLabels, EvidenceSpeakerLabeler } from '../src/speaker-labeling.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { findTranscriptRecord, renameTranscriptSpeaker, saveTranscriptRecord } from '../src/transcript-library.ts';
import type { TranscriptRecord } from '../src/transcript-types.ts';
import {
  applyVoiceSuggestions, forgetVoiceprint, listVoiceprints, matchKnownVoices, rememberVoice, saveMeetingVoices, voicesDirectory,
} from '../src/voiceprints.ts';

let root = '';
let library = '';
const original = process.env.SEASHELL_VOICES_DIR;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'seashell-voiceprints-'));
  library = join(root, 'Transcripts');
  process.env.SEASHELL_VOICES_DIR = join(root, 'Voices');
});
afterEach(() => {
  if (original === undefined) delete process.env.SEASHELL_VOICES_DIR;
  else process.env.SEASHELL_VOICES_DIR = original;
  rmSync(root, { recursive: true, force: true });
});

/** A made-up voice: mostly one direction, a little of another. */
function voice(main: number, mix = 0, other = (main + 1) % 8, seconds = 30): Pick<SpeakerVoice, 'embedding' | 'seconds'> {
  const embedding = Array.from({ length: 8 }, (_, index) => (index === main ? 1 : index === other ? mix : 0));
  const norm = Math.hypot(...embedding);
  return { embedding: embedding.map((x) => x / norm), seconds };
}

/** A saved two-voice meeting whose voices were kept, as the finalizer does. */
function meeting(id: string, voices: Record<string, Pick<SpeakerVoice, 'embedding' | 'seconds'>>): TranscriptRecord {
  const record = createTranscriptRecord({
    transcript: [
      { start: 0, end: 10, speaker: 'REMOTE_SPEAKER_00', text: 'Shall we start with the budget?' },
      { start: 10, end: 20, speaker: 'REMOTE_SPEAKER_01', text: 'Yes, the numbers came in on Friday.' },
    ],
    speakers: [{ id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' }, { id: 'REMOTE_SPEAKER_01', label: 'Remote speaker 2' }],
  }, { id, title: 'Budget review', now: new Date('2026-11-10T15:00:00Z') });
  saveTranscriptRecord(library, record);
  saveMeetingVoices(id, new Map(Object.entries(voices).map(([speaker, value]) => {
    const start = speaker.endsWith('00') ? 0 : 10;
    return [speaker, { ...value, spans: [[start, start + 10]] }];
  })));
  return record;
}

test('voices live in their own folder, overridable for tests and never the library', () => {
  expect(voicesDirectory({ SEASHELL_VOICES_DIR: '/tmp/v' })).toBe('/tmp/v');
  expect(voicesDirectory({ HOME: '/Users/someone' })).toBe(
    process.platform === 'darwin' ? '/Users/someone/Library/Application Support/Sea Shell/Voices' : '/Users/someone/.local/share/seashell/Voices');
});

test('naming a speaker teaches Sea Shell their voice, and a later meeting suggests the name', () => {
  meeting('m1', { REMOTE_SPEAKER_00: voice(0), REMOTE_SPEAKER_01: voice(3) });
  renameTranscriptSpeaker(library, 'm1', 'REMOTE_SPEAKER_00', 'Ada Example');
  expect(listVoiceprints()).toEqual([{ name: 'Ada Example', meetings: 1 }]);

  const matches = matchKnownVoices(new Map([['REMOTE_SPEAKER_00', voice(5)], ['REMOTE_SPEAKER_01', voice(0, 0.3)]]));
  expect([...matches]).toEqual([['REMOTE_SPEAKER_01', { name: 'Ada Example', similarity: expect.closeTo(0.958, 2) }]]);

  const next = createTranscriptRecord({ transcript: [], speakers: [
    { id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' }, { id: 'REMOTE_SPEAKER_01', label: 'Remote speaker 2' },
  ] }, { id: 'm2' });
  expect(applyVoiceSuggestions(next, matches).speakers).toEqual([
    { id: 'LOCAL', label: 'Microphone' },
    { id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' },
    { id: 'REMOTE_SPEAKER_01', label: 'Ada Example', suggestion: { source: 'voice', previous: 'Remote speaker 2', similarity: 0.958 } },
  ]);
});

test('matching abstains: a distant voice, two people too close to call, a person claimed twice, too little speech', () => {
  meeting('m1', { REMOTE_SPEAKER_00: voice(0), REMOTE_SPEAKER_01: voice(1) });
  renameTranscriptSpeaker(library, 'm1', 'REMOTE_SPEAKER_00', 'Ada');
  renameTranscriptSpeaker(library, 'm1', 'REMOTE_SPEAKER_01', 'Grace');
  // cos 0.6 to Ada: under the 0.7 threshold.
  expect(matchKnownVoices(new Map([['A', voice(0, 1.333, 4)]])).size).toBe(0);
  // Halfway between Ada and Grace: both close, neither clear.
  expect(matchKnownVoices(new Map([['A', voice(0, 1, 1)]])).size).toBe(0);
  // Two voices in one meeting both like Ada: neither gets the name.
  expect(matchKnownVoices(new Map([['A', voice(0, 0.1, 5)], ['B', voice(0, 0.2, 6)]])).size).toBe(0);
  // Under ten seconds of clean speech is too little to judge.
  expect(matchKnownVoices(new Map([['A', voice(0, 0, 1, 6)]])).size).toBe(0);
  expect(matchKnownVoices(new Map([['A', voice(1, 0.1, 6)]])).get('A')?.name).toBe('Grace');
});

test('renaming moves the voice, a number takes it out, and a re-separated meeting teaches nothing', () => {
  meeting('m1', { REMOTE_SPEAKER_00: voice(0), REMOTE_SPEAKER_01: voice(1, 0, 2, 4) });
  renameTranscriptSpeaker(library, 'm1', 'REMOTE_SPEAKER_00', 'Ada');
  renameTranscriptSpeaker(library, 'm1', 'REMOTE_SPEAKER_00', 'Grace');
  expect(listVoiceprints()).toEqual([{ name: 'Grace', meetings: 1 }]);
  renameTranscriptSpeaker(library, 'm1', 'REMOTE_SPEAKER_00', 'Remote speaker 1');
  expect(listVoiceprints()).toEqual([]);
  // Four seconds of speech: named, but not learned.
  renameTranscriptSpeaker(library, 'm1', 'REMOTE_SPEAKER_01', 'Bob');
  expect(listVoiceprints()).toEqual([]);
  // The saved voice came from different turns than this speaker's lines.
  const record = meeting('m2', { REMOTE_SPEAKER_00: voice(0) });
  expect(rememberVoice({ ...record, transcript: record.transcript.map((s) => ({ ...s, speaker: s.speaker === 'REMOTE_SPEAKER_00' ? 'REMOTE_SPEAKER_01' : 'REMOTE_SPEAKER_00' })) },
    'REMOTE_SPEAKER_00', 'Ada')).toBe(false);
  expect(listVoiceprints()).toEqual([]);
});

test('renaming back to the old label undoes a suggestion; renaming accepts it and learns the voice', () => {
  meeting('m1', { REMOTE_SPEAKER_00: voice(0) });
  renameTranscriptSpeaker(library, 'm1', 'REMOTE_SPEAKER_00', 'Ada');
  const record = meeting('m2', { REMOTE_SPEAKER_00: voice(0, 0.2, 5), REMOTE_SPEAKER_01: voice(6) });
  saveTranscriptRecord(library, applyVoiceSuggestions(record, matchKnownVoices(new Map([['REMOTE_SPEAKER_00', voice(0, 0.2, 5)]]))));
  expect(findTranscriptRecord(library, 'm2').record.speakers[0]).toMatchObject({ label: 'Ada', suggestion: { previous: 'Remote speaker 1' } });

  const undone = renameTranscriptSpeaker(library, 'm2', 'REMOTE_SPEAKER_00', 'Remote speaker 1');
  expect(undone.speakers[0]).toEqual({ id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' });
  expect(listVoiceprints()).toEqual([{ name: 'Ada', meetings: 1 }]);

  const accepted = renameTranscriptSpeaker(library, 'm2', 'REMOTE_SPEAKER_00', 'Ada');
  expect(accepted.speakers[0]).toEqual({ id: 'REMOTE_SPEAKER_00', label: 'Ada' });
  expect(listVoiceprints()).toEqual([{ name: 'Ada', meetings: 2 }]);
});

test('forgetting a person deletes their voiceprint and nothing else', () => {
  meeting('m1', { REMOTE_SPEAKER_00: voice(0), REMOTE_SPEAKER_01: voice(1) });
  renameTranscriptSpeaker(library, 'm1', 'REMOTE_SPEAKER_00', 'Ada');
  renameTranscriptSpeaker(library, 'm1', 'REMOTE_SPEAKER_01', 'Grace');
  expect(forgetVoiceprint('ada')).toBe(true);
  expect(forgetVoiceprint('Ada')).toBe(false);
  expect(listVoiceprints()).toEqual([{ name: 'Grace', meetings: 1 }]);
  expect(matchKnownVoices(new Map([['A', voice(0)]])).size).toBe(0);
  expect(findTranscriptRecord(library, 'm1').record.speakers.map((s) => s.label)).toEqual(['Ada', 'Grace']);
  expect(readdirSync(join(root, 'Voices', 'people'))).toHaveLength(1);
});

test('a voice match the meeting\'s own evidence contradicts goes back to its number; one it supports stays', async () => {
  const document = {
    transcript: [{ start: 0, end: 4, speaker: 'REMOTE_SPEAKER_00', text: 'Hi everyone, this is Grace.' }],
    speakers: [{ id: 'REMOTE_SPEAKER_00', label: 'Ada', suggestion: { source: 'voice' as const, previous: 'Remote speaker 1', similarity: 0.8 } }],
  };
  const evidence = { screenshots: [], attendees: [{ name: 'Ada Example' }, { name: 'Grace Example' }] };
  expect((await applySpeakerLabels(document, new EvidenceSpeakerLabeler(), evidence)).speakers)
    .toEqual([{ id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' }]);
  const agreeing = { ...document, transcript: [{ ...document.transcript[0]!, text: 'Hi everyone, this is Ada.' }] };
  expect((await applySpeakerLabels(agreeing, new EvidenceSpeakerLabeler(), evidence)).speakers).toEqual(document.speakers);
  expect((await applySpeakerLabels(document, new EvidenceSpeakerLabeler(), { screenshots: [], attendees: [] })).speakers).toEqual(document.speakers);
});

test('finalizing a call suggests known voices and keeps its voices out of the transcript', async () => {
  meeting('earlier', { REMOTE_SPEAKER_00: voice(2) });
  renameTranscriptSpeaker(library, 'earlier', 'REMOTE_SPEAKER_00', 'Ada');

  const store = new CaptureSessionStore({ libraryDir: library, sessionId: 'call', startedAtUnixMs: 1 });
  const pcm = Buffer.alloc(64_000);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(Math.round(3000 * Math.sin(offset / 5)), offset);
  writeFileSync(join(root, 'system.wav'), pcmS16leToWav(pcm));
  store.commitChunk({ sourcePath: join(root, 'system.wav'), trackId: 'system-audio', startSeconds: 0, endSeconds: 2, audible: true });
  const record = await finalizeCaptureTranscript(store.manifestPath, {
    diarizeSystemAudio: true, strictSpeakers: true,
    systemDiarizer: async (_path, options) => {
      options.onVoices?.(new Map([
        ['A', { ...voice(2, 0.25, 7), spans: [[0, 1]] }],
        ['B', { ...voice(4), spans: [[1, 2]] }],
      ]));
      return { speakers: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }], transcript: [
        { start: 0.1, end: 0.9, speaker: 'A', text: 'Morning.' },
        { start: 1.1, end: 1.9, speaker: 'B', text: 'Morning, all.' },
      ] };
    },
  });
  expect(record.speakers).toEqual([
    { id: 'REMOTE_A', label: 'Ada', suggestion: { source: 'voice', previous: 'Remote speaker 1', similarity: expect.any(Number) } },
    { id: 'REMOTE_B', label: 'Remote speaker 2' },
  ]);
  expect(JSON.stringify(record)).not.toContain('embedding');
  const kept = JSON.parse(readFileSync(join(root, 'Voices', 'meetings', 'call.json'), 'utf8'));
  expect(Object.keys(kept.voices)).toEqual(['REMOTE_A', 'REMOTE_B']);
  expect(existsSync(join(library, 'Voices'))).toBe(false);
});
