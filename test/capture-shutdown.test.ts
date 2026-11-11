import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDurableLiveCapture } from '../src/durable-live-capture.ts';
import { startMicrophoneCapture } from '../src/live-microphone.ts';
import { startSystemAudioCapture } from '../src/live-system-audio.ts';

for (const source of ['microphone', 'system-audio'] as const) {
  test(`${source} stop kills a capture child that ignores graceful termination`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-stuck-capture-'));
    const helper = join(root, 'helper');
    writeFileSync(helper, `
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
process.stderr.write(JSON.stringify({type:'first-buffer',capturedAtUnixMs:Date.now()})+'\\n');
process.stdout.write(Buffer.alloc(3200));
setInterval(() => {}, 100);
`, { mode: 0o600 });
    let ready = false;
    const states: Array<{ state: string; code?: string; message?: string }> = [];
    const options = {
      sessionStartedAtUnixMs: Date.now(),
      // This fixture tests stop escalation, not reconnect behavior. In
      // particular, a failed setup must not retry after its helper is removed.
      maxRestarts: 0,
      onState: (state: { state: string; code?: string; message?: string }) => {
        states.push(state);
        if (state.state === 'active') ready = true;
      },
      onChunk: (chunk: { path: string }) => rmSync(chunk.path, { force: true }),
    };
    // Execute the installed runtime directly: fresh executable shebang scripts
    // incur variable OS launch overhead unrelated to capture shutdown.
    const capture = source === 'microphone'
      ? startMicrophoneCapture({ ...options, command: process.execPath, commandArgs: [helper] })
      : startSystemAudioCapture({ ...options, helperPath: process.execPath, helperArgs: [helper] });
    try {
      // Child startup can approach a second during the full local CI run.
      // Give setup its own budget; shutdown still must escalate to SIGKILL.
      const deadline = Date.now() + 3_000;
      while (!ready && Date.now() < deadline) await Bun.sleep(5);
      expect(ready, `Capture fixture did not become active: ${JSON.stringify(states)}`).toBe(true);
      const stoppingAt = performance.now();
      capture.stop();
      await capture.done;
      expect(capture.process?.signalCode).toBe('SIGKILL');
      expect(performance.now() - stoppingAt).toBeLessThan(4_500);
    } finally {
      capture.stop();
      if (capture.process?.exitCode === null && capture.process.signalCode === null) capture.process.kill('SIGKILL');
      await capture.done;
      rmSync(root, { recursive: true, force: true });
    }
  }, 8_000);
}

/** Whether a process is still running. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const source of ['microphone', 'system-audio'] as const) {
  test(`${source} stop ends a relaunched helper whose copy ignores stops and holds the pipes`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-relaunched-capture-'));
    const helper = join(root, 'helper.ts');
    const copyPid = join(root, 'copy.pid');
    // Like the native helpers: a proxy that relaunches itself, forwards stop
    // signals to the copy, and leaves the copy holding stdout and stderr.
    writeFileSync(helper, `
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
const copy = spawn('/bin/sh', ['-c', "trap '' INT TERM HUP; while :; do sleep 1; done"], { stdio: ['ignore', 'inherit', 'inherit'] });
writeFileSync(${JSON.stringify(copyPid)}, String(copy.pid));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => copy.kill(signal));
process.stderr.write(JSON.stringify({type:'first-buffer',capturedAtUnixMs:Date.now()})+'\\n');
process.stdout.write(Buffer.alloc(3200));
setInterval(() => {}, 100);
`, { mode: 0o600 });
    let ready = false;
    const options = {
      sessionStartedAtUnixMs: Date.now(),
      maxRestarts: 0,
      onState: (state: { state: string }) => { if (state.state === 'active') ready = true; },
      onChunk: (chunk: { path: string }) => rmSync(chunk.path, { force: true }),
    };
    const capture = source === 'microphone'
      ? startMicrophoneCapture({ ...options, command: process.execPath, commandArgs: [helper] })
      : startSystemAudioCapture({ ...options, helperPath: process.execPath, helperArgs: [helper] });
    let pid: number | undefined;
    try {
      const deadline = Date.now() + 3_000;
      while ((!ready || !pid) && Date.now() < deadline) {
        await Bun.sleep(5);
        try { pid = Number(readFileSync(copyPid, 'utf8')) || undefined; } catch {}
      }
      expect(ready && pid !== undefined).toBe(true);
      const stoppingAt = performance.now();
      capture.stop();
      const outcome = await Promise.race([capture.done.then(() => 'stopped'), Bun.sleep(7_000).then(() => 'hung')]);
      expect(outcome).toBe('stopped');
      expect(performance.now() - stoppingAt).toBeLessThan(6_000);
      // The relaunched copy went with it.
      await Bun.sleep(50);
      expect(alive(pid!)).toBe(false);
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
      if (capture.process?.exitCode === null && capture.process.signalCode === null) capture.process.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 12_000);
}

test('a stop always settles: a source that never finishes cannot hold the recording open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-stop-deadline-'));
  const errors: string[] = [];
  const never = { process: undefined, done: new Promise<void>(() => {}), stop() {} };
  const capture = startDurableLiveCapture({
    libraryDir: root, stopDeadlineMs: 300,
    microphoneStarter: () => ({ ...never, process: {} as never }),
    systemAudioStarter: () => never,
    onError: (error) => errors.push(error.message),
  });
  try {
    const outcome = await Promise.race([capture.stop('test').then(() => 'settled', () => 'settled'), Bun.sleep(3_000).then(() => 'hung')]);
    expect(outcome).toBe('settled');
    expect(errors.some((message) => message.includes('did not stop'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
