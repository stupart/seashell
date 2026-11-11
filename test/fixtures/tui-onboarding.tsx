import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FeatureStatusDependencies } from '../../src/feature-status.ts';
import type { LevelSource } from '../../src/Onboarding.tsx';

const root = mkdtempSync(join(tmpdir(), 'seashell-onboarding-ui-'));
// No settings file: Seashell has never been set up here.
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = join(root, 'library');
process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
// Never open real audio devices, launch agents or permission prompts from a test.
process.env.SEASHELL_DISABLE_LISTENER = '1';
const columns = process.argv[2] === 'narrow' ? 56 : 100;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 24 });
mock.module('../../src/watch-lock.ts', () => ({ acquireMeetingWatchLock: () => undefined }));

const mac = { recorder: false, microphone: false, meet: false };
const dependencies: FeatureStatusDependencies = {
  launchAtLogin: () => ({ enabled: mac.recorder, loaded: mac.recorder, label: 'fixture', plistPath: '/fixture', command: [] }),
  watchStatus: () => mac.recorder ? { schemaVersion: 1, phase: 'watching', pid: 1, updatedAtUnixMs: Date.now() } : undefined,
  meetConnection: async () => mac.meet
    ? { state: 'idle', detail: 'Join a call', accessibilityTrusted: true } : { state: 'off', detail: 'Off', accessibilityTrusted: false },
  microphone: async () => mac.microphone
    ? { authorization: 'authorized', detail: 'Allowed.' } : { authorization: 'notDetermined', detail: 'Not asked.' },
  lastMeeting: () => undefined,
  speakerSeparationReady: () => false, aiEngineInstalled: () => false,
  transcriptionReady: () => true, systemAudioHelperReady: () => true,
  microphoneRecorderSince: () => Date.now() - 86_400_000,
};
const real = { ...await import('../../src/feature-status.ts') };
mock.module('../../src/feature-status.ts', () => ({ ...real,
  readFeatureStatuses: (options: any) => real.readFeatureStatuses({ ...options, dependencies }) }));

// A pretend room: the meters hear whatever these are set to.
const room = { microphone: { peak: 0, rmsDbfs: Number.NEGATIVE_INFINITY }, computer: { peak: 0, rmsDbfs: Number.NEGATIVE_INFINITY } };
const opened = { microphone: 0, computer: 0 };
const released = { microphone: 0, computer: 0 };
const pretend = (which: 'microphone' | 'computer'): LevelSource => ({ onLevel }) => {
  opened[which]++;
  const timer = setInterval(() => onLevel({ ...room[which], rms: 0 }), 50);
  return () => { released[which]++; clearInterval(timer); };
};
const calls = { recorder: 0, microphone: 0, meet: 0, panes: [] as string[] };
const actions = {
  enableRecorder: () => { calls.recorder++; mac.recorder = true; },
  allowMicrophone: async () => { calls.microphone++; mac.microphone = true; return { authorization: 'authorized', detail: 'Allowed.' }; },
  connectMeet: async () => { calls.meet++; mac.meet = true; return { detail: 'Google Meet connected.' }; },
};

const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows: 24 });
const plain = () => stripVTControlCharacters(rendered).replace(/\s+/g, ' ');
/** Only what came after a marker, so earlier frames cannot satisfy a later check. */
const since = (marker: string) => plain().slice(plain().lastIndexOf(marker));
const until = async (check: () => boolean, label: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  if (!check()) console.error(`LAST OUTPUT: ${stripVTControlCharacters(rendered).slice(-1500)}`);
  assert.ok(check(), `UI condition timed out: ${label}`);
};
const type = async (text: string) => { input.write(text); await Bun.sleep(80); };
const levels = { microphone: pretend('microphone'), computer: pretend('computer') };
const app = render(<App levels={levels} setupActions={actions} openSettings={(pane) => calls.panes.push(pane)} />,
  { stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
try {
  await until(() => plain().includes('Background recorder') && plain().includes('Step 1 of 4'), 'a first run opens the guide by itself');
  await type('\r');
  await until(() => since('Background recorder').includes('Running'), 'the recorder starts');
  assert.equal(calls.recorder, 1, 'Enter starts the recorder through the same action as Settings');

  await type('\r');
  await until(() => plain().includes('Seashell Microphone') && plain().includes('Step 2 of 4'), 'microphone permission');
  assert.equal(opened.microphone, 0, 'The microphone is not opened before macOS allows it');
  await type('\r');
  await until(() => opened.microphone === 1 && plain().includes('Listening'), 'listening once allowed');
  assert.equal(calls.microphone, 1);

  // Digital zeros, exactly what a muted or wrong input sends while macOS says "allowed".
  await until(() => plain().includes('sending silence, not sound'), 'silence is explained', 8000);
  assert.ok(plain().includes('Check the input in Sound settings'));
  await type('o');
  assert.deepEqual(calls.panes, ['sound-input'], 'o opens Sound input');

  room.microphone = { peak: 9000, rmsDbfs: -24 };
  await until(() => plain().includes('Heard you'), 'speech passes');
  await until(() => released.microphone === 1, 'the microphone is let go once it passed');

  await type('\r');
  await until(() => plain().includes('Play any sound') && plain().includes('Step 3 of 4'), 'computer audio');
  room.computer = { peak: 12000, rmsDbfs: -20 };
  await until(() => plain().includes('Heard your Mac'), 'computer audio passes');

  await type('\r');
  await until(() => plain().includes('Optional extras'), 'optional extras');
  await type('\r');
  await until(() => calls.meet === 1, 'Enter connects Google Meet');
  assert.equal(JSON.parse(readFileSync(process.env.SEASHELL_CONFIG!, 'utf8')).meeting.speakerBrowser, 'auto');
  for (let n = 0; n < 4; n++) await type('\x1b[B');
  await type('\r');
  await until(() => plain().includes("You're set"), 'the end says what works');
  await type('\r');
  await until(() => since("You're set").includes('Seashell is ready'), 'back in the app, nothing left to fix');
  app.unmount();

  // Later runs offer the guide instead of opening it; Enter takes it.
  mac.recorder = false;
  assert.ok(existsSync(process.env.SEASHELL_CONFIG!));
  rendered = '';
  const again = render(<App levels={levels} setupActions={actions} openSettings={() => {}} />,
    { stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
  await until(() => plain().includes('one step at a time'), 'the home screen offers the guide');
  assert.ok(!plain().includes('Guided setup'), 'not opened by itself after the first run');
  await type('\r');
  await until(() => plain().includes('Guided setup') && plain().includes('Background recorder'), 'Enter starts the guide');
  await type('\x1b');
  await until(() => since('Guided setup').includes('one step at a time'), 'Esc leaves it for later');
  again.unmount();

  // A window started with listening off never opens a real device, even for the guide.
  rendered = '';
  const off = render(<App setupActions={actions} openSettings={() => {}} />,
    { stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
  await until(() => plain().includes('one step at a time'), 'offered again');
  await type('\r');
  await until(() => plain().includes('Background recorder'), 'guide');
  await type('s');
  await until(() => plain().includes('Listening is turned off in this window'), 'no device is opened');
  off.unmount();
  console.log(JSON.stringify({ passed: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
