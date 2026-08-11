import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { startMicrophoneCapture } from '../src/live-microphone.ts';

test('microphone controller exposes a stoppable continuous capture lifecycle', async () => {
  const states: string[] = [];
  const chunks: string[] = [];
  const handle = startMicrophoneCapture({
    sessionStartedAtUnixMs: Date.now(),
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
