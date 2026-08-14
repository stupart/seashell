import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CaptureSessionStore,
  listRecoverableCaptureSessions,
  loadCaptureSession,
} from '../src/capture-session.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';

function fixtureWav(directory: string, name: string): string {
  const path = join(directory, name);
  const pcm = Buffer.alloc(32_000);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(900, offset);
  writeFileSync(path, pcmS16leToWav(pcm));
  return path;
}

test('capture sessions durably commit independent source chunks', () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-capture-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'seashell-source-'));
  const store = new CaptureSessionStore({
    libraryDir,
    sessionId: 'session-1',
    startedAtUnixMs: 1_786_400_000_000,
    createdAt: '2026-08-10T12:00:00.000Z',
  });
  const mic = store.commitChunk({
    sourcePath: fixtureWav(sourceDir, 'mic.wav'),
    trackId: 'microphone',
    startSeconds: 0.125,
    endSeconds: 1.125,
    audible: true,
  });
  const system = store.commitChunk({
    sourcePath: fixtureWav(sourceDir, 'system.wav'),
    trackId: 'system-audio',
    startSeconds: 0.25,
    endSeconds: 1.25,
    audible: true,
  });
  expect(mic.id).toBe('microphone.000001');
  expect(system.id).toBe('system-audio.000001');
  expect(readFileSync(mic.path).subarray(0, 4).toString()).toBe('RIFF');
  expect(loadCaptureSession(store.manifestPath).chunks).toHaveLength(2);
  expect(listRecoverableCaptureSessions(libraryDir)).toHaveLength(1);
  store.setStatus('completed');
  expect(listRecoverableCaptureSessions(libraryDir)).toEqual([]);
});

test('capture recovery replays a committed journal entry missing from a stale projection', () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-capture-replay-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'seashell-source-replay-'));
  const store = new CaptureSessionStore({
    libraryDir,
    sessionId: 'session-replay',
    startedAtUnixMs: 1,
  });
  const staleProjection = readFileSync(store.manifestPath, 'utf8');
  store.commitChunk({
    sourcePath: fixtureWav(sourceDir, 'chunk.wav'),
    trackId: 'microphone',
    startSeconds: 0,
    endSeconds: 1,
    audible: true,
  });
  writeFileSync(store.manifestPath, staleProjection);
  expect(loadCaptureSession(store.manifestPath).chunks).toHaveLength(1);
});

test('async capture commits serialize journal order and preserve clock/gap evidence', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-capture-async-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'seashell-source-async-'));
  const store = new CaptureSessionStore({ libraryDir, sessionId: 'async', startedAtUnixMs: 100 });
  const [first, second] = await Promise.all([
    store.commitChunkAsync({
      sourcePath: fixtureWav(sourceDir, 'one.wav'),
      trackId: 'microphone',
      startSeconds: 0,
      endSeconds: 1,
      audible: true,
      clock: {
        kind: 'process-start-estimate', originUnixMs: 100, sampleRate: 16_000, uncertaintyMs: 4,
      },
    }),
    store.commitChunkAsync({
      sourcePath: fixtureWav(sourceDir, 'two.wav'),
      trackId: 'microphone',
      startSeconds: 1,
      endSeconds: 2,
      audible: true,
      clock: {
        kind: 'process-start-estimate', originUnixMs: 100, sampleRate: 16_000, uncertaintyMs: 4,
      },
    }),
  ]);
  await store.recordDiscontinuityAsync({
    trackId: 'system-audio',
    atSeconds: 1.5,
    durationSeconds: 0.02,
    reason: 'capture-overrun',
  });
  await store.drainCommits();
  expect([first.sequence, second.sequence]).toEqual([1, 2]);
  const loaded = loadCaptureSession(store.manifestPath);
  expect(loaded.chunks[0]?.clock?.uncertaintyMs).toBe(4);
  expect(loaded.discontinuities[0]).toMatchObject({ atMs: 1500, durationMs: 20 });
});
