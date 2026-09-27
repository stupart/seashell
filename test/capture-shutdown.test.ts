import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
