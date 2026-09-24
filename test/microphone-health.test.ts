import { test, expect } from 'bun:test';
import { rmSync } from 'fs';
import { startMicrophoneCapture } from '../src/live-microphone.ts';
import type { SystemAudioStateUpdate } from '../src/live-system-audio.ts';

const until = async (check: () => boolean) => {
  const end = Date.now() + 2500;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  expect(check()).toBe(true);
};

test('quiet microphone warns while PCM still arrives and clears when speech returns', async () => {
  const states: SystemAudioStateUpdate[] = [];
  const capture = startMicrophoneCapture({ sessionStartedAtUnixMs: Date.now(),
    command: process.execPath, commandArgs: ['-e', `
const started=Date.now();
setInterval(()=>{const pcm=Buffer.alloc(3200);if(Date.now()-started>230)for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(i%4?500:-500,i);process.stdout.write(pcm)},20);
`], maxRestarts: 0, quietWarningMs: 90, stalledTimeoutMs: 1500,
    chunkMilliseconds: 100, minimumChunkMilliseconds: 20,
    onState: (state) => states.push(state), onChunk: (chunk) => rmSync(chunk.path),
  });
  try {
    await until(() => states.some((s) => s.code === 'microphone_quiet'));
    await until(() => states.at(-1)?.state === 'active' && states.at(-1)?.code === undefined);
  } finally { capture.stop(); await capture.done; }
  expect(states.at(-1)?.state).toBe('stopped');
});

test('stalled capture retries within a bound and preserves a fresh clock for each attempt', async () => {
  const states: SystemAudioStateUpdate[] = [];
  const origins: number[] = [];
  const capture = startMicrophoneCapture({ sessionStartedAtUnixMs: Date.now(),
    command: process.execPath, commandArgs: ['-e', 'process.stdout.write(Buffer.alloc(3200,1));setInterval(()=>{},1000)'],
    maxRestarts: 1, restartDelayMs: 10, stalledTimeoutMs: 70,
    chunkMilliseconds: 100, minimumChunkMilliseconds: 20,
    onState: (state) => states.push(state),
    onChunk: (chunk) => { origins.push(chunk.clock.originUnixMs); rmSync(chunk.path); },
  });
  try {
    await capture.done;
    expect(states.filter((s) => s.code === 'microphone_reconnecting')).toHaveLength(1);
    expect(states.at(-1)?.state).toBe('unavailable');
    expect(origins).toHaveLength(2);
    expect(origins[1]!).toBeGreaterThan(origins[0]!);
  } finally { capture.stop(); await capture.done; }
}, 5000);

test('stopping during reconnect prevents a late microphone process', async () => {
  const states: SystemAudioStateUpdate[] = [];
  const capture = startMicrophoneCapture({ sessionStartedAtUnixMs: Date.now(),
    command: process.execPath, commandArgs: ['-e', 'process.exit(1)'],
    restartDelayMs: 500,
    onState: (state) => states.push(state), onChunk: (chunk) => rmSync(chunk.path),
  });
  await until(() => states.some((s) => s.code === 'microphone_reconnecting'));
  const first = capture.process;
  capture.stop(); await capture.done;
  expect(capture.process).toBe(first);
  expect(states.at(-1)?.state).toBe('stopped');
});
