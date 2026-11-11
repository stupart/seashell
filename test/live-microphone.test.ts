import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

test('a microphone macOS has not allowed is said once, rechecked for the whole recording, and recorded once allowed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-mic-permission-'));
  const allowed = join(root, 'allowed');
  const launches = join(root, 'launches');
  writeFileSync(launches, '');
  // Like the helper: exit 77 while access is off; PCM once it is on.
  const helper = join(root, 'helper.ts');
  writeFileSync(helper, `
import { appendFileSync, existsSync } from 'fs';
appendFileSync(${JSON.stringify(launches)}, 'x');
if (!existsSync(${JSON.stringify(allowed)})) { process.stderr.write('Microphone access is off for Seashell Microphone.'); process.exit(77); }
setInterval(() => process.stdout.write(Buffer.alloc(3200, 1)), 100);
`);
  const states: Array<{ state: string; code?: string; message?: string }> = [];
  const chunks: string[] = [];
  const handle = startMicrophoneCapture({
    sessionStartedAtUnixMs: Date.now(), permissionRecheckMs: 50, maxRestarts: 0,
    chunkMilliseconds: 200, minimumChunkMilliseconds: 50,
    command: process.execPath, commandArgs: [helper],
    onState: (state) => states.push(state), onChunk: (chunk) => chunks.push(chunk.path),
  });
  let settled = false;
  void handle.done.then(() => { settled = true; });
  try {
    const deadline = Date.now() + 8_000;
    while (readFileSync(launches, 'utf8').length < 4 && Date.now() < deadline) await Bun.sleep(10);
    // Still trying, with no restart budget at all, and said exactly once.
    expect(readFileSync(launches, 'utf8').length).toBeGreaterThanOrEqual(4);
    expect(settled).toBe(false);
    const said = states.filter((state) => state.code === 'microphone_permission');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ state: 'unavailable', message: 'Microphone access is off for Seashell Microphone.' });
    expect(states.filter((state) => state.state === 'starting' && state.message === 'Opening microphone…')).toHaveLength(1);
    // Allowed mid-call: the next recheck records.
    writeFileSync(allowed, '');
    while (chunks.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(states.at(-1)?.state).toBe('active');
  } finally {
    handle.stop();
    await handle.done;
    for (const path of chunks) rmSync(path, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

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

test.skipIf(process.platform !== 'darwin' || !Bun.file(`${import.meta.dir}/../native/bin/seashell-microphone`).size)(
  'every input shape, from AirPods to aggregate devices, comes out as sound on the meeting timeline', () => {
    // Int16, Int32 and Float32, interleaved or not, mono to 8 channels
    // (spatial, discrete and partly silent), 8 to 192 kHz: 336 cases.
    const result = Bun.spawnSync([`${import.meta.dir}/../native/bin/seashell-microphone`, '--mix-check']);
    const report = JSON.parse(result.stdout.toString());
    expect(report.failures).toEqual([]);
    expect(report.cases).toBe(336);
    expect(report.peak).toBeGreaterThan(7_000);
    expect(result.exitCode).toBe(0);
  });
