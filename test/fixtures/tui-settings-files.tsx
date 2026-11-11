import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FeatureStatusDependencies } from '../../src/feature-status.ts';

// Made-up data only: a pretend library, prompts, extractors and voices in a temporary folder.
const root = mkdtempSync(join(tmpdir(), 'seashell-settings-files-'));
const library = join(root, 'Transcripts');
mkdirSync(library, { recursive: true });
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = library;
process.env.SEASHELL_VOICES_DIR = join(root, 'Voices');
for (const variable of ['SEASHELL_PROMPTS_DIR', 'SEASHELL_EXTRACTORS_DIR', 'SEASHELL_AUTOMATIONS_DIR']) delete process.env[variable];
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { speakerBrowser: 'auto' } }));
const columns = process.argv[2] === 'narrow' ? 56 : 100;
const narrow = columns < 72;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 30 });

const { ensurePromptsDirectory, listPrompts, writePrompt } = await import('../../src/prompts.ts');
const { listVoiceprints } = await import('../../src/voiceprints.ts');
const { loadConfig } = await import('../../src/config.ts');
ensurePromptsDirectory(library);
writePrompt(library, 'notes', 'Only bullet points.\n');
const people = join(root, 'Voices', 'people');
mkdirSync(people, { recursive: true });
for (const name of ['Dana', 'Priya']) {
  writeFileSync(join(people, `${name.toLowerCase()}.json`), JSON.stringify({ version: 1, name,
    samples: [{ transcriptId: 'fixture', speakerId: 'REMOTE_00', embedding: [0.1, 0.2], seconds: 30, savedAt: new Date().toISOString() }] }));
}

let screenAllowed = false;
const dependencies: FeatureStatusDependencies = {
  launchAtLogin: () => ({ enabled: true, loaded: true, label: 'fixture', plistPath: '/fixture', command: [] }),
  watchStatus: () => ({ schemaVersion: 1, phase: 'watching', pid: 1, updatedAtUnixMs: Date.now() }),
  meetConnection: async () => ({ state: 'idle', detail: 'Join a call', accessibilityTrusted: true }),
  microphone: async () => ({ authorization: 'authorized', detail: 'Allowed.' }),
  lastMeeting: () => ({ title: 'Weekly sync', createdAt: new Date().toISOString(), microphoneChunks: 3,
    audibleMicrophoneChunks: 3, computerChunks: 3, audibleComputerChunks: 3 }),
  speakerSeparationReady: () => true, aiEngineInstalled: () => true, transcriptionReady: () => true, systemAudioHelperReady: () => true,
  microphoneRecorderSince: () => 0, systemAudioRecorderSince: () => 0, audioChecks: () => ({}),
  screenRecording: async () => ({ authorization: screenAllowed ? 'authorized' : 'notDetermined', detail: 'fixture' }),
};

const { default: SettingsScreen } = await import('../../src/SettingsScreen.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows: 30 });
const opened: string[] = [];
const folders: string[] = [];
let screenRequests = 0;
let computerChecks = 0;
const app = render(<SettingsScreen config={loadConfig()} libraryDir={library} columns={columns} rows={30} dependencies={dependencies}
  actions={{ openFile: (path) => { opened.push(path); }, openFolder: (path) => { folders.push(path); },
    allowScreenRecording: async () => { screenRequests++; screenAllowed = true; return { authorization: 'authorized', detail: 'Allowed.' }; },
    checkComputerAudio: async () => { computerChecks++;
      return { heard: true, refused: false, detail: 'Heard your Mac through Seashell System Audio. Meetings use it from the next call.' }; } }}
  onConnectMeet={() => {}} onEnableCalendar={() => {}} onOpenSpeakers={() => {}} onOpenAI={() => {}} onClose={() => {}} />,
{ stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
const frame = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('Settings') - 4));
const until = async (check: () => boolean, label: string) => {
  const end = Date.now() + 3000;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  assert.ok(check(), `${label}\n${frame()}`);
};
const type = async (...keys: string[]) => { for (const key of keys) { input.write(key); await Bun.sleep(60); } };
const DOWN = '\x1b[B', LEFT = '\x1b[D', ENTER = '\r';
try {
  await until(() => frame().includes('Saved voices'), 'Settings lists saved voices');
  // Saved voices: choose one, and forget them only after a yes.
  await type(...Array(9).fill(DOWN), ENTER);
  await until(() => frame().includes('Enter forget'), 'Enter chooses among the people');
  await type(ENTER);
  await until(() => frame().includes("Forget Dana's voice?"), 'forgetting asks first');
  assert.equal(listVoiceprints().length, 2, 'nothing is forgotten before the yes');
  await type('n');
  await until(() => !frame().includes('y yes'), 'n keeps the voice');
  assert.equal(listVoiceprints().length, 2);
  await type(ENTER, 'y');
  await until(() => listVoiceprints().length === 1, 'y forgets the voice');
  assert.deepEqual(listVoiceprints().map((voice) => voice.name), ['Priya']);

  // Prompts: Enter opens one in the editor; d puts it back as shipped after a yes.
  await type(LEFT, DOWN, DOWN, DOWN, ENTER, DOWN);
  await until(() => frame().includes('d put back as shipped'), 'an edited prompt can be put back');
  await type(ENTER);
  await until(() => opened.length === 1, 'Enter opens the prompt');
  assert.ok(opened[0]!.endsWith('notes.md'));
  await type('d');
  await until(() => frame().includes('Put Final notes back as shipped?'), 'putting back asks first');
  await type('y');
  await until(() => listPrompts(library).find((prompt) => prompt.name === 'notes')?.state === 'default', 'the prompt is as shipped again');

  // Extractors: Enter opens the folder, made with its example the first time.
  await type(LEFT, DOWN, ENTER);
  if (narrow) await type(ENTER);
  await until(() => folders.length === 1, 'Enter opens the extractors folder');
  assert.ok(existsSync(join(folders[0]!, 'customer-pains.md')), 'the folder starts with an example');

  // Video: Enter asks macOS for Screen Recording; space turns video off.
  await type(LEFT, DOWN, DOWN, DOWN);
  if (narrow) await type(ENTER);
  await until(() => frame().includes('needs Screen Recording'), 'video is on but not allowed');
  await type(ENTER);
  await until(() => screenRequests === 1 && frame().includes('Screen Recording allowed'), 'Enter allows Screen Recording');
  await type(' ');
  await until(() => JSON.parse(readFileSync(process.env.SEASHELL_CONFIG!, 'utf8')).meeting.video?.enabled === false, 'space turns video off');
  await until(() => frame().includes('Off · calls record audio only'), 'the item says it is off');

  // Computer audio: the one-time check that lets meetings use Seashell System Audio.
  await type(LEFT, ...Array(11).fill('\x1b[A'));
  if (narrow) await type(ENTER);
  await until(() => frame().includes('Enter check computer audio'), 'computer audio offers the check');
  // Wide, the detail wraps beside the menu's border; read the words only.
  const words = () => frame().split('\n').map((line) => line.split('│').at(-1)!.trim()).join(' ').replace(/\s+/gu, ' ');
  assert.ok(words().includes("background recorder's permission until you allow computer audio for Seashell System Audio"), words());
  await type(ENTER);
  await until(() => computerChecks === 1 && words().includes('Meetings use it from the next call'), 'Enter runs the check and says what it found');
  for (const line of frame().split('\n')) assert.ok(Bun.stringWidth(line) <= columns, `fits ${columns} columns: ${line}`);
  console.log(JSON.stringify({ passed: true }));
} finally {
  app.unmount();
  rmSync(root, { recursive: true, force: true });
}
