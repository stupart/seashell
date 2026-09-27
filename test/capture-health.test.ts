import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureHealthTracker, CaptureHealthWriter, parseCaptureHealth, readCaptureHealth } from '../src/capture-health.ts';

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
