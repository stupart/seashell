import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { meetBrowserMatchesApp, meetSpeakerForSegment, parseMeetSnapshot, readMeetSamples, startMeetSpeakerReader, type MeetSample, type MeetSnapshot } from '../src/meet-speakers.ts';
import { finalizeCaptureTranscript, saveFinalizedCapture } from '../src/capture-finalizer.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { parseCliArgs } from '../src/cli-args.ts';
import { loadConfig, updateMeetingConfig } from '../src/config.ts';
import { reconcileLiveEcho } from '../src/live-echo.ts';

const alice = { id: 'MEET_aaaaaaaaaaaaaaaaaaaa', label: 'Alice' };
const bob = { id: 'MEET_bbbbbbbbbbbbbbbbbbbb', label: 'Bob' };
const meeting = '/abc-defg-hij';
const sample = (at: number, speaker = alice): MeetSample => ({ at, meeting, speaker });
const snapshot = (name: string): MeetSnapshot => ({ meeting, joined: true, participants: [
  { id: name, name, self: false, speaking: true },
  { id: 'self', name: 'Local', self: true, speaking: true },
] });
const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

test('speaker hints never bridge overlap, an outage, two people, a changed call, or a name change', () => {
  expect(meetSpeakerForSegment([sample(0), sample(.5), sample(1)], { start: .1, end: .9 })).toEqual(alice);
  for (const samples of [
    [sample(0), { at: .5, meeting }, sample(1)],
    [sample(0), sample(10)],
    [sample(0), sample(.5), sample(1, bob), sample(1.5, bob)],
    [sample(0), { ...sample(1), meeting: '/xyz-abcd-efg' }],
    [sample(0), sample(1, { ...alice, label: 'Different name' })],
  ]) expect(meetSpeakerForSegment(samples, { start: .1, end: .9 })).toBeUndefined();
  expect(meetSpeakerForSegment([sample(0), sample(1)], { start: 1, end: 2 })).toBeUndefined();
  expect(meetSpeakerForSegment([sample(0), sample(1)], { start: .1, end: .1 })).toBeUndefined();
});

test('page snapshots validate names, preserve unnamed speaking tiles, deduplicate identities and reject conflicts', () => {
  const raw = snapshot('Alice');
  raw.participants.push({ id: 'unknown', name: '', self: false, speaking: true });
  expect(parseMeetSnapshot(raw)?.participants).toHaveLength(3);
  expect(parseMeetSnapshot({ ...raw, meeting: '/landing' })).toBeUndefined();
  expect(parseMeetSnapshot({ ...raw, participants: Array(101).fill(raw.participants[0]) })).toBeUndefined();
  expect(parseMeetSnapshot({ ...raw, participants: [raw.participants[0], raw.participants[0]] })?.participants).toHaveLength(1);
  expect(parseMeetSnapshot({ ...raw, participants: [raw.participants[0], { ...raw.participants[0], name: 'Bob' }] })).toBeUndefined();
  expect(parseMeetSnapshot(snapshot('A\u001blice'))?.participants[0]?.name).toBe('Alice');
});

test('Meet setup is opt-in, persisted without replacing AI settings and has a preflight command', () => {
  expect(meetBrowserMatchesApp('chrome', 'us.zoom.xos')).toBe(false);
  expect(meetBrowserMatchesApp('chrome', 'com.apple.Safari')).toBe(false);
  expect(meetBrowserMatchesApp('safari', 'com.apple.Safari')).toBe(true);
  expect(meetBrowserMatchesApp(undefined)).toBe(false);
  const root = mkdtempSync(join(tmpdir(), 'seashell-meet-config-'));
  try {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ meeting: { backend: 'codex', model: 'fixture' } }));
    expect(loadConfig(path).meeting?.speakerBrowser).toBeUndefined();
    updateMeetingConfig({ speakerBrowser: 'safari' }, path);
    expect(loadConfig(path).meeting).toMatchObject({ speakerBrowser: 'safari', model: 'fixture' });
    expect(parseCliArgs(['meeting', 'speakers', 'chrome'])).toMatchObject({ action: { kind: 'speakers', browser: 'chrome' } });
    expect(parseCliArgs(['meeting', 'speakers', '--json'])).toMatchObject({ action: { kind: 'speakers', browser: 'check' }, json: true });
    expect(() => parseCliArgs(['meeting', 'speakers', 'other'])).toThrow('Usage');
  } finally { cleanup(root); }
});

test('resuming preserves the call binding and refuses a different Meet even with the same participant name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-meet-resume-'));
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'resume', startedAtUnixMs: 1000 });
  const sidecar = join(store.root, 'meet-speakers.jsonl');
  writeFileSync(sidecar, [JSON.stringify({ version: 1, sessionId: 'resume', origin: 1000 }), JSON.stringify(sample(0)),
    JSON.stringify({ at: .1, meeting: '' }), ''].join('\n'));
  let finish!: (state: string) => void;
  const done = new Promise<string>(resolve => { finish = resolve; });
  const reader = startMeetSpeakerReader({ browser: 'chrome', store, now: () => 2000,
    probe: async () => ({ state: 'connected', detail: 'fixture', snapshot: { ...snapshot('Alice'), meeting: '/xyz-abcd-efg' } }),
    onStatus: status => finish(status.state),
  });
  try {
    expect(await done).toBe('ambiguous'); reader.stop();
    expect(readMeetSamples(store.manifestPath, store.manifest).filter(s => s.speaker)).toEqual([sample(0)]);
  } finally { reader.stop(); cleanup(root); }
});

test('slow browser reads cannot be presented as a healthy timing signal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-meet-slow-'));
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'slow', startedAtUnixMs: 1000 });
  let clock = 1000, finish!: (state: string) => void;
  const done = new Promise<string>(resolve => { finish = resolve; });
  const reader = startMeetSpeakerReader({ browser: 'chrome', store, now: () => clock,
    probe: async () => { clock += 1000; return { state: 'connected', detail: 'fixture', snapshot: snapshot('Alice') }; },
    onStatus: status => finish(status.state),
  });
  try {
    expect(await done).toBe('unavailable'); reader.stop();
    expect(readMeetSamples(store.manifestPath, store.manifest).every(s => !s.speaker)).toBe(true);
  } finally { reader.stop(); cleanup(root); }
});

test('reader keeps independent participant IDs even for matching names; overlap is unnamed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-meet-reader-'));
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'reader', startedAtUnixMs: 1000 });
  let clock = 1000, calls = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const reader = startMeetSpeakerReader({ browser: 'chrome', store, now: () => clock, pollMs: 1,
    probe: async () => {
      const current = snapshot('Alice');
      if (calls >= 2) current.participants[0]!.id = 'different-alice';
      if (calls === 4) current.participants.push({ id: 'unknown', name: '', speaking: true, self: false });
      return { state: 'connected', detail: 'fixture', snapshot: current };
    },
    onStatus: () => { calls++; clock += 500; if (calls === 5) finish(); },
  });
  try {
    await done; reader.stop();
    const samples = readMeetSamples(store.manifestPath, store.manifest);
    expect(samples[0]?.speaker?.id).not.toBe(samples[2]?.speaker?.id);
    expect(samples[4]?.speaker).toBeUndefined();
    expect(samples.at(-1)?.speaker).toBeUndefined();
    expect(reader.speakerFor({ start: .1, end: .4, text: 'hi', speaker: 'LOCAL' })).toBeUndefined();
    expect(reader.speakerFor({ start: .1, end: .4, text: 'hi', speaker: 'SYSTEM' })?.label).toBe('Alice');
  } finally { reader.stop(); cleanup(root); }
});

test('stopping cancels an in-flight reader without late writes or status updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-meet-stop-'));
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'stop', startedAtUnixMs: 1000 });
  let resolve!: (value: { state: 'connected'; detail: string; snapshot: MeetSnapshot }) => void;
  let statuses = 0;
  const reader = startMeetSpeakerReader({ browser: 'chrome', store, now: () => 1500,
    probe: () => new Promise(done => { resolve = done; }), onStatus: () => statuses++ });
  try {
    reader.stop();
    const before = readFileSync(join(store.root, 'meet-speakers.jsonl'), 'utf8');
    resolve({ state: 'connected', detail: 'late', snapshot: snapshot('Alice') });
    await new Promise(done => setTimeout(done, 5));
    expect(readFileSync(join(store.root, 'meet-speakers.jsonl'), 'utf8')).toBe(before);
    expect(statuses).toBe(0);
  } finally { reader.stop(); cleanup(root); }
});

test('saved hints survive finalization; per-word names split a multi-speaker ASR passage; mic stays separate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-meet-final-'));
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'final', startedAtUnixMs: 1000 });
  try {
    for (const track of ['system-audio', 'microphone'] as const) {
      const path = join(root, track + '.wav');
      writeFileSync(path, pcmS16leToWav(Buffer.alloc(32000 * 3, 10)));
      store.commitChunk({ sourcePath: path, trackId: track, startSeconds: 0, endSeconds: 3, audible: true });
    }
    const hints = [sample(0), sample(.5), sample(1), sample(1.5, bob), sample(2, bob), sample(2.5, bob), sample(3, bob)];
    const sidecar = join(store.root, 'meet-speakers.jsonl');
    writeFileSync(sidecar, [JSON.stringify({ version: 1, sessionId: 'final', origin: 1000 }), ...hints.map(s => JSON.stringify(s)), ''].join('\n'));
    const options = { diarizeSystemAudio: false, localTranscriber: async (path: string) => path.includes('microphone')
      ? [{ start: 0, end: .5, text: 'Local words.' }]
      : [{ start: .1, end: .6, text: 'Hello Alice.' }, { start: 1.1, end: 1.4, text: 'Uncertain transition.' }, { start: 1.6, end: 2.1, text: 'Hello Bob.' }] };
    const record = await saveFinalizedCapture(store, root, 'fixture', options);
    expect(record.speakers).toEqual(expect.arrayContaining([alice, bob, { id: 'LOCAL', label: 'Microphone' }, { id: 'SYSTEM', label: 'System audio' }]));
    expect(record.transcript.find(s => s.text === 'Hello Bob.')).toMatchObject({ speaker: bob.id, speakerSource: 'google-meet-dom' });
    expect(record.transcript.find(s => s.text === 'Uncertain transition.')?.speaker).toBe('SYSTEM');
    expect(record.speakerAnalysis?.status).toBe('platform-hints');
    // Bundle was moved with the saved recording, rather than discarded.
    const { findTranscriptRecord } = await import('../src/transcript-library.ts');
    const saved = findTranscriptRecord(root, record.id);
    expect(readMeetSamples(join(dirname(saved.path), 'capture', 'manifest.json'), store.manifest)).toHaveLength(hints.length);
    expect(new Set(record.transcript.map(s => s.id)).size).toBe(record.transcript.length);
  } finally { cleanup(root); }
});

test('foreign or truncated optional evidence is ignored, and named remote audio still suppresses microphone echo', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-meet-damage-'));
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'mine', startedAtUnixMs: 1000 });
  try {
    const path = join(store.root, 'meet-speakers.jsonl');
    writeFileSync(path, JSON.stringify({ version: 1, sessionId: 'another', origin: 1000 }) + '\n' + JSON.stringify(sample(0)));
    expect(readMeetSamples(store.manifestPath, store.manifest)).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 1, sessionId: 'mine', origin: 1000 }) + '\n' + JSON.stringify(sample(0)) + '\n{"at":');
    expect(readMeetSamples(store.manifestPath, store.manifest)).toEqual([]);
    const mic = { start: 0, end: 1, text: 'This is some remote speech.', speaker: 'LOCAL' };
    const remote = { ...mic, speaker: alice.id };
    expect(reconcileLiveEcho([mic], remote)).toEqual([remote]);
    expect(reconcileLiveEcho([remote], mic)).toEqual([remote]);
  } finally { cleanup(root); }
});
