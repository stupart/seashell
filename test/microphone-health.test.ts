import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startMicrophoneCapture, type MicrophoneStateUpdate } from '../src/live-microphone.ts';
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

test('never-PCM attempts release startup, exhaust only the configured retries, and retain each cause', async () => {
  const states: MicrophoneStateUpdate[] = [];
  const capture = startMicrophoneCapture({ sessionStartedAtUnixMs: Date.now(),
    command: process.execPath, commandArgs: ['-e', 'setInterval(()=>{},1000)'],
    startupTimeoutMs: 70, maxRestarts: 2, restartDelayMs: 10,
    onState: state => states.push(state), onChunk: chunk => rmSync(chunk.path),
  });
  try {
    await capture.startup;
    expect(states.some(state => state.code === 'microphone_no_audio')).toBe(true);
    await capture.done;
    const failures = states.filter(state => state.diagnostic);
    expect(failures.map(state => state.diagnostic!.attempt)).toEqual([1, 2, 3]);
    expect(failures.every(state => state.diagnostic!.reason === 'startup-timeout')).toBe(true);
    expect(failures.map(state => state.state)).toEqual(['starting', 'starting', 'unavailable']);
    expect(failures.slice(0, 2).every(state => state.code === 'microphone_reconnecting')).toBe(true);
    expect(failures.at(-1)?.code).toBe('microphone_no_audio');
    expect(capture.process.exitCode !== null || capture.process.signalCode !== null).toBe(true);
  } finally { capture.stop(); await capture.done; }
}, 5000);

test('recorder warnings cannot hide exit codes or erase earlier retry diagnostics', async () => {
  const states: MicrophoneStateUpdate[] = [];
  const capture = startMicrophoneCapture({ sessionStartedAtUnixMs: Date.now(),
    command: process.execPath,
    commandArgs: ['-e', 'process.stderr.write("x".repeat(5000)+" recorder overrun warning",()=>process.exit(42))'],
    maxRestarts: 1, restartDelayMs: 10,
    onState: state => states.push(state), onChunk: chunk => rmSync(chunk.path),
  });
  try {
    await capture.done;
    const failures = states.filter(state => state.diagnostic);
    expect(failures).toHaveLength(2);
    for (const [index, state] of failures.entries()) {
      expect(state.diagnostic).toMatchObject({ attempt: index + 1, reason: 'process-exit', exitCode: 42, signal: null });
      expect(state.diagnostic!.pid).toBeGreaterThan(0);
      expect(state.diagnostic!.stderr!.length).toBeLessThanOrEqual(2000);
      expect(state.message).toContain(`Attempt ${index + 1}: exit 42`);
      expect(state.message).toContain('recorder overrun warning');
    }
    expect(failures[0]?.code).toBe('microphone_reconnecting');
    expect(failures[1]?.code).toBe('microphone_stopped');
  } finally { capture.stop(); await capture.done; }
});

test('unexpected signal termination remains explicit even with recorder stderr', async () => {
  const states: MicrophoneStateUpdate[] = [];
  const capture = startMicrophoneCapture({ sessionStartedAtUnixMs: Date.now(),
    command: process.execPath,
    commandArgs: ['-e', 'process.stderr.write("earlier warning",()=>process.kill(process.pid,"SIGKILL"))'],
    maxRestarts: 0, onState: state => states.push(state), onChunk: chunk => rmSync(chunk.path),
  });
  try {
    await capture.done;
    expect(states.at(-1)?.diagnostic).toMatchObject({ reason: 'process-exit', exitCode: null, signal: 'SIGKILL' });
    expect(states.at(-1)?.message).toContain('signal SIGKILL');
    expect(states.at(-1)?.message).toContain('earlier warning');
  } finally { capture.stop(); await capture.done; }
});

test('ordinary silent PCM warns without restarting or claiming a permission failure', async () => {
  const states: MicrophoneStateUpdate[] = [];
  const capture = startMicrophoneCapture({ sessionStartedAtUnixMs: Date.now(),
    command: process.execPath, commandArgs: ['-e', 'setInterval(()=>process.stdout.write(Buffer.alloc(3200)),20)'],
    maxRestarts: 2, quietWarningMs: 70, stalledTimeoutMs: 1000,
    chunkMilliseconds: 100, minimumChunkMilliseconds: 20,
    onState: state => states.push(state), onChunk: chunk => rmSync(chunk.path),
  });
  try {
    await until(() => states.some(state => state.code === 'microphone_quiet'));
    const child = capture.process;
    await Bun.sleep(200);
    expect(capture.process).toBe(child);
    expect(states.filter(state => state.code === 'microphone_quiet')).toHaveLength(1);
    expect(states.some(state => state.diagnostic || state.code === 'microphone_reconnecting')).toBe(false);
    expect(states.find(state => state.code === 'microphone_quiet')?.message).not.toMatch(/permission|recognized/iu);
  } finally { capture.stop(); await capture.done; }
});

test('late PCM during timeout shutdown cannot turn the failed source active', async () => {
  const states: MicrophoneStateUpdate[] = [];
  let chunks = 0;
  const capture = startMicrophoneCapture({ sessionStartedAtUnixMs: Date.now(),
    command: process.execPath,
    commandArgs: ['-e', 'process.on("SIGTERM",()=>{process.stdout.write(Buffer.alloc(3200,1));setTimeout(()=>process.exit(0),20)});setInterval(()=>{},1000)'],
    startupTimeoutMs: 200, maxRestarts: 0, chunkMilliseconds: 100,
    onState: state => states.push(state), onChunk: chunk => { chunks++; rmSync(chunk.path); },
  });
  try {
    await capture.done;
    expect(states.some(state => state.state === 'active')).toBe(false);
    expect(chunks).toBe(0);
    expect(states.at(-1)?.diagnostic?.reason).toBe('startup-timeout');
  } finally { capture.stop(); await capture.done; }
});

test('a fresh attempt can recover after the initial startup deadline without blocking optional audio', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-mic-recovery-'));
  const marker = join(root, 'first-attempt');
  const states: MicrophoneStateUpdate[] = [];
  const script = `import { existsSync, writeFileSync } from 'node:fs';
const marker=${JSON.stringify(marker)};
if(existsSync(marker)) { process.stdout.write(Buffer.alloc(3200,1));setInterval(()=>process.stdout.write(Buffer.alloc(3200,1)),20); }
else { writeFileSync(marker,'opened');setInterval(()=>{},1000); }`;
  const capture = startMicrophoneCapture({ sessionStartedAtUnixMs: Date.now(),
    command: process.execPath, commandArgs: ['-e', script],
    startupTimeoutMs: 150, maxRestarts: 1, restartDelayMs: 10,
    chunkMilliseconds: 100, minimumChunkMilliseconds: 20,
    onState: state => states.push(state), onChunk: chunk => rmSync(chunk.path),
  });
  try {
    await capture.startup;
    expect(states.some(state => state.code === 'microphone_no_audio')).toBe(true);
    expect(states.some(state => state.state === 'active')).toBe(false);
    await until(() => states.some(state => state.state === 'active'));
    expect(states.filter(state => state.diagnostic)).toHaveLength(1);
    expect(states.find(state => state.diagnostic)?.diagnostic?.reason).toBe('startup-timeout');
    expect(states.some(state => state.state === 'unavailable')).toBe(false);
  } finally {
    capture.stop(); await capture.done;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a never-PCM child ignoring normal termination is forcibly bounded', async () => {
  const states: MicrophoneStateUpdate[] = [];
  const capture = startMicrophoneCapture({ sessionStartedAtUnixMs: Date.now(),
    command: process.execPath,
    commandArgs: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    startupTimeoutMs: 200, maxRestarts: 0,
    onState: state => states.push(state), onChunk: chunk => rmSync(chunk.path),
  });
  try {
    await capture.startup;
    expect(capture.process.exitCode).toBeNull();
    await capture.done;
    expect(states.at(-1)?.diagnostic).toMatchObject({ reason: 'startup-timeout', signal: 'SIGKILL' });
  } finally { capture.stop(); await capture.done; }
}, 5000);
