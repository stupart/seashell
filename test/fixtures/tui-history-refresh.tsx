import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTranscriptRecord } from '../../src/transcript-record.ts';
import { saveTranscriptRecord } from '../../src/transcript-library.ts';

const root = mkdtempSync(join(tmpdir(), 'seashell-history-refresh-'));
const library = join(root, 'library');
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = library;
process.env.SEASHELL_DISABLE_LISTENER = '1';
writeFileSync(process.env.SEASHELL_CONFIG, '{}');
Object.defineProperty(process.stdout, 'columns', { value: 100 });
Object.defineProperty(process.stdout, 'rows', { value: 28 });
const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let outputText = '';
const output = Object.assign(new Writable({ write(chunk, _encoding, callback) {
  outputText += chunk.toString(); callback();
} }), { columns: 100, rows: 28 });
const app = render(<App />, { stdin: input as any, stdout: output as any, stderr: output as any,
  debug: true, patchConsole: false, exitOnCtrlC: false });
const screen = () => stripVTControlCharacters(outputText.slice(outputText.lastIndexOf('🐚 Sea Shell')));
const type = async (key: string) => { input.write(key); await Bun.sleep(100); };
try {
  await Bun.sleep(150);
  saveTranscriptRecord(library, createTranscriptRecord({ transcript: [{ start: 0, end: 1,
    text: 'First external transcript content.' }], speakers: [] }, { id: 'first', title: 'First import', now: new Date(1000) }));
  await type('h');
  assert.ok(screen().includes('First import'), 'opening history discovers a concurrent CLI import');
  await type('\x1b[B'); await type('\r');
  assert.ok(screen().includes('First external transcript content.'));
  saveTranscriptRecord(library, createTranscriptRecord({ transcript: [{ start: 0, end: 1,
    text: 'Second external transcript content.' }], speakers: [] }, { id: 'second', title: 'Second import', now: new Date(2000) }));
  await type('h');
  assert.ok(screen().includes('Second import'));
  assert.ok(screen().includes('› First import'), 'refresh preserves selection when a newer record is inserted');
  await type('\r');
  assert.ok(screen().includes('First external transcript content.'));
  process.stdout.write(JSON.stringify({ discovered: true, selectionPreserved: true }) + '\n');
} finally { app.unmount(); rmSync(root, { recursive: true, force: true }); }
