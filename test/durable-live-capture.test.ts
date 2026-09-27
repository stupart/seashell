import { afterEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDurableLiveCapture, type DurableLiveCaptureStatus } from '../src/durable-live-capture.ts';
import { readCaptureHealth } from '../src/capture-health.ts';
import { saveFinalizedCapture } from '../src/capture-finalizer.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { listTranscriptRecords } from '../src/transcript-library.ts';
import { readVerifiedCaptureChunk } from '../src/capture-session.ts';
import type { StartMicrophoneOptions } from '../src/live-microphone.ts';
import {
  pcmS16leToWav,
  type StartSystemAudioOptions,
} from '../src/live-system-audio.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(root: string, name: string): string {
  const path = join(root, name);
  writeFileSync(path, pcmS16leToWav(Buffer.alloc(32_000, 1)));
  return path;
}

test('a throwing optional audio starter preserves ownership of the microphone and its final chunk', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-start-fault-'));
  roots.push(libraryDir);
  const microphone = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const done = new Promise<void>((resolve) => microphone.once('close', () => resolve()));
  const warnings: string[] = [];
  let stops = 0;
  try {
    const handle = startDurableLiveCapture({
      libraryDir,
      sessionId: 'startup-fault',
      microphoneStarter: (options) => ({
        process: microphone,
        done,
        stop() {
          stops++;
          options.onChunk({
            path: fixture(libraryDir, 'last-mic.wav'), startSeconds: 0, endSeconds: 1,
            sequence: 1, source: 'microphone', audible: true,
            level: { rms: 0.1, peak: 0.2, rmsDbfs: -20 },
            clock: { kind: 'process-start-estimate', originUnixMs: Date.now(),
              sampleRate: 16_000, uncertaintyMs: 2 },
          });
          microphone.kill('SIGTERM');
        },
      }),
      systemAudioStarter: () => { throw new Error('helper launch failed'); },
      onError: (error) => warnings.push(error.message),
    });
    const manifest = await handle.stop();
    expect(stops).toBe(1);
    expect(microphone.signalCode).toBe('SIGTERM');
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.chunks[0]?.trackId).toBe('microphone');
    expect(manifest.status).toBe('captured');
    expect(warnings).toEqual(['helper launch failed']);
  } finally {
    if (microphone.exitCode === null && microphone.signalCode === null) microphone.kill('SIGKILL');
    await done;
  }
});

test('durably drains both capture tracks and clock discontinuities before stop resolves', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-durable-library-'));
  const sources = mkdtempSync(join(tmpdir(), 'seashell-durable-source-'));
  roots.push(libraryDir, sources);
  const startedAtUnixMs = 1_786_400_000_000;
  const handle = startDurableLiveCapture({
    libraryDir,
    sessionId: 'durable-both',
    startedAt: new Date(startedAtUnixMs),
    microphoneStarter: (options: StartMicrophoneOptions) => {
      options.onState({ state: 'active' });
      options.onChunk({
        path: fixture(sources, 'mic.wav'),
        startSeconds: 0,
        endSeconds: 1,
        sequence: 1,
        source: 'microphone',
        audible: true,
        level: { rms: 0.1, peak: 0.2, rmsDbfs: -20 },
        clock: {
          kind: 'process-start-estimate',
          originUnixMs: startedAtUnixMs,
          sampleRate: 16_000,
          uncertaintyMs: 3,
        },
      });
      return { process: {} as ChildProcess, done: Promise.resolve(), stop() {} };
    },
    systemAudioStarter: (options: StartSystemAudioOptions) => {
      options.onState({ state: 'active' });
      options.onDiscontinuity?.({
        atFrame: 8_000,
        durationFrames: 320,
        reason: 'capture-overrun',
      });
      options.onChunk({
        path: fixture(sources, 'system.wav'),
        startSeconds: 0.1,
        endSeconds: 1.1,
        sequence: 1,
        source: 'system-audio',
        audible: true,
        level: { rms: 0.1, peak: 0.2, rmsDbfs: -20 },
        clock: {
          kind: 'device-sample-clock',
          originUnixMs: startedAtUnixMs + 100,
          sampleRate: 16_000,
          uncertaintyMs: 2,
        },
      });
      return { done: Promise.resolve(), stop() {} };
    },
  });
  const manifest = await handle.stop();
  expect(manifest.status).toBe('captured');
  expect(manifest.chunks.map((chunk) => chunk.trackId).toSorted()).toEqual([
    'microphone',
    'system-audio',
  ]);
  expect(manifest.discontinuities).toEqual([
    expect.objectContaining({ atMs: 500, durationMs: 20, reason: 'capture-overrun' }),
  ]);
});

test('keeps a valid microphone capture when optional system audio is unavailable', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-durable-library-'));
  const sources = mkdtempSync(join(tmpdir(), 'seashell-durable-source-'));
  roots.push(libraryDir, sources);
  const warnings: string[] = [];
  const handle = startDurableLiveCapture({
    libraryDir,
    sessionId: 'durable-mic-only',
    microphoneStarter: (options: StartMicrophoneOptions) => {
      options.onChunk({
        path: fixture(sources, 'mic.wav'), startSeconds: 0, endSeconds: 1,
        sequence: 1, source: 'microphone', audible: true,
        level: { rms: 0.1, peak: 0.2, rmsDbfs: -20 },
        clock: {
          kind: 'process-start-estimate', originUnixMs: Date.now(),
          sampleRate: 16_000, uncertaintyMs: 2,
        },
      });
      return { process: {} as ChildProcess, done: Promise.resolve(), stop() {} };
    },
    systemAudioStarter: (options: StartSystemAudioOptions) => {
      options.onState({ state: 'unavailable', message: 'Permission missing' });
      return { done: Promise.resolve(), stop() {} };
    },
    onError: (error) => warnings.push(error.message),
  });
  const manifest = await handle.stop();
  expect(manifest.status).toBe('captured');
  expect(manifest.chunks).toHaveLength(1);
  expect(warnings).toEqual(['Permission missing']);
});

test('a failed microphone still preserves system capture, committed paths and saved source warnings', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-durable-health-'));
  roots.push(libraryDir);
  const statuses: DurableLiveCaptureStatus[] = [];
  const committed: string[] = [];
  const handle = startDurableLiveCapture({
    libraryDir, sessionId: 'failed-mic-with-system',
    microphoneStarter: () => { throw new Error('Input could not open'); },
    systemAudioStarter: options => {
      options.onState({ state: 'active' });
      options.onChunk({ path: fixture(libraryDir, 'remote.wav'), startSeconds: 2, endSeconds: 3,
        sequence: 1, source: 'system-audio', audible: true,
        level: { rms: 100, peak: 1000, rmsDbfs: -45 },
        clock: { kind: 'process-start-estimate', originUnixMs: Date.now(), sampleRate: 16_000, uncertaintyMs: 2 },
      });
      return { done: Promise.resolve(), stop() {} };
    },
    onStatus: status => statuses.push(status),
    onCommittedChunk: chunk => {
      committed.push(chunk.path);
      expect(readVerifiedCaptureChunk(handle.manifestPath, chunk).length).toBeGreaterThan(44);
      expect(chunk.path).not.toBe(join(libraryDir, 'remote.wav'));
    },
  });
  expect(statuses.every(status => status.audioSavedThroughMs === 0)).toBe(true);
  const manifest = await handle.stop();
  expect(manifest.status).toBe('captured');
  expect(committed).toHaveLength(1);
  expect(statuses.at(-1)?.audioSavedThroughMs).toBe(3000);
  expect(readCaptureHealth(handle.store.root)?.microphone).toMatchObject({ state: 'stopped',
    warnings: [expect.objectContaining({ kind: 'unavailable', message: 'Input could not open' })] });
  await saveFinalizedCapture(handle.store, libraryDir, 'test', { finalizedRecord: createTranscriptRecord({ transcript: [], speakers: [] }, { id: handle.sessionId }) });
  expect(listTranscriptRecords(libraryDir)[0]?.captureHealth?.microphone.warnings[0]?.message).toBe('Input could not open');
});

test('quiet/reconnecting cautions persist independently of legacy active/stopped state', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-durable-quiet-'));
  roots.push(libraryDir);
  const handle = startDurableLiveCapture({ libraryDir, systemAudio: false,
    microphoneStarter: options => {
      options.onState({ state: 'starting', code: 'microphone_reconnecting', message: 'Input reconnecting, attempt 1' });
      options.onState({ state: 'active', code: 'microphone_quiet', message: 'Input is quiet; check if speaking.' });
      return { process: {} as ChildProcess, done: Promise.resolve(), stop() {} };
    },
  });
  expect(handle.health?.microphone.state).toBe('quiet');
  await handle.stop();
  const health = readCaptureHealth(handle.store.root)!;
  expect(health.microphone.state).toBe('stopped');
  expect(health.systemAudio.state).toBe('disabled');
  expect(health.microphone.warnings.map(w => w.kind)).toEqual(['reconnecting', 'quiet']);
  expect(health.microphone.warnings.every(w => w.resolvedAtUnixMs === undefined)).toBe(true);
});
