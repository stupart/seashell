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
import { startMicrophoneCapture, type StartMicrophoneOptions } from '../src/live-microphone.ts';
import {
  pcmS16leToWav,
  type StartSystemAudioOptions,
} from '../src/live-system-audio.ts';
import { screenFilmedNotifier, startVideoTrack, type VideoCaptureRequest, type VideoCaptureResult } from '../src/video-capture.ts';

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

test('a resumed meeting reopens its capture bundle and continues on the original clock', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-resume-capture-'));
  roots.push(libraryDir);
  const startedAt = new Date(Date.now() - 60_000);
  const segment = async () => {
    const handle = startDurableLiveCapture({
      libraryDir, sessionId: 'resumed-call', startedAt, systemAudio: false, chunkMilliseconds: 500,
      microphoneStarter: (options) => startMicrophoneCapture({ ...options, maxRestarts: 0,
        command: process.execPath,
        commandArgs: ['-e', 'process.stdout.write(Buffer.alloc(16000, 1)); setInterval(() => {}, 1000)'] }),
    });
    const before = handle.store.manifest.chunks.length;
    const deadline = Date.now() + 5_000;
    while (handle.store.manifest.chunks.length <= before && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    return handle.stop('signal-ended');
  };
  const first = await segment();
  // The fixture writes its half second at once; let wall time pass it, as a real call would.
  await Bun.sleep(700);
  const resumed = await segment();
  expect(resumed.sessionId).toBe(first.sessionId);
  expect(resumed.startedAtUnixMs).toBe(startedAt.getTime());
  expect(resumed.status).toBe('captured');
  const chunks = resumed.chunks.filter(chunk => chunk.trackId === 'microphone');
  expect(chunks.length).toBe(first.chunks.length * 2);
  expect(chunks.map(chunk => chunk.sequence)).toEqual(chunks.map((_, index) => index + 1));
  const firstEnd = Math.max(...first.chunks.map(chunk => chunk.endMs));
  const later = chunks.slice(first.chunks.length);
  // The pause stays a gap on one timeline: about a minute in, never restarting at zero.
  expect(first.chunks[0]!.startMs).toBeGreaterThanOrEqual(59_000);
  expect(later[0]!.startMs).toBeGreaterThanOrEqual(firstEnd);
  for (const chunk of chunks) readVerifiedCaptureChunk(join(libraryDir, '_Capture', 'resumed-call', 'manifest.json'), chunk);
});

const videoRequest: VideoCaptureRequest = { target: { kind: 'window', bundleIds: ['us.zoom.xos'] }, fps: 2, quality: 'medium' };

function microphoneWithOneChunk(sources: string) {
  return (options: StartMicrophoneOptions) => {
    options.onChunk({
      path: fixture(sources, 'mic.wav'), startSeconds: 0, endSeconds: 1, sequence: 1, source: 'microphone', audible: true,
      level: { rms: 0.1, peak: 0.2, rmsDbfs: -20 },
      clock: { kind: 'process-start-estimate', originUnixMs: Date.now(), sampleRate: 16_000, uncertaintyMs: 2 },
    });
    return { process: {} as ChildProcess, done: Promise.resolve(), stop() {} };
  };
}

test('video records beside audio: listed at its first frame, final at stop, on the session clock', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-durable-video-'));
  roots.push(libraryDir);
  const startedAt = new Date(1_800_000_000_000);
  const statuses: DurableLiveCaptureStatus[] = [];
  const handle = startDurableLiveCapture({
    libraryDir, sessionId: 'with-video', startedAt, systemAudio: false,
    microphoneStarter: microphoneWithOneChunk(libraryDir),
    video: videoRequest,
    videoStarter: (options) => startVideoTrack({ ...options, starter: (run) => {
      writeFileSync(run.outputPath, Buffer.alloc(32, 1));
      run.onFirstFrame?.({ firstFrameUnixMs: startedAt.getTime() + 2_500, finished: false });
      let finish: (result: VideoCaptureResult) => void = () => {};
      return {
        done: new Promise((resolve) => { finish = resolve; }),
        stop: () => {
          finish({ saved: true, requestedStop: true, segment: { firstFrameUnixMs: startedAt.getTime() + 2_500,
            durationMs: 30_000, bytes: 32, codec: 'h264', finished: true } });
        },
      };
    } }),
    onStatus: (status) => statuses.push(status),
  });
  // Listed while still recording, so a crash of Seashell itself would find it.
  const deadline = Date.now() + 5_000;
  while (!handle.store.manifest.video && Date.now() < deadline) await Bun.sleep(10);
  expect(handle.store.manifest.video?.segments[0]).toMatchObject({ id: 'video.000001', firstFrameMs: 2_500, finished: false });
  const manifest = await handle.stop();
  expect(manifest.status).toBe('captured');
  expect(manifest.video?.segments).toEqual([expect.objectContaining({
    id: 'video.000001', relativePath: 'video/000001.mp4', firstFrameMs: 2_500, durationMs: 30_000,
    bytes: 32, codec: 'h264', fps: 2, quality: 'medium', finished: true,
  })]);
  expect(statuses.map((status) => status.video)).toContain('recording');
  expect(statuses.at(-1)?.video).toBe('stopped');
});

test('video that cannot start is only a warning: audio is captured and stop succeeds', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-durable-video-fail-'));
  roots.push(libraryDir);
  const warnings: string[] = [];
  const statuses: DurableLiveCaptureStatus[] = [];
  const thrown = startDurableLiveCapture({
    libraryDir, sessionId: 'video-throws', systemAudio: false,
    microphoneStarter: microphoneWithOneChunk(libraryDir),
    video: videoRequest,
    videoStarter: () => { throw new Error('helper missing'); },
    onError: (error) => warnings.push(error.message),
    onStatus: (status) => statuses.push(status),
  });
  expect((await thrown.stop()).status).toBe('captured');
  expect(warnings).toEqual(['Video was not recorded: helper missing']);
  expect(statuses.at(-1)?.video).toBe('unavailable');

  // No audio source either: the failure that surfaces is never the video's.
  const denied = startDurableLiveCapture({
    libraryDir, sessionId: 'video-denied', microphone: false, systemAudio: false,
    video: videoRequest,
    videoStarter: (options) => startVideoTrack({ ...options, starter: () => ({
      done: Promise.resolve({ saved: false, reason: 'permission', message: 'Screen Recording is off.', requestedStop: false }),
      stop() {},
    }) }),
    onError: (error) => warnings.push(error.message),
  });
  const manifest = await denied.stop();
  expect(manifest.status).toBe('captured');
  expect(manifest.video).toBeUndefined();
  expect(warnings.at(-1)).toBe('Screen Recording is off.');
});

test('without a video request no video starts', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-durable-no-video-'));
  roots.push(libraryDir);
  let started = false;
  const statuses: DurableLiveCaptureStatus[] = [];
  const handle = startDurableLiveCapture({ libraryDir, systemAudio: false, microphoneStarter: microphoneWithOneChunk(libraryDir),
    videoStarter: () => { started = true; throw new Error('unexpected'); }, onStatus: (status) => statuses.push(status) });
  await handle.stop();
  expect(started).toBe(false);
  expect(statuses.every((status) => status.video === undefined)).toBe(true);
});

test('what the video films is saved with the capture health, and a filmed screen is said as a notice once per meeting', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-durable-video-filming-'));
  roots.push(libraryDir);
  const warnings: string[] = [];
  const handle = startDurableLiveCapture({
    libraryDir, sessionId: 'screen', systemAudio: false,
    microphoneStarter: microphoneWithOneChunk(libraryDir),
    video: { target: { kind: 'display', display: 1 }, fps: 2, quality: 'medium' },
    videoStarter: (options) => startVideoTrack({ ...options, starter: (run) => {
      run.onTarget?.({ kind: 'display', name: 'display 1, the whole screen' });
      let finish: (result: VideoCaptureResult) => void = () => {};
      return { done: new Promise((resolve) => { finish = resolve; }),
        stop: () => finish({ saved: false, reason: 'no-frames', message: 'none', requestedStop: true }) };
    } }),
    onError: (error) => warnings.push(error.message),
  });
  expect(handle.health?.video).toEqual({ state: 'starting', filming: 'display 1, the whole screen', screenFilmed: true });
  expect(readCaptureHealth(handle.store.root)?.video?.screenFilmed).toBe(true);
  expect(warnings).toEqual(['Seashell is filming your whole screen (display 1) for this recording, as asked: everything on it is in the video.']);
  await handle.stop();

  const notices: string[] = [];
  const notify = screenFilmedNotifier((message) => notices.push(message));
  const event = { type: 'watch.warning', message: warnings[0] };
  for (const next of [{ type: 'meeting.started' }, event, event, { type: 'watch.warning', message: 'Microphone is quiet.' }, { type: 'meeting.started' }, event]) notify(next);
  expect(notices).toEqual([warnings[0]!, warnings[0]!]);
});
