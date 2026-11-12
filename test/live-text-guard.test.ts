import { expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { inferenceCommand, TASKPOLICY } from '../src/inference-priority.ts';
import { LiveTextGuard, macLoadPerCore } from '../src/live-text-guard.ts';
import { StallClock } from '../src/stall-clock.ts';

const calm = { loadPerCore: 0.4, draftBehind: false, probeTimedOut: false };

test('live text pauses on load, on drafts falling behind, or on probes timing out, and resumes after a calm minute', () => {
  const load = new LiveTextGuard();
  expect(load.observe(0, calm)).toBeUndefined();
  // Tonight: a load of 70 to 115 on 18 cores.
  expect(load.observe(3_000, { ...calm, loadPerCore: 70 / 18 })).toBe('pause');
  expect(load.paused).toBe(true);
  // Between the lines it stays paused, whatever the time: no flapping at the threshold.
  for (let at = 6_000; at <= 300_000; at += 3_000) expect(load.observe(at, { ...calm, loadPerCore: 1.2 })).toBeUndefined();
  for (let at = 303_000; at < 363_000; at += 3_000) expect(load.observe(at, calm)).toBeUndefined();
  expect(load.observe(363_000, calm)).toBe('resume');
  expect(load.paused).toBe(false);

  const behind = new LiveTextGuard();
  expect(behind.observe(0, { ...calm, draftBehind: true })).toBe('pause');

  const probes = new LiveTextGuard();
  expect(probes.observe(0, { ...calm, probeTimedOut: true })).toBeUndefined();
  expect(probes.observe(40_000, { ...calm, probeTimedOut: true })).toBe('pause');
  // A timeout inside the last minute keeps it paused; a calm minute after that resumes it.
  let resumedAt: number | undefined;
  for (let at = 43_000; at <= 200_000 && resumedAt === undefined; at += 3_000) {
    if (probes.observe(at, calm) === 'resume') resumedAt = at;
  }
  expect(resumedAt).toBe(160_000);
  // Two timeouts far apart are a blip, not an overloaded Mac.
  const spaced = new LiveTextGuard();
  expect(spaced.observe(0, { ...calm, probeTimedOut: true })).toBeUndefined();
  expect(spaced.observe(90_000, { ...calm, probeTimedOut: true })).toBeUndefined();
});

test('a late watchdog tick is the process lagging, so it never ends a healthy helper, but a real stall is still caught', () => {
  const clock = new StallClock(1_000, 0);
  // The process was blocked for 9 s; the helper's audio is waiting in the pipe.
  expect(clock.silentFor(9_000)).toBe(0);
  clock.data(9_001);
  expect(clock.silentFor(10_000)).toBe(999);
  // A real stall: on-time ticks see the silence grow.
  for (let at = 11_000; at <= 17_000; at += 1_000) clock.silentFor(at);
  expect(clock.silentFor(18_000)).toBe(8_999);
  // A process lagging on every tick still judges every other one.
  const lagging = new StallClock(1_000, 0);
  expect(lagging.silentFor(3_000)).toBe(0);
  expect(lagging.silentFor(6_000)).toBe(6_000);
});

test('inference runs in its lane through taskpolicy, and a missing program still fails as it always did', () => {
  const darwin = { platform: 'darwin' as const, env: {}, exists: () => true, which: () => '/usr/bin/whisper' };
  expect(inferenceCommand('/opt/whisper-server', ['-m', 'model'], 'live', darwin)).toEqual({
    command: TASKPOLICY, args: ['-c', 'utility', '/opt/whisper-server', '-m', 'model'] });
  expect(inferenceCommand('ffmpeg', ['-i', 'call.wav'], 'background', darwin)).toEqual({
    command: TASKPOLICY, args: ['-b', 'ffmpeg', '-i', 'call.wav'] });
  expect(inferenceCommand('/opt/missing', [], 'background', { ...darwin, exists: (path) => path === TASKPOLICY })).toEqual({ command: '/opt/missing', args: [] });
  expect(inferenceCommand('sox', [], 'background', { ...darwin, which: () => null })).toEqual({ command: 'sox', args: [] });
  expect(inferenceCommand('ffmpeg', [], 'background', { ...darwin, platform: 'linux' })).toEqual({ command: 'ffmpeg', args: [] });
  expect(inferenceCommand('ffmpeg', [], 'background', { ...darwin, env: { SEASHELL_INFERENCE_PRIORITY: 'normal' } })).toEqual({ command: 'ffmpeg', args: [] });
});

test.skipIf(process.platform !== 'darwin')('a program run in the background lane keeps its own pid and exit code', async () => {
  const run = inferenceCommand('/bin/sh', ['-c', 'echo $$; exit 7'], 'background');
  expect(run.command).toBe(TASKPOLICY);
  const child = spawn(run.command, run.args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout!.on('data', (data: Buffer) => { output += data.toString(); });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  expect(code).toBe(7);
  expect(Number(output.trim())).toBe(child.pid!);
});

test('the load reading can be pinned, so tests never depend on how busy their Mac is', () => {
  expect(macLoadPerCore({ SEASHELL_LOAD_PER_CORE: '4' })).toBe(4);
  expect(macLoadPerCore({ SEASHELL_LOAD_PER_CORE: 'busy' })).toBeGreaterThanOrEqual(0);
  expect(macLoadPerCore({})).toBeGreaterThanOrEqual(0);
  expect(process.env.SEASHELL_LOAD_PER_CORE).toBe('0');
});
