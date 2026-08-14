import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { startMicrophoneCapture } from '../src/live-microphone.ts';

test('microphone controller exposes a stoppable continuous capture lifecycle', async () => {
  const states: string[] = [];
  const chunks: string[] = [];
  const startedAt = Date.now();
  const handle = startMicrophoneCapture({
    sessionStartedAtUnixMs: startedAt,
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
