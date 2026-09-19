import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { heapStats } from 'bun:jsc';
import { AutomaticMeetingWatchService } from '../src/automatic-meeting-watch.ts';
import { startDurableLiveCapture, type DurableLiveCaptureHandle } from '../src/durable-live-capture.ts';
import { startMicrophoneCapture } from '../src/live-microphone.ts';
import { startSystemAudioCapture, type SystemAudioCaptureHandle } from '../src/live-system-audio.ts';
import { finalizeCaptureTranscript } from '../src/capture-finalizer.ts';
import { loadCaptureSession, readVerifiedCaptureChunk } from '../src/capture-session.ts';
import { findTranscriptRecord, listTranscriptRecords } from '../src/transcript-library.ts';
import { loadMeetingArtifact } from '../src/meeting-artifact.ts';

// Real child processes, PCM, durable storage, controller, finalizer, and library.
// Detector time and ASR output are fixtures: no microphone or cloud is opened.
const output = resolve(process.argv[2]!);
const cycles = Number(process.argv[3] ?? 100);
assert(Number.isSafeInteger(cycles) && cycles >= 20 && cycles <= 1000);
const library = join(output, 'library');
mkdirSync(library, { recursive: true, mode: 0o700 });
const helper = join(output, 'audio-fixture');
writeFileSync(helper, `#!${process.execPath}
const pcm = Buffer.alloc(48000);
pcm.fill(Buffer.from([0xD0,0x07])); // marker 2000, 1.5 seconds
process.stderr.write(JSON.stringify({type:'first-buffer',capturedAtUnixMs:Date.now()})+'\\n');
process.stdout.write(pcm);
setInterval(()=>{},1000);
`, { mode: 0o700 });
const signalListeners = () => [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
const initialListeners = signalListeners();
const children = new Set<ChildProcess>();
let spawned = 0;
function track(child: ChildProcess) {
  children.add(child); spawned++;
  child.once('close', () => children.delete(child));
}
async function until(check: () => boolean, description: string) {
  const deadline = performance.now() + 5000;
  while (!check() && performance.now() < deadline) await Bun.sleep(5);
  assert(check(), description);
}
let now = Date.now();
let signal = false;
let cycle = 0;
let started = 0;
let ready = 0;
let committed = 0;
let active: DurableLiveCaptureHandle | undefined;
let lastDirectory = '';
let lastError = '';
const service = new AutomaticMeetingWatchService({
  libraryDir: library,
  config: { meeting: { automation: { enabled: true, mode: 'automatic',
    confirmationPolls: 2, endGraceSeconds: 1, cooldownSeconds: 1 } } },
  onEvent(event) {
    if (event.type === 'meeting.started') started++;
    if (event.type === 'meeting.ready') { ready++; lastDirectory = event.directory; }
    if (event.type === 'watch.error' || event.type === 'watch.warning') lastError = event.message;
  },
  dependencies: {
    now: () => new Date(now),
    readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: now, supported: true,
      inputProcesses: signal ? [{ pid: 42, bundleId: 'us.zoom.xos', name: 'Zoom' }] : [] }),
    startCapture(options) {
      active = startDurableLiveCapture({ ...options, sessionId: `cycle-${cycle}`, chunkMilliseconds: 1000,
        microphoneStarter(micOptions) {
          const mic = startMicrophoneCapture({ ...micOptions, command: process.execPath,
            commandArgs: ['-e', `const b=Buffer.alloc(48000);b.fill(Buffer.from([0xE8,0x03]));process.stdout.write(b);setInterval(()=>{},1000)`] });
          track(mic.process);
          return mic;
        },
        systemAudioStarter(systemOptions) {
          let system: SystemAudioCaptureHandle | undefined;
          system = startSystemAudioCapture({ ...systemOptions, helperPath: helper,
            onState(update) {
              if (system?.process && !children.has(system.process)) track(system.process);
              systemOptions.onState(update);
            } });
          return system;
        },
      });
      return active;
    },
    finalizeCapture: (path, options) => finalizeCaptureTranscript(path, { ...options,
      remoteRoute: { model: 'offline-fixture', uploadConsent: true },
      // This injected implementation never invokes Humain or a network provider.
      remoteTranscriber: async (wav) => {
        const data = readFileSync(wav);
        const marker = data.readInt16LE(44);
        assert(marker === 1000 || marker === 2000);
        return { runId: 'fixture', compiledRunId: 'fixture', status: 'succeeded', receipt: {},
          output: { provider: { boundary: 'remote', model: 'offline-fixture' },
            segments: [{ id: 's000001', startMs: 0, endMs: (data.length - 44) / 32,
              text: marker === 1000 ? 'Amber orchard harvest.' : 'Zebra mountain rivers.' }] } };
      },
    }),
  },
});
const samples: Array<{ cycle: number; rss: number; heapSize: number; objects: number }> = [];
const begin = performance.now();
let verifiedChunks = 0;
let passed = false;
try {
  for (cycle = 1; cycle <= cycles; cycle++) {
    now += 2000; signal = true;
    assert.equal((await service.pollOnce()).kind, 'none');
    assert.equal((await service.pollOnce()).kind, 'start');
    await until(() => (active?.store.manifest.chunks.length ?? 0) === 2, 'both sources must commit before ending');
    // Brief detector loss must not split the meeting or stop either source.
    signal = false; now += 100;
    assert.equal((await service.pollOnce()).kind, 'none');
    signal = true; now += 250;
    assert.equal((await service.pollOnce()).kind, 'none');
    assert.equal(service.phase, 'recording');
    assert.equal(children.size, 2);
    signal = false; now += 100;
    await service.pollOnce(); now += 1001;
    assert.equal((await service.pollOnce()).kind, 'finish');
    await until(() => ready === cycle || Boolean(lastError), 'meeting must become ready');
    assert.equal(lastError, '');
    assert.equal(started, cycle);
    assert.equal(children.size, 0, 'no capture process may survive a meeting');
    assert.deepEqual(signalListeners(), initialListeners);
    const manifestPath = join(lastDirectory, 'capture', 'manifest.json');
    const manifest = loadCaptureSession(manifestPath);
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.sessionId, `cycle-${cycle}`);
    assert.equal(manifest.chunks.length, 4, 'both final half-second chunks must survive stop');
    for (const track of ['microphone', 'system-audio'] as const) {
      const chunks = manifest.chunks.filter((chunk) => chunk.trackId === track);
      assert.equal(chunks[1]!.startMs, chunks[0]!.endMs, 'no gap between chunks');
      assert.equal(chunks[1]!.endMs - chunks[0]!.startMs, 1500);
      for (const chunk of chunks) {
        const wav = readVerifiedCaptureChunk(manifestPath, chunk);
        assert.equal(wav.readInt16LE(44), track === 'microphone' ? 1000 : 2000);
        verifiedChunks++;
      }
    }
    const record = findTranscriptRecord(library, `cycle-${cycle}`).record;
    for (const speaker of ['LOCAL', 'SYSTEM']) {
      const segments = record.transcript.filter((segment) => segment.speaker === speaker);
      assert.equal(segments.reduce((total, segment) => total + segment.end - segment.start, 0), 1.5);
    }
    assert.equal(loadMeetingArtifact(library, record.id)?.transcriptId, record.id);
    committed += manifest.chunks.length;
    active = undefined;
    if (cycle % 10 === 0) {
      // Let bounded shutdown grace timers expire before sampling retained state.
      await Bun.sleep(1600);
      Bun.gc(true);
      const heap = heapStats();
      samples.push({ cycle, rss: process.memoryUsage().rss, heapSize: heap.heapSize, objects: heap.objectCount });
      console.log(`Verified ${cycle}/${cycles} meetings; ${verifiedChunks} chunks; ${children.size} remaining children`);
    }
  }
  await service.shutdown();
  assert.equal(listTranscriptRecords(library).length, cycles);
  assert.equal(spawned, cycles * 2);
  const baseline = samples[0]!;
  const final = samples.at(-1)!;
  // Coarse regression budgets, not a claim that all leaks are impossible.
  assert(final.heapSize - baseline.heapSize < 16 * 1024 * 1024, 'retained heap grew by over 16 MiB');
  assert(final.rss - baseline.rss < 128 * 1024 * 1024, 'RSS grew by over 128 MiB after warmup');
  writeFileSync(join(output, 'metrics.json'), JSON.stringify({ cycles, spawned, ready, committed, verifiedChunks,
    durationMs: Math.round(performance.now() - begin), samples,
    heapGrowthBytes: final.heapSize - baseline.heapSize, rssGrowthBytes: final.rss - baseline.rss,
    remainingChildren: children.size, signalListeners: signalListeners(),
    limits: 'Synthetic signals and ASR; real child streams/storage/finalization. No physical device or long-call ASR soak.' }, null, 2) + '\n');
  passed = true;
} finally {
  await service.shutdown();
  for (const child of children) child.kill('SIGKILL');
  if (passed) { rmSync(library, { recursive: true, force: true }); rmSync(helper); }
}
