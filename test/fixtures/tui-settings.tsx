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

const root = mkdtempSync(join(tmpdir(), 'seashell-settings-ui-'));
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = join(root, 'library');
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
// Never open real audio devices or ask macOS for permission from a test.
process.env.SEASHELL_DISABLE_LISTENER = '1';
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { speakerBrowser: 'auto', automation: { enabled: false } } }));
const columns = process.argv[2] === 'narrow' ? 48 : 110;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 30 });

let micAllowed = false;
const dependencies: FeatureStatusDependencies = {
  launchAtLogin: () => ({ enabled: true, loaded: true, label: 'fixture', plistPath: '/fixture', command: [] }),
  watchStatus: () => ({ schemaVersion: 1, phase: 'watching', pid: 1, updatedAtUnixMs: Date.now() }),
  meetConnection: async () => ({ state: 'idle', detail: 'Join a call', accessibilityTrusted: true }),
  microphone: async () => micAllowed
    ? { authorization: 'authorized', detail: 'Allowed.' } : { authorization: 'notDetermined', detail: 'Not asked.' },
  lastMeeting: () => ({ title: 'Weekly sync', createdAt: new Date().toISOString(), microphoneChunks: 3,
    audibleMicrophoneChunks: 0, computerChunks: 3, audibleComputerChunks: 3, meetingKey: 'meet:safari:/abc-defg-hij' }),
  speakerSeparationReady: () => false, aiEngineInstalled: () => true,
  transcriptionReady: () => true, systemAudioHelperReady: () => true,
  // The silent meeting happened after the native recorder was installed: a real problem.
  microphoneRecorderSince: () => Date.now() - 86_400_000,
};
// The app's own Settings and header nudge must use fixture machine state, never this Mac's.
const real = { ...await import('../../src/feature-status.ts') };
mock.module('../../src/feature-status.ts', () => ({ ...real,
  readFeatureStatuses: (options: any) => real.readFeatureStatuses({ ...options, dependencies }) }));

const { default: SettingsScreen } = await import('../../src/SettingsScreen.tsx');
const terminal = () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let rendered = '';
  const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows: 30 });
  // Only the latest frame: earlier frames must not satisfy later assertions.
  const frame = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('Settings') - 2)).replace(/\s+/g, ' ');
  lastOutput = () => stripVTControlCharacters(rendered);
  // Wrapped lines inside the bordered panel interleave border glyphs; read text only.
  return { input, output, frame, all: () => stripVTControlCharacters(rendered).replace(/[│╭╮╰╯─]/gu, ' ').replace(/\s+/g, ' ') };
};
let lastOutput = () => '';
const until = async (check: () => boolean, label: string) => {
  const end = Date.now() + 3000;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  if (!check()) console.error(`LAST OUTPUT: ${lastOutput().slice(-1500)}`);
  assert.ok(check(), `UI condition timed out: ${label}`);
};

try {
  const t = terminal();
  let closed = 0, speakers = 0, connects = 0, permissionRequests = 0;
  const app = render(<SettingsScreen config={{ meeting: { speakerBrowser: 'auto' } }} libraryDir={join(root, 'library')} columns={columns}
    dependencies={dependencies}
    actions={{ allowMicrophone: async () => { permissionRequests++; micAllowed = true; return { authorization: 'authorized', detail: 'Allowed.' }; } }}
    onConnectMeet={() => connects++} onOpenSpeakers={() => speakers++} onOpenAI={() => {}} onClose={() => closed++} />,
  { stdin: t.input as any, stdout: t.output as any, stderr: t.output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
  const type = async (text: string) => { t.input.write(text); await Bun.sleep(60); };

  await until(() => t.all().includes('thing needs you'), 'overview');
  assert.ok(t.all().includes(columns < 72 ? 'Microphone' : 'Your microphone'), 'Overview lists the microphone');
  assert.ok(t.all().includes('Not allowed yet'));
  assert.ok(t.all().includes('Chrome only · you used Safari'), 'Evidence from the last meeting is shown');
  assert.ok(t.all().includes('Optional'));
  assert.equal(permissionRequests, 0, 'Opening Settings never asks for permission');

  await type('\r');
  await until(() => t.all().includes('[Enter] Allow microphone'), 'Enter jumps to the first item that needs you');
  assert.ok(t.all().includes('Choose Allow when macOS asks'));
  await type('\r');
  await until(() => t.all().includes('Microphone allowed'), 'allow microphone');
  assert.equal(permissionRequests, 1);
  await until(() => t.all().includes('Allowed · last meeting silent'), 'statuses refresh after a fix');

  for (let n = 0; n < 4; n++) await type('\x1b[B');
  await until(() => t.all().includes('[Enter] Open speaker setup'), 'speaker separation page');
  await type('\r');
  assert.equal(speakers, 1, 'Speaker setup opens from Settings');
  await type('\x1b');
  assert.equal(closed, 1, 'Esc closes Settings');
  app.unmount();

  // From the main app: the header points to Settings, and , opens and closes it.
  micAllowed = false;
  const { default: App } = await import('../../src/app.tsx');
  const main = terminal();
  const shell = render(<App />, { stdin: main.input as any, stdout: main.output as any, stderr: main.output as any,
    debug: true, patchConsole: false, exitOnCtrlC: false });
  const press = async (text: string) => { main.input.write(text); await Bun.sleep(80); };
  await until(() => main.all().includes('Setup needed · press ,'), 'header nudge when something required is broken');
  await press(',');
  await until(() => main.all().includes('Checking what works') || main.all().includes('thing needs you'), 'comma opens Settings');
  await until(() => main.all().includes('Esc close'), 'settings footer');
  await press('\x1b');
  await until(() => main.all().lastIndexOf('Sea Shell') > main.all().lastIndexOf('Esc close'), 'Esc returns to the app');
  shell.unmount();
  console.log(JSON.stringify({ passed: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
