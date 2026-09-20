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
    writeFileSync(helper, `#!${process.execPath}
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
process.stderr.write(JSON.stringify({type:'first-buffer',capturedAtUnixMs:Date.now()})+'\\n');
process.stdout.write(Buffer.alloc(3200));
setInterval(() => {}, 100);
`, { mode: 0o755 });
    let ready = false;
    const options = {
      sessionStartedAtUnixMs: Date.now(),
      onState: (state: { state: string }) => { if (state.state === 'active') ready = true; },
      onChunk: (chunk: { path: string }) => rmSync(chunk.path, { force: true }),
    };
    const capture = source === 'microphone'
      ? startMicrophoneCapture({ ...options, command: helper, commandArgs: [] })
      : startSystemAudioCapture({ ...options, helperPath: helper });
    try {
      const deadline = Date.now() + 1_000;
      while (!ready && Date.now() < deadline) await Bun.sleep(5);
      expect(ready).toBe(true);
      capture.stop();
      await capture.done;
      expect(capture.process?.signalCode).toBe('SIGKILL');
    } finally {
      if (capture.process?.exitCode === null && capture.process.signalCode === null) capture.process.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 6_000);
}
