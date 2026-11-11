import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaptureHealthTracker, CaptureHealthWriter, captureCoverage, oneSidedNotifier, ONE_SIDED_MESSAGE, parseCaptureHealth,
  readCaptureHealth, readMeetingCoverage, yourSideNotice, type CoverageChunk,
} from '../src/capture-health.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'seashell-health-')); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const silent = { peak: 1, rms: 1, rmsDbfs: -90 };
const signal = { peak: 1000, rms: 100, rmsDbfs: -45 };

test('PCM reception, signal and quiet remain different; quiet does not claim a permission failure', () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 0 });
  health.pcm('microphone', silent, undefined, 500);
  expect(health.snapshot.microphone).toMatchObject({ state: 'receiving', lastPcmAtUnixMs: 500 });
  expect(health.snapshot.microphone.lastSignalAtUnixMs).toBeUndefined();
  health.pcm('microphone', silent, undefined, 30_000);
  expect(health.snapshot.microphone.state).toBe('quiet');
  expect(health.snapshot.microphone.warnings[0]?.message).toContain('silence or mute');
  expect(health.snapshot.microphone.warnings[0]?.message).not.toContain('permission');
  health.pcm('microphone', silent, undefined, 31_000);
  expect(health.snapshot.microphone.warnings[0]?.resolvedAtUnixMs).toBeUndefined();
  health.pcm('microphone', signal, undefined, 32_000);
  expect(health.snapshot.microphone).toMatchObject({ state: 'receiving', lastSignalAtUnixMs: 32_000 });
  expect(health.snapshot.microphone.warnings[0]?.resolvedAtUnixMs).toBe(32_000);
});

test('reconnecting and unavailable history survives stop while disabled sources stay distinct', () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 0, systemAudio: false });
  health.state('microphone', { state: 'starting', code: 'microphone_reconnecting', message: 'Attempt 1 reconnecting' }, 1000);
  health.state('microphone', { state: 'starting', message: 'Opening input' }, 1100);
  expect(health.snapshot.microphone.state).toBe('reconnecting');
  health.state('microphone', { state: 'unavailable', code: 'microphone_stopped', message: 'Attempt 3 exited 1' }, 2000);
  health.stop(3000);
  expect(health.snapshot.microphone.state).toBe('stopped');
  expect(health.snapshot.microphone.warnings.map(w => w.kind)).toEqual(['reconnecting', 'unavailable']);
  expect(health.snapshot.microphone.warnings.at(-1)).toMatchObject({ message: 'Attempt 3 exited 1' });
  expect(health.snapshot.microphone.warnings.at(-1)?.resolvedAtUnixMs).toBeUndefined();
  expect(health.snapshot.systemAudio.state).toBe('disabled');
  health.pcm('microphone', signal, true, 4000);
  expect(health.snapshot.microphone.state).toBe('stopped');
});

test('warnings remain bounded across repeated outages and recover only on observed PCM', () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 0 });
  for (let index = 1; index <= 100; index++) health.state('microphone', {
    state: 'starting', code: 'microphone_no_audio', message: 'No samples\n' + 'x'.repeat(1000),
  }, index);
  expect(health.snapshot.microphone.warnings).toHaveLength(1);
  expect(health.snapshot.microphone.warnings[0]).toMatchObject({ firstAtUnixMs: 1, lastAtUnixMs: 100 });
  expect(health.snapshot.microphone.warnings[0]?.message.length).toBeLessThanOrEqual(600);
  health.state('microphone', { state: 'active' }, 101);
  expect(health.snapshot.microphone.warnings[0]?.resolvedAtUnixMs).toBeUndefined();
  health.pcm('microphone', silent, undefined, 102);
  expect(health.snapshot.microphone.warnings[0]?.resolvedAtUnixMs).toBe(102);
  expect(health.snapshot.microphone.lastSignalAtUnixMs).toBeUndefined();
});

test('durable projection throttles repeated meters but immediately writes state changes and final stop', () => {
  const directory = root();
  const writer = new CaptureHealthWriter(directory);
  const health = new CaptureHealthTracker({ nowUnixMs: 0 });
  expect(writer.write(health.snapshot)).toBe(true);
  let writes = 0;
  for (let time = 10; time <= 1000; time += 10) if (writer.write(health.pcm('systemAudio', silent, undefined, time))) writes++;
  expect(writes).toBe(1); // First receiving transition; remaining observations are throttled.
  expect(writer.write(health.pcm('systemAudio', silent, undefined, 1010))).toBe(true);
  expect(writer.write(health.state('microphone', { state: 'unavailable', message: 'Input failed' }, 1011))).toBe(true);
  expect(writer.write(health.stop(1012), true)).toBe(true);
  expect(readCaptureHealth(directory)).toEqual(health.snapshot);
  expect(statSync(join(directory, 'capture-health.json')).mode & 0o777).toBe(0o600);
  expect(readdirSync(directory)).toEqual(['capture-health.json']);
});

test('corrupt optional health is ignored without accepting unbounded metadata', () => {
  const directory = root();
  writeFileSync(join(directory, 'capture-health.json'), '{broken');
  expect(readCaptureHealth(directory)).toBeUndefined();
  const snapshot = new CaptureHealthTracker({ nowUnixMs: 0 }).snapshot;
  expect(parseCaptureHealth({ ...snapshot, microphone: { ...snapshot.microphone, state: 'speech-verified' } })).toBeUndefined();
  expect(parseCaptureHealth({ ...snapshot, microphone: { ...snapshot.microphone, warnings: Array(100).fill({}) } })).toBeUndefined();
  writeFileSync(join(directory, 'capture-health.json'), ' '.repeat(20_000));
  expect(readCaptureHealth(directory)).toBeUndefined();
  expect(readFileSync(join(directory, 'capture-health.json'), 'utf8')).toHaveLength(20_000);
});

const oneSided = (health: CaptureHealthTracker) =>
  health.snapshot.microphone.warnings.find(warning => warning.kind === 'one-sided');

test('your microphone delivering silence while the others talk warns after a minute and clears when you are heard', () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 0 });
  for (let time = 500; time <= 59_500; time += 500) {
    health.pcm('microphone', silent, undefined, time);
    health.pcm('systemAudio', signal, undefined, time);
  }
  expect(oneSided(health)).toBeUndefined();
  health.pcm('microphone', silent, undefined, 60_500);
  expect(oneSided(health)).toMatchObject({ message: ONE_SIDED_MESSAGE, code: 'microphone_one_sided', firstAtUnixMs: 60_500 });
  // More silent PCM is not you being heard; it stays one warning.
  for (let time = 61_000; time <= 90_000; time += 500) health.pcm('microphone', silent, undefined, time);
  expect(health.snapshot.microphone.warnings.filter(warning => warning.kind === 'one-sided')).toHaveLength(1);
  expect(oneSided(health)?.resolvedAtUnixMs).toBeUndefined();
  health.pcm('microphone', signal, undefined, 91_000);
  expect(oneSided(health)?.resolvedAtUnixMs).toBe(91_000);
  expect(parseCaptureHealth(JSON.parse(JSON.stringify(health.snapshot)))).toEqual(health.snapshot);
});

test('a quiet room, a listening meeting start, or a stalled microphone is not one-sided', () => {
  // Nobody talking: silence on both sides is just a quiet call.
  const quietCall = new CaptureHealthTracker({ nowUnixMs: 0 });
  for (let time = 500; time <= 120_000; time += 500) {
    quietCall.pcm('microphone', silent, undefined, time);
    quietCall.pcm('systemAudio', silent, undefined, time);
  }
  expect(oneSided(quietCall)).toBeUndefined();
  // You spoke 50 seconds ago: not yet a minute.
  const listening = new CaptureHealthTracker({ nowUnixMs: 0 });
  listening.pcm('microphone', signal, undefined, 30_000);
  for (let time = 30_500; time <= 80_000; time += 500) {
    listening.pcm('microphone', silent, undefined, time);
    listening.pcm('systemAudio', signal, undefined, time);
  }
  expect(oneSided(listening)).toBeUndefined();
  // No PCM for ten seconds is a stall, which has its own warning.
  const stalled = new CaptureHealthTracker({ nowUnixMs: 0 });
  stalled.pcm('microphone', silent, undefined, 500);
  for (let time = 500; time <= 70_000; time += 500) stalled.pcm('systemAudio', signal, undefined, time);
  expect(oneSided(stalled)).toBeUndefined();
});

const chunks = (track: CoverageChunk['trackId'], audible: number, total: number, startMs = 0): CoverageChunk[] =>
  Array.from({ length: total }, (_, index) => ({ trackId: track, audible: index < audible, startMs: startMs + index * 10_000, endMs: startMs + (index + 1) * 10_000 }));

test('coverage judges your side by its share of the call, not by any audible moment', () => {
  // Shaped like the 85-minute call that lost its microphone: 2 audible chunks of 681.
  const broken = captureCoverage([...chunks('microphone', 2, 681), ...chunks('system-audio', 425, 680)]);
  expect(broken).toEqual({ yourSideAudibleSeconds: 20, otherSideAudibleSeconds: 4250, yourSideAudibleShare: 0.005, yourSideMissing: true });
  expect(yourSideNotice(broken)).toContain("Your side wasn't recorded");
  // 4.5% of the others' time still means a broken microphone.
  expect(captureCoverage([...chunks('microphone', 3, 78), ...chunks('system-audio', 56, 78)]).yourSideMissing).toBe(true);
  // A working microphone hears the room most of the time, even when you mostly listen.
  const healthy = captureCoverage([...chunks('microphone', 50, 62), ...chunks('system-audio', 40, 62)]);
  expect(healthy).toMatchObject({ yourSideAudibleShare: 1.25, yourSideMissing: false });
  expect(yourSideNotice(healthy)).toBeUndefined();
  // The others barely talked: too little to judge.
  expect(captureCoverage([...chunks('microphone', 0, 18), ...chunks('system-audio', 17, 18)]))
    .toEqual({ yourSideAudibleSeconds: 0, otherSideAudibleSeconds: 170, yourSideMissing: false });
  // A microphone turned off on purpose is never missing.
  expect(captureCoverage(chunks('system-audio', 100, 100), { microphone: false }).yourSideMissing).toBe(false);
});

test('stopping keeps the whole meeting\'s coverage with its health, and older meetings fall back to their saved audio', async () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 0 });
  health.stop(1000, [...chunks('microphone', 3, 111), ...chunks('system-audio', 104, 111)]);
  expect(health.snapshot.coverage).toMatchObject({ yourSideMissing: true, yourSideAudibleShare: 0.029 });
  const library = root();
  const directory = join(library, 'meeting');
  const store = new CaptureSessionStore({ libraryDir: library, sessionId: 'coverage-fallback', startedAtUnixMs: 0 });
  const wav = (name: string) => { const path = join(library, name); writeFileSync(path, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)])); return path; };
  for (const [index, chunk] of [...chunks('microphone', 0, 20), ...chunks('system-audio', 19, 20)].entries()) {
    await store.commitChunkAsync({ sourcePath: wav(`chunk-${index}.wav`), trackId: chunk.trackId, startSeconds: chunk.startMs / 1000,
      endSeconds: chunk.endMs / 1000, audible: chunk.audible });
  }
  store.setStatus('captured', 'test');
  store.attachTo(directory);
  expect(readMeetingCoverage(directory)).toEqual({ yourSideAudibleSeconds: 0, otherSideAudibleSeconds: 190, yourSideAudibleShare: 0, yourSideMissing: true });
  new CaptureHealthWriter(join(directory, 'capture')).write(health.snapshot, true);
  expect(readMeetingCoverage(directory)).toEqual(health.snapshot.coverage!);
  expect(readMeetingCoverage(join(library, 'nothing-here'))).toBeUndefined();
  expect(parseCaptureHealth({ ...health.snapshot, coverage: { yourSideMissing: 'yes' } })).toBeUndefined();
});

test('the one-sided notice goes out once per meeting, pauses included, and only for that warning', () => {
  const sent: string[] = [];
  const notify = oneSidedNotifier(message => sent.push(message));
  notify({ type: 'watch.warning', message: ONE_SIDED_MESSAGE });
  expect(sent).toHaveLength(0); // No meeting yet.
  notify({ type: 'meeting.started', sessionId: 'first' });
  notify({ type: 'watch.warning', message: 'Computer audio is quiet.' });
  notify({ type: 'watch.warning', message: `Microphone is quiet. ${ONE_SIDED_MESSAGE}` });
  notify({ type: 'watch.warning', message: ONE_SIDED_MESSAGE });
  notify({ type: 'meeting.resumed', sessionId: 'first' });
  notify({ type: 'watch.warning', message: ONE_SIDED_MESSAGE });
  expect(sent).toEqual([ONE_SIDED_MESSAGE]);
  notify({ type: 'meeting.started', sessionId: 'second' });
  notify({ type: 'watch.warning', message: ONE_SIDED_MESSAGE });
  expect(sent).toHaveLength(2);
});
