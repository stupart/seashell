import { expect, test } from 'bun:test';
import { LiveAsrScheduler } from '../src/local-asr-scheduler.ts';

test('local ASR scheduler runs exactly one inference at a time', async () => {
  let active = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const scheduler = new LiveAsrScheduler({
    transcribe: async (path) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return path;
    },
  });
  const first = scheduler.enqueue({ id: '1', audioFile: 'one', start: 0, end: 1, speaker: 'LOCAL', sessionGeneration: 1 });
  const second = scheduler.enqueue({ id: '2', audioFile: 'two', start: 1, end: 2, speaker: 'SYSTEM', sessionGeneration: 1 });
  await Bun.sleep(10);
  expect(peak).toBe(1);
  releases.shift()?.();
  await Bun.sleep(10);
  expect(peak).toBe(1);
  releases.shift()?.();
  expect((await first).status).toBe('completed');
  expect((await second).status).toBe('completed');
  expect(peak).toBe(1);
});

test('local ASR saturation supersedes draft work without rejecting new audio', async () => {
  let release = () => {};
  const scheduler = new LiveAsrScheduler({
    maxPending: 2,
    transcribe: async () => await new Promise<string>((resolve) => { release = () => resolve('active'); }),
  });
  const first = scheduler.enqueue({ id: '1', audioFile: '1', start: 0, end: 1, speaker: 'LOCAL', sessionGeneration: 1 });
  const oldMic = scheduler.enqueue({ id: '2', audioFile: '2', start: 1, end: 2, speaker: 'LOCAL', sessionGeneration: 1 });
  const system = scheduler.enqueue({ id: '3', audioFile: '3', start: 1, end: 2, speaker: 'SYSTEM', sessionGeneration: 1 });
  const newestMic = scheduler.enqueue({ id: '4', audioFile: '4', start: 2, end: 3, speaker: 'LOCAL', sessionGeneration: 1 });
  expect((await oldMic).status).toBe('superseded');
  release();
  await first;
  scheduler.cancelGeneration(1);
  expect((await system).status).toBe('cancelled');
  expect((await newestMic).status).toBe('cancelled');
});
