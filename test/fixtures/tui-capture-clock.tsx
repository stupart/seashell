import { mock } from 'bun:test';
import React from 'react';
import { PassThrough, Writable } from 'stream';
import { render } from 'ink';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StartMicrophoneOptions } from '../../src/live-microphone.ts';
import type { StartSystemAudioOptions } from '../../src/live-system-audio.ts';
import type { MeetingSignalSnapshot } from '../../src/meeting-automation.ts';

// Run in a subprocess: module mocks and the virtual idle clock cannot leak into
// other tests, and no real microphone, meeting watcher, or user library opens.
const root = mkdtempSync(join(tmpdir(), 'seashell-tui-clock-'));
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = join(root, 'library');
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({
  meeting: { automation: { enabled: true } },
}));
const realNow = Date.now.bind(Date);
let now = realNow();
Date.now = () => now;
const starts: Array<{ source: string; clock: number; now: number }> = [];
const microphone = { ...await import('../../src/live-microphone.ts') };
const system = { ...await import('../../src/live-system-audio.ts') };
const automation = { ...await import('../../src/meeting-automation.ts') };
let signal: ((snapshot: MeetingSignalSnapshot) => void) | undefined;
mock.module('../../src/watch-lock.ts', () => ({
  acquireMeetingWatchLock: () => ({ release() {} }),
}));
mock.module('../../src/meeting-automation.ts', () => ({
  ...automation,
  MeetingSignalMonitor: class {
    subscribe(callback: typeof signal) { signal = callback; return () => {}; }
    onError() { return () => {}; }
    start() {}
    stop() {}
  },
}));
const capture = (source: string, options: StartMicrophoneOptions | StartSystemAudioOptions) => {
  starts.push({ source, clock: options.sessionStartedAtUnixMs, now });
  options.onState({ state: 'active' });
  return { done: Promise.resolve(), startup: Promise.resolve(), stop() {} };
};
mock.module('../../src/live-microphone.ts', () => ({
  ...microphone, startMicrophoneCapture: (options: StartMicrophoneOptions) => capture('microphone', options),
}));
mock.module('../../src/live-system-audio.ts', () => ({
  ...system, startSystemAudioCapture: (options: StartSystemAudioOptions) => capture('system', options),
}));
const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
const output = Object.assign(new Writable({ write(_chunk, _encoding, callback) { callback(); } }), { columns: 100, rows: 28 });
const app = render(<App />, {
  stdin: input as unknown as NodeJS.ReadStream,
  stdout: output as unknown as NodeJS.WriteStream,
  stderr: output as unknown as NodeJS.WriteStream,
  patchConsole: false, exitOnCtrlC: false,
});
const settle = () => Bun.sleep(50);
const until = async (check: () => boolean) => {
  const deadline = realNow() + 3000;
  while (!check() && realNow() < deadline) await Bun.sleep(10);
  if (!check()) throw new Error('TUI did not enter the expected capture state');
};
try {
  await until(() => Boolean(signal));
  now += 2 * 60 * 60 * 1000;
  if (process.argv[2] === 'meeting') {
    const snapshot = { schemaVersion: 1 as const, supported: true,
      inputProcesses: [{ pid: 42, bundleId: 'com.google.Chrome', name: 'Google Chrome' }] };
    signal!({ ...snapshot, capturedAtUnixMs: now - 3000 });
    signal!({ ...snapshot, capturedAtUnixMs: now });
    await settle();
    input.write('m');
  } else input.write(' ');
  await until(() => starts.length === 2);
  // A pause after capture begins retains the original meeting clock.
  input.write(' ');
  await settle();
  now += 60_000;
  input.write(' ');
  await until(() => starts.length === 4);
  // Clearing a paused session must also defer the next clock until recording.
  input.write(' ');
  await settle();
  input.write('\x7f');
  await settle();
  now += 4 * 60 * 60 * 1000;
  input.write(' ');
  await until(() => starts.length === 6);
  input.write('q');
  await app.waitUntilExit();
  process.stdout.write(`${JSON.stringify(starts)}\n`);
} finally {
  app.unmount();
  input.destroy();
  output.destroy();
  Date.now = realNow;
  rmSync(root, { recursive: true, force: true });
}
