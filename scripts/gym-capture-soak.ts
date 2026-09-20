import assert from 'node:assert/strict';
import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { CaptureSessionStore, loadCaptureSession, type CaptureTrackId } from '../src/capture-session.ts';
import { assembleCaptureTrack } from '../src/capture-finalizer.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';

// Accelerated storage/recovery exercise. No device, model, or elapsed-time soak.
const output = resolve(process.argv[2]!);
const fixture = join(output, 'fixture');
mkdirSync(fixture, { recursive: true, mode: 0o700 });
const options = { libraryDir: fixture, sessionId: 'ninety-minute-capture', startedAtUnixMs: 1_000 };
let store = new CaptureSessionStore(options);
const tracks: CaptureTrackId[] = ['microphone', 'system-audio'];
const windows = 540;
const seconds = 10;
const frames = 16_000 * seconds;
const missingWindow = 270;
const latencies: number[] = [];
const started = performance.now();
const cpuStarted = process.cpuUsage();
let peakSampledRss = process.memoryUsage().rss;
let lastTick = started;
let maxEventLoopDelayMs = 0;
let expectedChunks = 0;
let staleProjection = '';
const heartbeat = setInterval(() => {
  const now = performance.now();
  maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - lastTick - 20);
  lastTick = now;
}, 20);
let passed = false;
try {
  for (let index = 0; index < windows; index++) {
    const before = performance.now();
    const commits: Promise<unknown>[] = [];
    for (const [trackIndex, trackId] of tracks.entries()) {
      if (trackId === 'microphone' && index === missingWindow) {
        commits.push(store.recordDiscontinuityAsync({ trackId, atSeconds: index * seconds,
          durationSeconds: seconds, reason: 'device-reset' }));
        continue;
      }
      const sample = 1_000 * (trackIndex + 1) + index;
      const pcm = Buffer.alloc(frames * 2).fill(Buffer.from([sample & 255, sample >> 8]));
      const sourcePath = join(fixture, `${trackId}.wav`);
      writeFileSync(sourcePath, pcmS16leToWav(pcm), { mode: 0o600 });
      commits.push(store.commitChunkAsync({ sourcePath, trackId, startSeconds: index * seconds,
        endSeconds: (index + 1) * seconds, audible: true }));
      expectedChunks++;
    }
    await Promise.all(commits);
    latencies.push(performance.now() - before);
    peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss);
    if (index === 260) staleProjection = readFileSync(store.manifestPath, 'utf8');
    if (index === missingWindow) {
      // Model a crash after journal commits but before the latest projection,
      // followed by a torn append. Reopen, replay, repair, then keep recording.
      writeFileSync(store.manifestPath, staleProjection);
      appendFileSync(store.journalPath, '{"type":"chunk.commi');
      store = new CaptureSessionStore(options);
      assert.equal(store.manifest.chunks.length, expectedChunks);
      assert.equal(store.manifest.discontinuities.length, 1);
    }
    if ((index + 1) % 90 === 0) console.log(`Committed ${(index + 1) * seconds / 60} simulated minutes`);
  }
  await store.drainCommits();
  store.setStatus('captured', 'accelerated-gym');
  const manifest = loadCaptureSession(store.manifestPath);
  assert.equal(manifest.chunks.length, 1_079);
  assert.equal(manifest.discontinuities[0]?.durationMs, 10_000);
  const assemblyStarted = performance.now();
  for (const [trackIndex, trackId] of tracks.entries()) {
    const path = join(fixture, `${trackId}-assembled.wav`);
    assembleCaptureTrack(store.manifestPath, manifest, trackId, path);
    assert.equal(statSync(path).size, 44 + windows * frames * 2);
    const file = openSync(path, 'r');
    try {
      const sample = Buffer.alloc(2);
      for (let index = 0; index < windows; index++) {
        readSync(file, sample, 0, 2, 44 + (index * frames + frames / 2) * 2);
        assert.equal(sample.readInt16LE(0), trackId === 'microphone' && index === missingWindow
          ? 0 : 1_000 * (trackIndex + 1) + index);
      }
    } finally { closeSync(file); }
    peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss);
  }
  const assemblyMs = performance.now() - assemblyStarted;
  // Let the monitor observe the synchronous assembly turn before stopping it.
  await Bun.sleep(25);
  const ordered = [...latencies].sort((a, b) => a - b);
  const cpu = process.cpuUsage(cpuStarted);
  writeFileSync(join(output, 'capture-soak-results.json'), JSON.stringify({
    kind: 'accelerated-capture-storage', simulatedMinutes: 90,
    elapsedMs: performance.now() - started, chunks: manifest.chunks.length,
    rawBytes: manifest.chunks.reduce((total, chunk) => total + chunk.bytes, 0),
    crashRecovery: true, resumedAfterTornAppend: true, preservedGapMs: 10_000,
    verifiedTrackSamples: windows * tracks.length,
    assemblyMs,
    commitWindowP50Ms: ordered[Math.floor(ordered.length * 0.5)],
    commitWindowP95Ms: ordered[Math.floor(ordered.length * 0.95)],
    peakSampledRssBytes: peakSampledRss, maxEventLoopDelayMs,
    cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system,
    limitation: 'No hardware, ASR throughput, or real-time 90-minute reliability claim.',
  }, null, 2) + '\n', { mode: 0o600 });
  passed = true;
  console.log('PASS: 90-minute capture clock, durable recovery, resumed recording, and complete track assembly');
} finally {
  clearInterval(heartbeat);
  // Retain only metrics on success; leave failed fixtures available for diagnosis.
  if (passed) rmSync(fixture, { recursive: true, force: true });
}
