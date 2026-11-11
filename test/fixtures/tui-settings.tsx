import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FeatureStatusDependencies } from '../../src/feature-status.ts';

const root = mkdtempSync(join(tmpdir(), 'seashell-settings-ui-'));
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = join(root, 'library');
process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
// Never open real audio devices or ask macOS for permission from a test.
process.env.SEASHELL_DISABLE_LISTENER = '1';
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { speakerBrowser: 'auto', automation: { enabled: false } } }));
const columns = process.argv[2] === 'narrow' ? 48 : 110;
// Narrow, the list fills the screen and Enter opens an item; wide, the item sits beside the list.
const narrow = columns < 72;
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
  systemAudioRecorderSince: () => Date.now() - 86_400_000,
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
  const end = Date.now() + 10_000;
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
    onConnectMeet={() => connects++} onEnableCalendar={() => {}} onOpenSpeakers={() => speakers++} onOpenAI={() => {}} onClose={() => closed++} />,
  { stdin: t.input as any, stdout: t.output as any, stderr: t.output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
  const type = async (text: string) => { t.input.write(text); await Bun.sleep(60); };

  // The title counts from the rows the list marks: the microphone to fix, then the extras.
  await until(() => t.all().includes('Recording needs 1 fix') || t.all().includes('1 to fix'), 'summary line');
  assert.ok(t.all().includes('Speakers') && t.all().includes('Extras'), 'the list has sections');
  assert.equal(permissionRequests, 0, 'Opening Settings never asks for permission');
  if (narrow) {
    await until(() => t.frame().includes('Not allowed yet'), 'the list says how each item stands');
    await type('\r');
  }
  await until(() => t.all().includes('Enter allow microphone'), 'Settings opens on the first item that needs you');
  assert.ok(t.all().includes('Not allowed yet'));
  assert.ok(t.all().includes('Choose Allow when macOS asks'));
  await type('\r');
  await until(() => t.all().includes('Microphone allowed'), 'allow microphone');
  assert.equal(permissionRequests, 1);
  await until(() => t.all().includes('Allowed · last meeting silent'), 'statuses refresh after a fix');
  if (narrow) await type('\x1b');

  for (let n = 0; n < 3; n++) await type('\x1b[B');
  if (narrow) await type('\r');
  await until(() => t.all().includes('Chrome only · you used Safari'), 'Evidence from the last meeting is shown');
  if (narrow) await type('\x1b');
  await type('\x1b[B');
  if (narrow) await type('\r');
  await until(() => t.all().includes('Enter open speaker setup'), 'speaker separation page');
  await type('\r');
  assert.equal(speakers, 1, 'Speaker setup opens from Settings');
  if (narrow) {
    await type('\x1b');
    assert.equal(closed, 0, 'Esc first returns from an item to the list');
  }
  await type('\x1b');
  assert.equal(closed, 1, 'Esc closes Settings');
  app.unmount();

  // Recording: the rule for every call, then each app. FaceTime off, the rest on.
  const { loadConfig } = await import('../../src/config.ts');
  const saved = () => JSON.parse(readFileSync(process.env.SEASHELL_CONFIG!, 'utf8')).meeting.automation;
  const r = terminal();
  let guides = 0;
  const recording = render(<SettingsScreen config={loadConfig()} libraryDir={join(root, 'library')} columns={columns}
    dependencies={dependencies} onOpenGuide={() => guides++}
    onConnectMeet={() => {}} onEnableCalendar={() => {}} onOpenSpeakers={() => {}} onOpenAI={() => {}} onClose={() => {}} />,
  { stdin: r.input as any, stdout: r.output as any, stderr: r.output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
  const key = async (text: string) => { r.input.write(text); await Bun.sleep(60); };
  await until(() => r.all().includes('Which calls'), 'Which calls leads the list');
  for (let n = 0; n < 6; n++) await key('\x1b[A');
  await key('\r');
  await until(() => r.all().includes('Apps left blank follow this'), 'Enter changes the recording rows');
  // The fixture's settings turned recording off the old way; choosing a mode must turn it back on.
  await key('\x1b[C');
  await until(() => saved().mode === 'automatic' && saved().enabled === true, 'mode saved and in effect');
  for (let n = 0; n < 5; n++) await key('\x1b[B');
  await until(() => r.all().includes('FaceTime: follows Calls'), 'FaceTime row');
  await key('\x1b[D');
  await until(() => saved().apps?.facetime === 'off', 'FaceTime off saved');
  assert.ok(r.all().includes('FaceTime: never recorded'));
  assert.equal(saved().mode, 'automatic', 'Other apps still record by themselves');
  await key('\x1b[C');
  await until(() => saved().apps?.facetime === undefined, 'Default removes the app setting');
  await key('\x1b[D');
  await until(() => saved().apps?.facetime === 'off', 'FaceTime off again');
  await key('\x1b');
  await until(() => r.all().lastIndexOf('r recheck') > r.all().lastIndexOf('←→ change'), 'back on the list');
  // The guided setup is the last row.
  for (let n = 0; n < 20; n++) await key('\x1b[B');
  await key('\r');
  assert.equal(guides, 1, 'The guided setup starts from Settings');
  // A microphone that was silent is tested by listening to it, from its own item.
  for (let n = 0; n < 20; n++) await key('\x1b[A');
  for (let n = 0; n < 3; n++) await key('\x1b[B');
  if (narrow) await key('\r');
  await until(() => r.all().includes('Enter test it now'), 'a silent microphone offers a test');
  await key('\r');
  assert.equal(guides, 2, 'Enter on the microphone starts the guide');
  recording.unmount();
  writeFileSync(process.env.SEASHELL_CONFIG!, JSON.stringify({ meeting: { speakerBrowser: 'auto', automation: { enabled: false } } }));

  // From the main app: the header points to Settings, and , opens and closes it.
  micAllowed = false;
  const { default: App } = await import('../../src/app.tsx');
  const main = terminal();
  const shell = render(<App />, { stdin: main.input as any, stdout: main.output as any, stderr: main.output as any,
    debug: true, patchConsole: false, exitOnCtrlC: false });
  const press = async (text: string) => { main.input.write(text); await Bun.sleep(80); };
  // In the title's status slot; narrow, the key gives way to the words.
  await until(() => main.all().includes('Mic not allowed · , fixes') || narrow && main.all().includes('Mic not allowed'), 'the app says what is wrong and where to look');
  await press(',');
  await until(() => main.all().includes('Checking what works') || main.all().includes('to fix') || main.all().includes('needs 1 fix'), 'comma opens Settings');
  await until(() => main.all().includes('Esc back'), 'settings footer');
  await press('\x1b');
  await until(() => main.all().lastIndexOf('? help') > main.all().lastIndexOf('Esc back'), 'Esc returns to the app');
  shell.unmount();
  console.log(JSON.stringify({ passed: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
