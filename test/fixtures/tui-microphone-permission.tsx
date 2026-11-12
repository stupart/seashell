import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FeatureStatusDependencies } from '../../src/feature-status.ts';

const root = mkdtempSync(join(tmpdir(), 'seashell-mic-permission-ui-'));
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = join(root, 'library');
process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
// Never open real audio devices or permission prompts from a test.
process.env.SEASHELL_DISABLE_LISTENER = '1';
// Set up before, so the guide is offered rather than opened, and the background recorder runs.
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { automation: { enabled: true } } }));
Object.defineProperty(process.stdout, 'columns', { value: 100 });
Object.defineProperty(process.stdout, 'rows', { value: 24 });
mock.module('../../src/watch-lock.ts', () => ({ acquireMeetingWatchLock: () => undefined }));

// After an update replaced Seashell Microphone, macOS has not decided on the new copy.
const mac = { microphone: 'notDetermined' as 'notDetermined' | 'authorized' };
const dependencies: FeatureStatusDependencies = {
  launchAtLogin: () => ({ enabled: true, loaded: true, label: 'fixture', plistPath: '/fixture', command: [] }),
  watchStatus: () => ({ schemaVersion: 1, phase: 'watching', pid: 1, updatedAtUnixMs: Date.now() }),
  meetConnection: async () => ({ state: 'idle', detail: 'Join a call', accessibilityTrusted: true }),
  microphone: async () => ({ authorization: mac.microphone, detail: 'Fixture.' }),
  audioChecks: () => ({ computer: new Date().toISOString() }),
  lastMeeting: () => undefined,
  speakerSeparationReady: () => true, aiEngineInstalled: () => false,
  transcriptionReady: () => true, systemAudioHelperReady: () => true,
  microphoneRecorderSince: () => Date.now() - 86_400_000,
  systemAudioRecorderSince: () => Date.now() - 86_400_000,
};
const real = { ...await import('../../src/feature-status.ts') };
mock.module('../../src/feature-status.ts', () => ({ ...real,
  readFeatureStatuses: (options: any) => real.readFeatureStatuses({ ...options, dependencies }) }));
let asked = 0;
// The first time, macOS has already said no: its Privacy pane opens instead. The second, it is allowed.
let denied = true;
const permission = await import('../../src/microphone-permission.ts');
mock.module('../../src/microphone-permission.ts', () => ({ ...permission,
  allowMicrophone: async () => {
    asked++;
    if (denied) { denied = false; return { authorization: 'denied', detail: 'Microphone access is off for Seashell Microphone.' }; }
    mac.microphone = 'authorized'; return { authorization: 'authorized', detail: 'Allowed.' };
  } }));

const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns: 100, rows: 24 });
const plain = () => stripVTControlCharacters(rendered).replace(/\s+/g, ' ');
const since = (marker: string) => plain().slice(plain().lastIndexOf(marker));
const until = async (check: () => boolean, label: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  if (!check()) console.error(`LAST OUTPUT: ${stripVTControlCharacters(rendered).slice(-1500)}`);
  assert.ok(check(), `UI condition timed out: ${label}`);
};
const app = render(<App openSettings={() => {}} />,
  { stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
try {
  await until(() => plain().includes("Can't record yet") && plain().includes('Enter allow mic'), 'launch offers the microphone prompt on Enter');
  assert.ok(!plain().includes('Guided setup'), 'not the guide first');
  input.write('\r');
  await until(() => asked === 1 && plain().includes('Opening Privacy & Security: turn on Seashell Microphone.'),
    'once macOS has said no, the toast says what to turn on in the pane that opens');
  await Bun.sleep(100);
  input.write('\r');
  await until(() => asked === 2 && since('Enter allow mic').includes('Microphone allowed'), 'Enter asks macOS, and says it worked');
  assert.ok(!plain().includes('Guided setup'), 'Enter asked for the microphone instead of opening the guide');
  console.log(JSON.stringify({ passed: true }));
} finally {
  app.unmount();
  rmSync(root, { recursive: true, force: true });
}
