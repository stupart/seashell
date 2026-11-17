import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HeavyWorkGate, heavyWork } from '../src/heavy-work.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { transcribeWithTimestamps } from '../src/whisper-timestamps.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A stand-in for Whisper or the speaker helper: counts, as fast as it can, until it is stopped. */
function worker() {
  const child = spawn(process.execPath, ['-e', 'let n = 0; setInterval(() => process.stdout.write(`${++n}\\n`), 10)'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  let count = 0;
  child.stdout!.on('data', (data: Buffer) => { count += data.toString().split('\n').filter(Boolean).length; });
  return { child, count: () => count };
}

test('a call stops heavy work where it stands, and its end continues it; nothing new starts meanwhile', async () => {
  const gate = new HeavyWorkGate();
  const running = worker();
  try {
    gate.follow(running.child);
    while (running.count() < 3) await Bun.sleep(10);
    gate.hold();
    await Bun.sleep(100);
    const stoppedAt = running.count();
    await Bun.sleep(300);
    // Stopped: it does no work at all while the call runs.
    expect(running.count() - stoppedAt).toBeLessThanOrEqual(1);
    let started = false;
    const next = gate.ready().then(() => { started = true; });
    await Bun.sleep(20);
    expect(started).toBe(false);
    gate.release();
    await next;
    const continuedFrom = running.count();
    await Bun.sleep(200);
    // Continued, not restarted: the same process carries on.
    expect(running.count()).toBeGreaterThan(continuedFrom);
    expect(running.child.exitCode).toBeNull();
    // A process that starts while a call runs is stopped from its first moment.
    gate.hold();
    const late = worker();
    gate.follow(late.child);
    await Bun.sleep(300);
    expect(late.count()).toBeLessThanOrEqual(1);
    gate.release();
    late.child.kill('SIGKILL');
  } finally { gate.release(); running.child.kill('SIGKILL'); }
});

test('a final pass never runs both tracks\' Whisper at once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-one-whisper-'));
  roots.push(root);
  const lock = join(root, 'running');
  const overlaps = join(root, 'overlaps');
  const cli = join(root, 'whisper-cli');
  // Like whisper-cli on the GPU for a while; notes it if another is already running.
  writeFileSync(cli, `#!/bin/sh
mkdir '${lock}' 2>/dev/null || echo overlap >> '${overlaps}'
sleep 0.3
while [ $# -gt 0 ]; do [ "$1" = -of ] && out="$2"; shift; done
printf '%s' '{"transcription":[{"text":" Words.","offsets":{"from":0,"to":900}}]}' > "$out.json"
rmdir '${lock}' 2>/dev/null
exit 0
`);
  chmodSync(cli, 0o755);
  const model = join(root, 'model.bin');
  writeFileSync(model, '');
  const pcm = Buffer.alloc(16_000 * 2);
  for (let index = 0; index < 16_000; index++) pcm.writeInt16LE(Math.round(Math.sin(index / 8) * 16_000), index * 2);
  const tracks = ['microphone.wav', 'system.wav'].map((name) => { const path = join(root, name); writeFileSync(path, pcmS16leToWav(pcm)); return path; });
  const hardware = { appleSilicon: true, performanceCores: 6, memoryBytes: 32 * 2 ** 30 };
  const results = await Promise.all(tracks.map((track) => transcribeWithTimestamps(track, {
    whisperCli: cli, modelPath: model, hardware, detectSpeech: async () => undefined, prompt: '',
  })));
  expect(results.map((units) => units.map((unit) => unit.text))).toEqual([['Words.'], ['Words.']]);
  expect(existsSync(overlaps) ? readFileSync(overlaps, 'utf8') : '').toBe('');
  expect(heavyWork.held).toBe(false);
});
