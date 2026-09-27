#!/usr/bin/env bun
/** Optional real local-ASR acceptance. Never opens a microphone or plays audio. */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackgroundLiveTranscript, type BackgroundLiveTranscriptHandle, type BackgroundLiveTranscriptStatus } from '../src/background-live-transcript.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { OwnedWhisperServer } from '../src/local-asr-scheduler.ts';
import { DEFAULT_WHISPER_MODEL_FILENAME } from '../src/model-config.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { findTranscriptRecord, saveTranscriptRecord } from '../src/transcript-library.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const phrase = 'The next meeting is on Tuesday. Please test the microphone and computer audio.';
const limits = 'Real local Whisper inference over generated speech and durable chunk files. No microphone, playback, meeting, or cloud provider. The canonical replacement is a controlled sentinel, not a second batch-ASR result. This checks the write barrier and owned-process cleanup, not physical capture quality or long-session accuracy.';

function runCommand(command: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(new Error(`${command} failed: ${stderr || error.message}`)) : resolve(stdout));
  });
}
function ownWhisperPids(): number[] {
  const output = execFileSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm='], { encoding: 'utf8', timeout: 3000 });
  return output.split('\n').flatMap(line => {
    const fields = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return fields && Number(fields[2]) === process.pid && fields[3]!.endsWith('/whisper-server') ? [Number(fields[1])] : [];
  });
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function run(runtimeRoot: string) {
  if (process.platform !== 'darwin') throw new Error('This gym uses macOS say to create its nonprivate speech fixture');
  const packageInfo = JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8'));
  if (packageInfo.name !== 'seashell') throw new Error('--runtime-root must be a trusted Seashell installation or source checkout');
  const serverPath = join(runtimeRoot, 'whisper.cpp', 'build', 'bin', 'whisper-server');
  const modelPath = join(runtimeRoot, 'models', DEFAULT_WHISPER_MODEL_FILENAME);
  if (!existsSync(serverPath) || !existsSync(modelPath)) throw new Error('Whisper server/model missing. Supply --runtime-root /path/to/installed/seashell/libexec');
  const ffmpeg = Bun.which('ffmpeg'), ffprobe = Bun.which('ffprobe');
  if (!ffmpeg || !ffprobe) throw new Error('FFmpeg and ffprobe are required');
  const results = join(projectRoot, '.gym-results', 'background-live-transcript');
  mkdirSync(results, { recursive: true, mode: 0o700 });
  const output = mkdtempSync(join(results, 'run-')); chmodSync(output, 0o700);
  const media = join(output, 'media'), library = join(output, 'library');
  mkdirSync(media, { mode: 0o700 }); mkdirSync(library, { mode: 0o700 });
  const json = (file: string, value: unknown) => writeFileSync(join(output, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const controller = new AbortController(), started = performance.now();
  const deadline = setTimeout(() => controller.abort(), 180_000);
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const statuses: Array<BackgroundLiveTranscriptStatus & { atMs: number }> = [];
  const observed = new Set<number>();
  let worker: BackgroundLiveTranscriptHandle | undefined;
  let server: OwnedWhisperServer | undefined;
  let calls = 0, finished = 0;
  const requests: Promise<string>[] = [];
  const cleanupErrors: string[] = [];
  let passed = false;
  let failure: unknown;
  let metrics: Record<string, unknown> = {};
  const sample = () => { for (const pid of ownWhisperPids()) observed.add(pid); };
  async function waitFor(check: () => boolean, detail: string) {
    while (!check()) {
      if (controller.signal.aborted) throw new Error(`Gym cancelled/timed out: ${detail}`);
      if (worker?.status.stage === 'delayed') throw new Error(worker.status.detail);
      sample(); await Bun.sleep(50);
    }
  }
  console.log(`Generating speech on disk; no audio playback. Evidence: ${output}`);
  try {
    const aiff = join(media, 'speech.aiff'), wav = join(media, 'speech.wav');
    await runCommand('/usr/bin/say', ['-v', 'Samantha', '-r', '155', '-o', aiff, phrase], controller.signal);
    await runCommand(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', aiff,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], controller.signal);
    const probe = JSON.parse(await runCommand(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', wav], controller.signal));
    const duration = Number(probe.format.duration);
    assert.ok(duration > 2 && duration < 30, 'Generated speech duration must be bounded and nonempty');
    const record = createTranscriptRecord({ transcript: [], speakers: [] }, {
      id: 'background-draft-gym', title: 'Generated speech live draft gym',
      source: { filename: 'Generated local speech', format: 'capture-session/0.1' },
    });
    saveTranscriptRecord(library, record);
    const store = new CaptureSessionStore({ libraryDir: library, sessionId: record.id, startedAtUnixMs: Date.now() });
    const chunk = await store.commitChunkAsync({ sourcePath: wav, trackId: 'microphone', startSeconds: 0, endSeconds: duration, audible: true });
    const beforeAudio = readFileSync(chunk.path);
    worker = startBackgroundLiveTranscript({ libraryDir: library, record,
      onStatus: status => statuses.push({ ...status, atMs: Math.round(performance.now() - started) }),
      dependencies: { createTranscriber: () => {
        server = new OwnedWhisperServer(serverPath, { id: 'background-live-gym', modelPath,
          threads: Math.max(1, Math.min(4, availableParallelism())), requestTimeoutMs: 120_000,
          idleTimeoutMs: 60_000, disableGpu: process.env.SEASHELL_DISABLE_GPU === '1' });
        return {
          transcribe(path, signal) {
            calls++;
            const request = server!.transcribe(path, signal).finally(() => { finished++; });
            requests.push(request); return request;
          },
          stop: () => server!.stop(),
        };
      } },
    });
    console.log('Running the live worker against the installed local Whisper server…');
    const enqueuedAt = performance.now();
    worker.enqueue(chunk);
    await waitFor(() => findTranscriptRecord(library, record.id).record.transcript.length > 0, 'waiting for real live text to save');
    const live = findTranscriptRecord(library, record.id).record;
    const savedBeforeCloseMs = Math.round(performance.now() - enqueuedAt);
    const text = live.transcript.map(segment => segment.text).join(' ').toLowerCase();
    for (const word of ['tuesday', 'microphone', 'audio']) assert.ok(text.includes(word), `Saved live text must include ${word}`);
    assert.equal(live.id, store.manifest.sessionId);
    assert.notEqual(worker.status.stage, 'stopped');
    assert.deepEqual(readFileSync(chunk.path), beforeAudio, 'Live inference must not alter durable audio');
    sample();
    assert.ok(observed.size > 0, 'Observe an actual owned Whisper server process');
    json('live-before-close.json', live);
    console.log(`Real live text saved before close in ${savedBeforeCloseMs}ms: ${text}`);

    // A warm second request exercises closing while actual inference is active.
    const incoming = join(media, 'second.wav');
    await runCommand(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-stream_loop', '4', '-i', chunk.path,
      '-c:a', 'pcm_s16le', incoming], controller.signal);
    const secondDuration = duration * 5;
    const second = await store.commitChunkAsync({ sourcePath: incoming, trackId: 'system-audio',
      startSeconds: duration + 1, endSeconds: duration + 1 + secondDuration, audible: true });
    worker.enqueue(second);
    await waitFor(() => calls === 2, 'starting second real inference');
    await Bun.sleep(50); sample();
    const secondRequestInFlightAtClose = finished < calls;
    assert.ok(secondRequestInFlightAtClose, 'The longer second request must still be active to exercise real shutdown');
    const closeAt = performance.now();
    await worker.close();
    const closeMs = Math.round(performance.now() - closeAt);
    assert.equal(worker.status.stage, 'stopped');
    const final = { ...live, updatedAt: new Date().toISOString(),
      summary: 'Canonical fixture marker: later live drafts must never replace this record.',
      transcript: live.transcript.map((segment, index) => ({ ...segment, id: `canonical-${index + 1}` })) };
    const saved = saveTranscriptRecord(library, final);
    const finalBytes = readFileSync(saved.jsonPath);
    // Both outstanding real responses and attempts to enqueue after close must be inert.
    worker.enqueue({ ...second, id: 'system-audio.after-close', sequence: second.sequence + 1 });
    await Promise.allSettled(requests);
    await Bun.sleep(1500);
    assert.deepEqual(readFileSync(saved.jsonPath), finalBytes, 'Canonical record changed after the live worker closed');
    assert.equal(calls, 2, 'Closed worker must not launch further inference');
    assert.deepEqual([...observed].filter(alive), [], 'Owned Whisper processes must exit after close');
    assert.deepEqual(ownWhisperPids(), [], 'No owned Whisper server can remain after close');
    assert.deepEqual(readFileSync(chunk.path), beforeAudio);
    json('canonical-after-close.json', findTranscriptRecord(library, record.id).record);
    metrics = { sourceAudioSeconds: duration, cancellationAudioSeconds: secondDuration, savedBeforeCloseMs, closeMs, inferenceCalls: calls,
      secondRequestInFlightAtClose, observedOwnedPids: [...observed], remainingOwnedProcesses: 0,
      canonicalUnchangedAfterClose: true, audioUnchanged: true };
    passed = true;
  } catch (error) { failure = error; }
  finally {
    clearTimeout(deadline);
    controller.abort();
    try { await worker?.close(); } catch (error) { cleanupErrors.push(String(error)); }
    try { await server?.stop(); } catch (error) { cleanupErrors.push(String(error)); }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    const remaining = [...observed].filter(alive);
    if (remaining.length) cleanupErrors.push(`Owned Whisper processes still live: ${remaining.join(', ')}`);
    json('status.json', statuses);
    json('result.json', { status: passed && !cleanupErrors.length ? 'passed' : 'failed',
      startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(), durationMs: Math.round(performance.now() - started),
      runtimeRoot, phrase, limits, ...metrics, cleanupErrors, ...(failure ? { error: String(failure) } : {}) });
    if (passed && !cleanupErrors.length) {
      rmSync(media, { recursive: true, force: true }); rmSync(library, { recursive: true, force: true });
    }
  }
  if (failure || cleanupErrors.length) throw new Error(`Background live gym failed: ${String(failure ?? cleanupErrors.join('; '))}. Evidence: ${output}`);
  console.log(`PASS ${join(output, 'result.json')}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log('bun scripts/background-live-transcript-gym.ts [--runtime-root /trusted/seashell/libexec]\nRequires installed Whisper assets, macOS Samantha voice and FFmpeg. Generates speech to disk; no mic, playback, meeting, login or cloud calls. Private receipts under .gym-results/background-live-transcript/.');
  else {
    try {
      if (args.length !== 0 && (args.length !== 2 || args[0] !== '--runtime-root' || !args[1] || args[1].startsWith('--'))) throw new Error('Usage: bun scripts/background-live-transcript-gym.ts [--runtime-root /trusted/seashell/libexec]');
      await run(args[1] ? resolve(args[1]) : projectRoot);
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}
