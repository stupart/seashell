import { afterEach, expect, test } from 'bun:test';
import type { ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDurableLiveCapture } from '../src/durable-live-capture.ts';
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
