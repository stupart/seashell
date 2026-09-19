import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OwnedWhisperServer } from '../src/local-asr-scheduler.ts';

const roots: string[] = [];
const servers: OwnedWhisperServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(missing = false) {
  const root = mkdtempSync(join(tmpdir(), 'seashell-whisper-server-'));
  roots.push(root);
  const executable = join(root, 'server');
  const started = join(root, 'started');
  const audio = join(root, 'audio.wav');
  writeFileSync(audio, 'fixture');
  if (!missing) writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from 'fs';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
let ready = false;
Bun.serve({ port, hostname: '127.0.0.1', fetch(request) {
  if (!ready) return new Response('loading', {status: 503});
  return new Response(JSON.stringify({text: 'ready transcript'}));
}});
writeFileSync(${JSON.stringify(started)}, String(process.pid));
setTimeout(() => { ready = true; }, 250);
`, { mode: 0o755 });
  const server = new OwnedWhisperServer(executable, {
    id: 'fixture', modelPath: 'fixture-model', threads: 1, requestTimeoutMs: 2_000,
    idleTimeoutMs: 10_000,
  });
  servers.push(server);
  return { server, started, audio };
}
async function waitForFile(path: string) {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(5);
  expect(existsSync(path)).toBe(true);
}

test('concurrent requests both wait for the owned server to become healthy', async () => {
  const f = fixture();
  const first = f.server.transcribe(f.audio);
  await waitForFile(f.started);
  const second = f.server.transcribe(f.audio);
  expect(await Promise.all([first, second])).toEqual(['ready transcript', 'ready transcript']);
});

test('a missing whisper-server is an actionable error, not an uncaught process error', async () => {
  const f = fixture(true);
  await expect(f.server.transcribe(f.audio)).rejects.toThrow('Could not start local Whisper server');
});

test('stopping while a server is starting drains the startup without resurrecting a child', async () => {
  const f = fixture();
  const pending = f.server.transcribe(f.audio).then(() => 'completed', (error: Error) => error.message);
  await waitForFile(f.started);
  await f.server.stop();
  expect(await pending).toContain('cancelled');
});
