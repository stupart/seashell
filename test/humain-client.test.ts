import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runHumainMeeting, runHumainTranscription, type HumainTranscriptionRoute } from '../src/humain-client.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const route: HumainTranscriptionRoute = { model: 'test/exact-model', uploadConsent: true };
function fixture(change: (result: any) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'seashell-humain-client-'));
  roots.push(root);
  const dist = join(root, 'engine', 'dist');
  mkdirSync(dist, { recursive: true });
  const cli = join(dist, 'cli.js');
  writeFileSync(cli, `const fs = require('fs');
fs.writeFileSync(process.env.FIXTURE_ARGS, JSON.stringify(process.argv.slice(2)));
if (process.env.FIXTURE_HANG) { process.on('SIGTERM', () => {}); setInterval(() => {}, 100); }
else process.stdout.write(process.env.FIXTURE_RESULT);
`);
  const result = { status: 'succeeded', runId: 'expected-run', compiledRunId: 'compiled', receipt: {},
    output: { provider: { boundary: 'remote', model: route.model },
      segments: [{ id: 's1', text: 'Hello', startMs: 0, endMs: 100 }] } };
  change(result);
  const argsPath = join(root, 'args.json');
  const options = { runId: 'expected-run', storeDir: 'relative store', env: {
    HUMAIN_CLI: cli, FIXTURE_ARGS: argsPath, FIXTURE_RESULT: JSON.stringify(result),
  } };
  return { root, argsPath, options };
}

test('the upload boundary rejects absent or false runtime consent before starting Humain', async () => {
  for (const uploadConsent of [false, undefined]) {
    const f = fixture();
    await expect(runHumainTranscription('audio.wav', { ...route, uploadConsent } as HumainTranscriptionRoute, f.options))
      .rejects.toThrow('uploadConsent');
    expect(existsSync(f.argsPath)).toBe(false);
  }
});

test('Humain results must match the requested run and exact model', async () => {
  const wrongRun = fixture((r) => { r.runId = 'another-run'; });
  await expect(runHumainTranscription('audio.wav', route, wrongRun.options)).rejects.toThrow('run');
  const wrongModel = fixture((r) => { r.output.provider.model = 'another-model'; });
  await expect(runHumainTranscription('audio.wav', route, wrongModel.options)).rejects.toThrow('model');
});

test('invalid or duplicate segment identities are rejected', async () => {
  const missing = fixture((r) => { delete r.output.segments[0].id; });
  await expect(runHumainTranscription('audio.wav', route, missing.options)).rejects.toThrow('segment');
  const duplicate = fixture((r) => { r.output.segments.push(r.output.segments[0]); });
  await expect(runHumainTranscription('audio.wav', route, duplicate.options)).rejects.toThrow('segment');
});

test('relative audio and store paths retain caller meaning when Humain changes its cwd', async () => {
  const f = fixture();
  expect((await runHumainTranscription('audio.wav', route, f.options)).status).toBe('succeeded');
  const args = JSON.parse(readFileSync(f.argsPath, 'utf8')) as string[];
  expect(args[1]).toBe(join(process.cwd(), 'audio.wav'));
  expect(args[args.indexOf('--store') + 1]).toBe(join(process.cwd(), 'relative store'));
});

test('a stuck meeting provider is killed after the deadline and its private request is removed', async () => {
  const f = fixture();
  const started = Date.now();
  await expect(runHumainMeeting('reconcile', { private: 'fixture' }, {
    ...f.options, timeoutMs: 200, env: { ...f.options.env, FIXTURE_HANG: '1' },
  })).rejects.toThrow('timed out');
  expect(Date.now() - started).toBeLessThan(4_000);
  const args = JSON.parse(readFileSync(f.argsPath, 'utf8')) as string[];
  expect(existsSync(args[2]!)).toBe(false);
}, 5_000);

test('cancellation drains a running transcription child and rejects its result', async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending = runHumainTranscription('audio.wav', route, {
    ...f.options, signal: controller.signal, env: { ...f.options.env, FIXTURE_HANG: '1' },
  });
  const rejected = expect(pending).rejects.toThrow('cancelled');
  while (!existsSync(f.argsPath)) await Bun.sleep(5);
  controller.abort();
  await rejected;
}, 5_000);

test('an already cancelled call never launches the provider', async () => {
  const f = fixture();
  await expect(runHumainTranscription('audio.wav', route, {
    ...f.options, signal: AbortSignal.abort(),
  })).rejects.toThrow('cancelled before start');
  expect(existsSync(f.argsPath)).toBe(false);
});

test('a configured PATH is honored when discovering an installed Humain', async () => {
  const f = fixture();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'humain'), '#!/bin/sh\nprintf "%s" "$FIXTURE_RESULT"\n', { mode: 0o755 });
  expect((await runHumainTranscription('audio.wav', route, {
    ...f.options, env: { ...f.options.env, HUMAIN_CLI: '', PATH: bin },
  })).status).toBe('succeeded');
});
