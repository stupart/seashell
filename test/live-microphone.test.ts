import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { startMicrophoneCapture } from '../src/live-microphone.ts';

test('a microphone that produces no PCM releases optional capture startup and exits', async () => {
  const states: Array<{ state: string; code?: string; message?: string }> = [];
  let optionalCaptureStarted = false;
  const handle = startMicrophoneCapture({
    sessionStartedAtUnixMs: Date.now(), startupTimeoutMs: 70, maxRestarts: 0,
    command: process.execPath,
    commandArgs: ['-e', 'setInterval(()=>{},1000)'],
    onState: (state) => states.push(state), onChunk: (chunk) => { void Bun.file(chunk.path).delete(); },
  });
  try {
    await Promise.race([
      handle.startup!.then(() => { optionalCaptureStarted = true; }),
      Bun.sleep(1000),
    ]);
    expect(optionalCaptureStarted).toBe(true);
    expect(states.map((state) => state.code)).toContain('microphone_no_audio');
    expect(states.find((state) => state.code)?.message).toContain('selected input');
    await handle.done;
    expect(states.at(-1)?.state).toBe('unavailable');
    expect(handle.process.exitCode !== null || handle.process.signalCode !== null).toBe(true);
  } finally { handle.stop(); await handle.done; }
});

test('microphone controller exposes a stoppable continuous capture lifecycle', async () => {
  const states: string[] = [];
  const chunks: string[] = [];
  const startedAt = Date.now();
  const handle = startMicrophoneCapture({
    sessionStartedAtUnixMs: startedAt,
    maxRestarts: 0,
    chunkMilliseconds: 100,
    minimumChunkMilliseconds: 50,
    command: process.execPath,
    commandArgs: [
      '-e',
      'process.stdout.write(Buffer.alloc(6400, 1)); setTimeout(() => process.exit(0), 1000)',
    ],
    onState: (state) => states.push(state.state),
    onChunk: (chunk) => {
      chunks.push(chunk.path);
      expect(chunk.clock.kind).toBe('process-start-estimate');
      expect(chunk.clock.originUnixMs).toBeGreaterThanOrEqual(startedAt);
      expect(readFileSync(chunk.path).subarray(0, 4).toString()).toBe('RIFF');
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  handle.stop();
  await handle.done;
  expect(states[0]).toBe('starting');
  expect(states.at(-1)).toBe('stopped');
  for (const path of chunks) await Bun.file(path).delete();
});

test('microphone sample clock is anchored before delayed stdout delivery', async () => {
  const startedAt = Date.now();
  let firstStart: number | undefined;
  let path: string | undefined;
  const handle = startMicrophoneCapture({
    sessionStartedAtUnixMs: startedAt,
    maxRestarts: 0,
    chunkMilliseconds: 100,
    minimumChunkMilliseconds: 50,
    command: process.execPath,
    commandArgs: ['-e', 'setTimeout(()=>process.stdout.write(Buffer.alloc(3200,1)),250); setTimeout(()=>process.exit(0),400)'],
    onState() {},
    onChunk: (chunk) => {
      firstStart ??= chunk.startSeconds;
      path = chunk.path;
    },
  });
  await handle.done;
  expect(firstStart).toBeLessThan(0.1);
  if (path) await Bun.file(path).delete();
});

test('a denied microphone permission is reported once instead of retried', async () => {
  const states: Array<{ state: string; code?: string; message?: string }> = [];
  const handle = startMicrophoneCapture({
    sessionStartedAtUnixMs: Date.now(), restartDelayMs: 5,
    command: process.execPath,
    commandArgs: ['-e', 'process.stderr.write("Microphone access is off for Seashell Microphone."); process.exit(77)'],
    onState: (state) => states.push(state), onChunk: (chunk) => { void Bun.file(chunk.path).delete(); },
  });
  await handle.done;
  expect(states.filter((state) => state.state === 'starting' && state.message === 'Opening microphone…')).toHaveLength(1);
  expect(states.at(-1)).toMatchObject({ state: 'unavailable', code: 'microphone_permission',
    message: 'Microphone access is off for Seashell Microphone.' });
});

test('a recorder that keeps exiting is retried for the whole meeting, not twice', async () => {
  let attempts = 0;
  const handle = startMicrophoneCapture({
    sessionStartedAtUnixMs: Date.now(), restartDelayMs: 1, restartDelayMaxMs: 2,
    command: process.execPath,
    commandArgs: ['-e', 'process.exit(0)'],
    onState: (state) => { if (state.message === 'Opening microphone…') attempts++; },
    onChunk: (chunk) => { void Bun.file(chunk.path).delete(); },
  });
  const deadline = Date.now() + 10_000;
  while (attempts < 6 && Date.now() < deadline) await Bun.sleep(10);
  handle.stop();
  await handle.done;
  expect(attempts).toBeGreaterThanOrEqual(6);
});
