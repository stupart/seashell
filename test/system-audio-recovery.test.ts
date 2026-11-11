import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDurableLiveCapture } from '../src/durable-live-capture.ts';
import { startSystemAudioCapture, systemAudioCanRecover, type SystemAudioStateUpdate } from '../src/live-system-audio.ts';

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

function helper(root: string, body: string): { path: string; count: () => number } {
  const path = join(root, 'helper');
  const counter = join(root, 'attempts');
  writeFileSync(counter, '0');
  writeFileSync(path, `
import {readFileSync,writeFileSync} from 'fs';
const counter=${JSON.stringify(counter)};
const attempt=Number(readFileSync(counter,'utf8'))+1;
writeFileSync(counter,String(attempt));
const event = value => process.stderr.write(JSON.stringify(value)+'\\n');
${body}
`, { mode: 0o600 });
  return { path, count: () => Number(readFileSync(counter, 'utf8')) };
}

test('output device reset preserves durable chunks, fresh clocks, and the real restart gap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-route-recovery-'));
  const fake = helper(root, `
event({type:'first-buffer',capturedAtUnixMs:Date.now(),bufferStartUnixMs:Date.now()});
process.stdout.write(Buffer.alloc(3200,attempt));
await Bun.sleep(120);
if(attempt===1){event({type:'error',code:'device_changed',message:'Output route changed'});process.exit(1);}
setInterval(()=>{},1000);
`);
  const capture = startDurableLiveCapture({ libraryDir: root, sessionId: 'route-recovery', microphone: false,
    chunkMilliseconds: 100,
    systemAudioStarter: options => startSystemAudioCapture({ ...options, helperPath: process.execPath, helperArgs: [fake.path],
      minimumChunkMilliseconds: 20, restartDelayMs: 100 }),
  });
  try {
    await until(() => capture.store.manifest.chunks.length === 2);
    const manifest = await capture.stop();
    expect(fake.count()).toBe(2);
    expect(manifest.chunks.map(chunk => chunk.id)).toEqual(['system-audio.000001', 'system-audio.000002']);
    const [first, second] = manifest.chunks;
    expect(second!.clock!.originUnixMs).toBeGreaterThan(first!.clock!.originUnixMs);
    expect(second!.startMs).toBeGreaterThan(first!.endMs);
    expect(manifest.discontinuities).toHaveLength(1);
    expect(manifest.discontinuities[0]).toMatchObject({ trackId: 'system-audio', reason: 'device-reset',
      atMs: first!.endMs, durationMs: second!.startMs - first!.endMs });
    for (const [index, chunk] of manifest.chunks.entries()) {
      expect(readFileSync(join(capture.store.root, chunk.relativePath)).subarray(44)).toEqual(Buffer.alloc(3200, index + 1));
    }
  } finally { await capture.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('system audio route recovery has a retry bound and does not retry permission denial', async () => {
  for (const code of ['device_changed', 'permission_denied']) {
    const root = mkdtempSync(join(tmpdir(), 'seashell-route-bound-'));
    const fake = helper(root, `event({type:'error',code:${JSON.stringify(code)},message:'Cannot capture'});`);
    const states: SystemAudioStateUpdate[] = [];
    const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], sessionStartedAtUnixMs: Date.now(),
      maxRestarts: 1, restartDelayMs: 10, onState: state => states.push(state), onChunk() {} });
    try {
      await capture.done;
      expect(fake.count()).toBe(code === 'device_changed' ? 2 : 1);
      expect(states.filter(state => state.code === 'system_audio_reconnecting')).toHaveLength(code === 'device_changed' ? 1 : 0);
      expect(states.at(-1)).toMatchObject({ state: 'unavailable', code });
    } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
  }
});

test('stopping during output route recovery prevents a late capture process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-route-stop-'));
  const fake = helper(root, `event({type:'error',code:'device_changed',message:'Route changed'});`);
  const states: SystemAudioStateUpdate[] = [];
  const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], sessionStartedAtUnixMs: Date.now(),
    restartDelayMs: 500, onState: state => states.push(state), onChunk() {} });
  try {
    await until(() => states.some(state => state.code === 'system_audio_reconnecting'));
    capture.stop();
    await capture.done;
    expect(fake.count()).toBe(1);
    expect(states.at(-1)?.state).toBe('stopped');
  } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
});

test('unavailable device-change monitoring warns without interrupting usable audio', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-route-warning-'));
  const fake = helper(root, `
event({type:'warning',code:'route_watch_unavailable',message:'Switch monitoring unavailable'});
event({type:'first-buffer',capturedAtUnixMs:Date.now()});
process.stdout.write(Buffer.alloc(3200,1));
setInterval(()=>{},1000);
`);
  const states: SystemAudioStateUpdate[] = [];
  let chunks = 0;
  const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], sessionStartedAtUnixMs: Date.now(),
    chunkMilliseconds: 100, minimumChunkMilliseconds: 20,
    onState: state => states.push(state), onChunk: chunk => { chunks++; rmSync(chunk.path); } });
  try {
    await until(() => chunks === 1);
    expect(states.some(state => state.code === 'route_watch_unavailable')).toBe(true);
    expect(states.at(-1)?.state).toBe('active');
    expect(fake.count()).toBe(1);
  } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
});

test('switching output devices any number of times keeps computer audio for the whole call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-route-many-'));
  // AirPods in, AirPods out, back in: each attempt hears audio, then the route changes.
  const fake = helper(root, `
event({type:'first-buffer',capturedAtUnixMs:Date.now(),bufferStartUnixMs:Date.now()});
process.stdout.write(Buffer.alloc(3200,attempt));
await Bun.sleep(60);
if(attempt<4){event({type:'error',code:'device_changed',message:'Output route changed'});process.exit(1);}
setInterval(()=>{},1000);
`);
  const states: SystemAudioStateUpdate[] = [];
  let chunks = 0;
  const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], sessionStartedAtUnixMs: Date.now(),
    chunkMilliseconds: 100, minimumChunkMilliseconds: 20, restartDelayMs: 10,
    onState: state => states.push(state), onChunk: chunk => { chunks++; rmSync(chunk.path); } });
  try {
    await until(() => chunks === 4);
    expect(fake.count()).toBe(4);
    expect(states.filter(state => state.code === 'system_audio_reconnecting')).toHaveLength(3);
    expect(states.some(state => state.state === 'unavailable')).toBe(false);
  } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
});

test('a helper that stops sending audio without exiting is restarted, and the gap is kept on the timeline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-route-stall-'));
  // The first attempt's device stops after one buffer and never says so.
  const fake = helper(root, `
event({type:'first-buffer',capturedAtUnixMs:Date.now(),bufferStartUnixMs:Date.now()});
process.stdout.write(Buffer.alloc(3200,attempt));
if(attempt>1)setInterval(()=>process.stdout.write(Buffer.alloc(320,attempt)),20);
else setInterval(()=>{},1000);
`);
  const states: SystemAudioStateUpdate[] = [];
  const capture = startDurableLiveCapture({ libraryDir: root, sessionId: 'route-stall', microphone: false, chunkMilliseconds: 100,
    systemAudioStarter: options => startSystemAudioCapture({ ...options, helperPath: process.execPath, helperArgs: [fake.path],
      minimumChunkMilliseconds: 20, restartDelayMs: 10, stalledTimeoutMs: 200,
      onState: state => { states.push(state); options.onState(state); } }),
  });
  try {
    await until(() => capture.store.manifest.chunks.length >= 3);
    const manifest = await capture.stop();
    expect(fake.count()).toBe(2);
    expect(states.find(state => state.code === 'system_audio_reconnecting')?.message).toBe('Computer audio stopped arriving · reconnecting…');
    const [first, second] = manifest.chunks;
    expect(manifest.discontinuities[0]).toMatchObject({ trackId: 'system-audio', reason: 'device-reset',
      atMs: first!.endMs, durationMs: second!.startMs - first!.endMs });
    expect(manifest.discontinuities[0]!.durationMs).toBeGreaterThanOrEqual(150);
  } finally { await capture.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('a reconnect that never sends audio is retried, while a first start may wait for permission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-route-silent-reopen-'));
  // Attempt 1 works then the route changes; attempt 2 opens but its new device never starts.
  const fake = helper(root, `
if(attempt===2){setInterval(()=>{},1000);}
else {
  event({type:'first-buffer',capturedAtUnixMs:Date.now(),bufferStartUnixMs:Date.now()});
  process.stdout.write(Buffer.alloc(3200,attempt));
  if(attempt===1){await Bun.sleep(60);event({type:'error',code:'device_changed',message:'Route changed'});process.exit(1);}
  setInterval(()=>process.stdout.write(Buffer.alloc(320,attempt)),20);
}
`);
  const states: SystemAudioStateUpdate[] = [];
  const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], sessionStartedAtUnixMs: Date.now(),
    chunkMilliseconds: 100, minimumChunkMilliseconds: 20, restartDelayMs: 10, stalledTimeoutMs: 200,
    onState: state => states.push(state), onChunk: chunk => rmSync(chunk.path) });
  try {
    await until(() => fake.count() === 3 && states.at(-1)?.state === 'active');
    expect(states.filter(state => state.code === 'system_audio_reconnecting').map(state => state.message)).toEqual([
      'Computer audio device changed · reconnecting…', 'Computer audio stopped arriving · reconnecting…']);
  } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
  // A first start sends nothing while macOS asks for access; it is not a stall.
  const waiting = mkdtempSync(join(tmpdir(), 'seashell-route-first-wait-'));
  const prompt = helper(waiting, 'setInterval(()=>{},1000);');
  const first = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [prompt.path], sessionStartedAtUnixMs: Date.now(),
    stalledTimeoutMs: 50, onState() {}, onChunk() {} });
  try {
    await Bun.sleep(300);
    expect(prompt.count()).toBe(1);
    expect(first.process?.exitCode).toBeNull();
  } finally { first.stop(); await first.done; rmSync(waiting, { recursive: true, force: true }); }
});

test('once computer audio has worked, a failed reopen is retried; permission and missing helpers never are', () => {
  expect(systemAudioCanRecover('device_changed', false)).toBe(true);
  expect(systemAudioCanRecover('system_audio_stalled', false)).toBe(true);
  // The new output device was not ready yet.
  expect(systemAudioCanRecover('get_clock_device', true)).toBe(true);
  expect(systemAudioCanRecover('capture_stopped', true)).toBe(true);
  expect(systemAudioCanRecover('get_clock_device', false)).toBe(false);
  for (const code of ['permission_denied', 'unsupported_os', 'helper_missing', 'spawn_failed', 'protocol_error']) {
    expect(systemAudioCanRecover(code, true)).toBe(false);
  }
});
