import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FeatureStatusDependencies } from '../../src/feature-status.ts';

// Made-up data only: AI notes are chosen, and the pretend engine is older than this Seashell.
const root = mkdtempSync(join(tmpdir(), 'seashell-old-engine-'));
const library = join(root, 'Transcripts');
mkdirSync(library, { recursive: true });
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = library;
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { speakerBrowser: 'auto', backend: 'codex', model: 'fixture' } }));
const columns = process.argv[2] === 'narrow' ? 56 : 100;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 30 });

const dependencies: FeatureStatusDependencies = {
  launchAtLogin: () => ({ enabled: true, loaded: true, label: 'fixture', plistPath: '/fixture', command: [] }),
  watchStatus: () => ({ schemaVersion: 1, phase: 'watching', pid: 1, updatedAtUnixMs: Date.now() }),
  meetConnection: async () => ({ state: 'idle', detail: 'Join a call', accessibilityTrusted: true }),
  microphone: async () => ({ authorization: 'authorized', detail: 'Allowed.' }),
  lastMeeting: () => undefined,
  speakerSeparationReady: () => true, aiEngineInstalled: () => true, transcriptionReady: () => true, systemAudioHelperReady: () => true,
  microphoneRecorderSince: () => 0, systemAudioRecorderSince: () => 0, audioChecks: () => ({}),
  screenRecording: async () => ({ authorization: 'authorized', detail: 'fixture' }),
  engine: async () => new Set(['observe', 'reconcile', 'chat', 'extract']),
};

const { loadConfig } = await import('../../src/config.ts');
const { default: SettingsScreen } = await import('../../src/SettingsScreen.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows: 30 });
const copied: string[] = [];
const app = render(<SettingsScreen config={loadConfig()} libraryDir={library} columns={columns} rows={30} dependencies={dependencies} focus="ai-notes"
  actions={{ copy: (text) => { copied.push(text); } }}
  onConnectMeet={() => {}} onEnableCalendar={() => {}} onOpenSpeakers={() => {}} onOpenAI={() => {}} onClose={() => {}} />,
{ stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
const frame = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('Settings') - 4));
// Wide, the detail sits beside the list: read the column right of the rule.
const flat = () => frame().split('\n').map((line) => line.includes('│') ? line.slice(line.indexOf('│') + 1) : line).join(' ').replace(/\s+/gu, ' ');
const keyBar = () => frame().trimEnd().split('\n').at(-1)!.trim();
const until = async (check: () => boolean, label: string) => {
  const end = Date.now() + 10_000;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  assert.ok(check(), `${label}\n${frame()}`);
};
const type = async (...keys: string[]) => { for (const key of keys) { input.write(key); await Bun.sleep(60); } };
try {
  await until(() => frame().includes('AI engine too old'), 'Settings opens on AI notes');
  // Narrow, Enter opens the row's detail first.
  if (columns < 72) await type('\r');
  await until(() => flat().includes('Notes still work; typed notes, briefs and follow-ups need the newer engine.'), 'it says what still works, in plain words');
  await until(() => flat().includes('Next: Install the newer engine from its package file. c copies the command: paste it in Terminal, then drag the file in.'),
    'the next step says where the command goes');
  assert.ok(keyBar().startsWith('c copy the update command'), `the key that helps leads the key bar\n${keyBar()}`);
  assert.ok(!frame().includes('seashell ai') && !/press r/iu.test(flat()), 'no command is shown, and no key is promised to update it');
  await type('c');
  await until(() => keyBar() === 'Copied.', 'c says it copied, in green, in the key bar');
  assert.deepEqual(copied, ['seashell ai install ']);
  assert.ok(!frame().includes('seashell ai'), 'the command is copied, never shown');
  process.stdout.write(JSON.stringify({ passed: true }) + '\n');
} finally { app.unmount(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true }); }
