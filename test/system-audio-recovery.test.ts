import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDurableLiveCapture } from '../src/durable-live-capture.ts';
import { startSystemAudioCapture, type SystemAudioStateUpdate } from '../src/live-system-audio.ts';

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

function helper(root: string, body: string): { path: string; count: () => number } {
  const path = join(root, 'helper');
  const counter = join(root, 'attempts');
  writeFileSync(counter, '0');
  writeFileSync(path, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'fs';
const counter=${JSON.stringify(counter)};
const attempt=Number(readFileSync(counter,'utf8'))+1;
writeFileSync(counter,String(attempt));
const event = value => process.stderr.write(JSON.stringify(value)+'\\n');
${body}
`, { mode: 0o755 });
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
    systemAudioStarter: options => startSystemAudioCapture({ ...options, helperPath: fake.path,
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
    const capture = startSystemAudioCapture({ helperPath: fake.path, sessionStartedAtUnixMs: Date.now(),
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
  const capture = startSystemAudioCapture({ helperPath: fake.path, sessionStartedAtUnixMs: Date.now(),
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
  const capture = startSystemAudioCapture({ helperPath: fake.path, sessionStartedAtUnixMs: Date.now(),
    chunkMilliseconds: 100, minimumChunkMilliseconds: 20,
    onState: state => states.push(state), onChunk: chunk => { chunks++; rmSync(chunk.path); } });
  try {
    await until(() => chunks === 1);
    expect(states.some(state => state.code === 'route_watch_unavailable')).toBe(true);
    expect(states.at(-1)?.state).toBe('active');
    expect(fake.count()).toBe(1);
  } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
});
