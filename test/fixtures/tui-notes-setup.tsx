import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTranscriptRecord } from '../../src/transcript-record.ts';
import { saveTranscriptRecord } from '../../src/transcript-library.ts';
import { createMeetingArtifact, saveMeetingArtifact } from '../../src/meeting-artifact.ts';

const root = mkdtempSync(join(tmpdir(), 'seashell-notes-setup-ui-'));
const library = join(root, 'library');
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = library;
process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
process.env.SEASHELL_TEMPLATES_DIR = join(root, 'Templates');
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
process.env.SEASHELL_DISABLE_LISTENER = '1';
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { automation: { enabled: false } } }));
const columns = 110;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 32 });
mock.module('../../src/watch-lock.ts', () => ({ acquireMeetingWatchLock: () => undefined }));

const record = createTranscriptRecord({ transcript: [{ start: 0, end: 2, text: 'Our budget is ten thousand.' }], speakers: [] },
  { id: 'acme-call', title: 'Acme discovery call', now: new Date(Date.now() - 3_600_000) });
const saved = saveTranscriptRecord(library, record);
saveMeetingArtifact(library, createMeetingArtifact(record));
const ai = () => (JSON.parse(readFileSync(join(saved.directory, 'meeting.json'), 'utf8')) as { ai?: Record<string, unknown> }).ai ?? {};

const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows: 32 });
const app = render(<App />, { stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
const screen = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('🐚')));
const type = async (key: string) => { input.write(key); await Bun.sleep(100); };
const until = async (condition: () => boolean, message: string) => {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(50);
  assert(condition(), `${message}\n${screen()}`);
};
try {
  await until(() => screen().includes('? help'), 'the app is up');
  await type('h');
  await until(() => screen().includes('Acme disco'), 'the saved meeting is in the list');
  await type('\x1b[B'); await type('\r');
  await until(() => screen().includes('1 Notes'), 'the meeting opens with its tabs');
  await type('1');
  // Leaving without a change says nothing.
  await type('g');
  await until(() => screen().includes('Notes setup'), 'G opens notes setup');
  await until(() => screen().includes('Enter write notes'), 'and Enter in it writes the notes');
  await type('\x1b');
  await until(() => !screen().includes('Notes setup'), 'Esc closes it');
  assert(!screen().includes('Saved for this meeting'), `nothing changed, so nothing to say\n${screen()}`);
  await type('g');
  await until(() => screen().includes('Notes setup'), 'G opens it again');
  await until(() => screen().includes('Auto · Customer call from the title'), 'the title picks Customer call');
  await type('\x1b[C');
  await until(() => ai().template === 'Customer call', 'right arrow chooses the next template and saves it');
  await type('\x1b');
  await until(() => screen().includes('Saved for this meeting. Press g to write the notes with them.'), 'after a change, leaving says how to use it');
  await type('g');
  await until(() => screen().includes('Notes setup'), 'G opens it once more');
  await type('\x1b[C');
  await until(() => ai().template === 'General', 'and the next');
  await type('\x1b[B'); await type('\r');
  for (const ch of 'Budget') await type(ch);
  await type('\r');
  await until(() => ai().note === 'Budget', 'the note is saved on Enter');
  await type('\x1b[B'); await type('\x1b[C');
  await until(() => ai().off === true, 'AI turns off for this meeting');
  await until(() => screen().includes('no notes or chat'), 'the panel says what off means');
  await type('\x1b');
  await until(() => !screen().includes('Notes setup'), 'Esc closes the panel');
  await until(() => screen().includes('AI is off for this meeting.'), 'the Notes tab says AI is off');
  await type('g');
  await until(() => screen().includes('Notes setup') && screen().includes('› AI'), 'with AI off, G opens on the switch');
  assert(!screen().includes('Enter write notes'), 'and Enter writes nothing, so nothing is sent to a model');
  await type('\r');
  assert(screen().includes('Notes setup'), 'Enter on the switch does not send the meeting anywhere');
  process.stdout.write(JSON.stringify({ passed: true }) + '\n');
} finally { app.unmount(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true }); }
