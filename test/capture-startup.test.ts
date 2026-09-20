import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startMicrophoneCapture } from '../src/live-microphone.ts';
import { startSystemAudioCapture } from '../src/live-system-audio.ts';

test('system capture waits for microphone PCM and both children stop without lost chunks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-ordered-start-'));
  const marker = join(root, 'microphone-opened');
  const helper = join(root, 'system');
  writeFileSync(helper, `#!${process.execPath}
import {existsSync} from 'fs';
if (!existsSync(${JSON.stringify(marker)})) process.exit(42);
process.stderr.write(JSON.stringify({type:'first-buffer',capturedAtUnixMs:Date.now()})+'\\n');
process.stdout.write(Buffer.alloc(32000,1));
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const chunks: string[] = [];
  const options = { sessionStartedAtUnixMs: Date.now(), chunkMilliseconds: 1000,
    onState() {}, onChunk: (chunk: { path: string; source: string }) => {
      chunks.push(chunk.source); rmSync(chunk.path);
    } };
  const mic = startMicrophoneCapture({ ...options, command: process.execPath,
    commandArgs: ['-e', `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'');process.stdout.write(Buffer.alloc(32000,1))},150);setInterval(()=>{},1000)`] });
  const system = startSystemAudioCapture({ ...options, helperPath: helper, startAfter: mic.startup });
  try {
    expect(system.process).toBeUndefined();
    const deadline = Date.now() + 2000;
    while (chunks.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(chunks.toSorted()).toEqual(['microphone', 'system-audio']);
    mic.stop(); system.stop();
    await Promise.all([mic.done, system.done]);
    expect(mic.process.signalCode).not.toBeNull();
    expect(system.process?.signalCode).not.toBeNull();
  } finally { mic.stop(); system.stop(); await Promise.all([mic.done, system.done]); rmSync(root, { recursive: true, force: true }); }
});

test('stopping while waiting for microphone startup prevents a late system capture', async () => {
  let ready = () => {};
  const startAfter = new Promise<void>((resolve) => { ready = resolve; });
  const states: string[] = [];
  const system = startSystemAudioCapture({ sessionStartedAtUnixMs: Date.now(), startAfter,
    onState: (update) => states.push(update.state), onChunk() {} });
  system.stop();
  await system.done;
  ready();
  await Bun.sleep(20);
  expect(system.process).toBeUndefined();
  expect(states).toEqual(['starting', 'stopped']);
});

test('a stuck microphone does not block the optional source forever', async () => {
  const states: string[] = [];
  const system = startSystemAudioCapture({ sessionStartedAtUnixMs: Date.now(),
    startAfter: new Promise(() => {}), startupWaitMs: 20, helperPath: '/nonexistent/seashell-helper',
    onState: (update) => states.push(update.state), onChunk() {} });
  await system.done;
  expect(states).toEqual(['starting', 'unavailable']);
});

for (const firstBufferBeforeStart of [false, true]) {
  test(`computer audio becomes ready without PCM and never downgrades active capture (buffer first: ${firstBufferBeforeStart})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-audio-ready-'));
    const marker = join(root, 'supply-audio');
    const helper = join(root, 'system');
    writeFileSync(helper, `#!${process.execPath}
import {existsSync} from 'fs';
const event = (value) => process.stderr.write(JSON.stringify(value)+'\\n');
const start = () => event({type:'start',sampleRate:16000,channels:1,bitsPerChannel:16});
if (!${firstBufferBeforeStart}) { start(); start(); }
while (!existsSync(${JSON.stringify(marker)})) await Bun.sleep(10);
event({type:'first-buffer',capturedAtUnixMs:Date.now()});
start();
process.stdout.write(Buffer.alloc(32000,1));
setInterval(()=>{},1000);
`, { mode: 0o755 });
    const states: string[] = [];
    let chunks = 0;
    const capture = startSystemAudioCapture({
      helperPath: helper, sessionStartedAtUnixMs: Date.now(), chunkMilliseconds: 1000,
      onState: (update) => states.push(update.state),
      onChunk: (chunk) => { chunks++; rmSync(chunk.path); },
    });
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 2000;
      while (!check() && Date.now() < deadline) await Bun.sleep(10);
      expect(check()).toBe(true);
    };
    try {
      if (!firstBufferBeforeStart) {
        await until(() => states.includes('ready'));
        expect(states).toEqual(['starting', 'ready']);
        expect(chunks).toBe(0);
      }
      writeFileSync(marker, '');
      await until(() => chunks === 1);
      capture.stop();
      await capture.done;
      expect(states).toEqual(firstBufferBeforeStart
        ? ['starting', 'active', 'stopped']
        : ['starting', 'ready', 'active', 'stopped']);
    } finally {
      capture.stop();
      await capture.done;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
