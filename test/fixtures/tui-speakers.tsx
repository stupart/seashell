import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const root = mkdtempSync(join(tmpdir(), 'seashell-speakers-ui-'));
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = join(root, 'library');
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { automation: { enabled: false } } }));
let starts = 0, stops = 0, setups = 0, ready = false;
const mic = { ...await import('../../src/live-microphone.ts') };
const environment = { ...await import('../../src/diarization-environment.ts') };
const meet = { ...await import('../../src/meet-speakers.ts') };
mock.module('../../src/meet-speakers.ts', () => ({ ...meet, async probeMeetSpeakers(mode: string) {
  assert.equal(mode, 'auto', 'Connection checks both browsers without asking which to use');
  return { state: 'permission', detail: 'Enable Allow JavaScript from Apple Events.' };
} }));
mock.module('../../src/live-microphone.ts', () => ({ ...mic, startMicrophoneCapture(options: any) {
  starts++; options.onState({ state: 'active' });
  return { done: Promise.resolve(), startup: Promise.resolve(), stop() { stops++; } };
} }));
mock.module('../../src/diarization-environment.ts', () => ({ ...environment, diarizationStatus() {
  return { ready, model: 'fixture', python: '/fixture/python' };
} }));
mock.module('../../src/diarization-setup.ts', () => ({ async setupDiarization(options: any) {
  setups++; options.onStatus?.('Verifying fixture model…'); await Bun.sleep(40); ready = true;
  return { ready: true, stage: 'ready', detail: 'Model verified offline.', model: 'fixture' };
} }));
const columns = process.argv[2] === 'narrow' ? 48 : 100;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 24 });
const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows: 24 });
const app = render(<App />, { stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
const plain = () => stripVTControlCharacters(rendered).replace(/\s+/g, ' ');
const until = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await Bun.sleep(10); assert.ok(check(), 'UI condition timed out'); };
const type = async (text: string) => { input.write(text); await Bun.sleep(80); };
try {
  await until(() => starts === 1);
  await type('v'); await until(() => plain().includes('Optional setup'));
  await type('\r'); await until(() => plain().includes('Allow JavaScript from Apple Events'));
  assert.equal(JSON.parse(readFileSync(process.env.SEASHELL_CONFIG!, 'utf8')).meeting.speakerBrowser, 'auto');
  assert.equal(starts, 1, 'Connecting Meet preserves the running microphone');
  for (let n = 0; n < 3; n++) await type('\x1b[B');
  await type('\r'); assert.equal(setups, 0, 'Do not install while recording');
  assert.equal(stops, 0, 'Opening speaker settings preserves capture');
  await type('\x1b'); await type(' '); await until(() => stops === 1);
  await type('F'); await until(() => plain().includes('Optional setup'));
  for (let n = 0; n < 4; n++) await type('\x1b[B');
  await until(() => plain().includes('contact sharing'));
  await type('\r'); await until(() => plain().includes('Model verified offline'));
  assert.equal(setups, 1);
  assert.ok(stripVTControlCharacters(rendered).includes('Ready'));
  await type('\x1b[B'); await type('\r');
  assert.ok(plain().includes('Open a saved recording'));
  if (process.env.SEASHELL_TUI_EVIDENCE) writeFileSync(process.env.SEASHELL_TUI_EVIDENCE, stripVTControlCharacters(rendered));
  console.log(JSON.stringify({ passed: true }));
} finally { app.unmount(); rmSync(root, { recursive: true, force: true }); }
