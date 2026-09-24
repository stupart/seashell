import React from 'react';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { render } from 'ink';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTranscriptRecord } from '../../src/transcript-record.ts';
import { saveTranscriptRecord } from '../../src/transcript-library.ts';

const root = mkdtempSync(join(tmpdir(), 'seashell-scroll-'));
const columns = process.argv[2] === 'narrow' ? 48 : 100;
const rows = 28;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: rows });
process.env.SEASHELL_DISABLE_LISTENER = '1';
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = join(root, 'library');
writeFileSync(process.env.SEASHELL_CONFIG, '{}');
saveTranscriptRecord(process.env.SEASHELL_LIBRARY_DIR, createTranscriptRecord({
  transcript: [{ start: 0, end: 300, text: Array.from({ length: 300 }, (_, i) => `word${i}`).join(' '), speaker: 'LOCAL' }],
  speakers: [{ id: 'LOCAL', label: 'Microphone' }],
}, { id: 'scroll-test', title: 'Scrolling fixture', source: { filename: 'fixture.wav' } }));
const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _encoding, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows, isTTY: true });
const app = render(<App />, { stdin: input as unknown as NodeJS.ReadStream,
  stdout: output as unknown as NodeJS.WriteStream, stderr: output as unknown as NodeJS.WriteStream,
  debug: true, patchConsole: false, exitOnCtrlC: false });
const screen = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('🐚 Sea Shell')));
const key = async (value: string) => { input.write(value); await Bun.sleep(60); };
const expect = (ok: boolean, description: string) => { if (!ok) throw new Error(`${description}\n${screen()}`); };
try {
  await Bun.sleep(100);
  await key('h'); await key('\x1b[B'); await key('\r');
  expect(screen().includes('word0'), 'Reader starts at first word');
  const first = screen();
  await key('\x1b[<65;40;10M');
  expect(screen() !== first && !screen().includes('word0 '), 'Wheel moves within a single paragraph');
  await key('\x1b[<64;40;10M');
  expect(screen().includes('word0'), 'Wheel returns to first word');
  await key('\x1b[B');
  expect(!screen().includes('word0 '), 'Arrow scrolls by line');
  for (let i = 0; i < 30 && !screen().includes('word299'); i++) await key('\x1b[6~');
  expect(screen().includes('word299'), 'Final word is reachable');
  await key('t'); await key('s');
  for (let i = 0; i < 30; i++) await key('\x1b[5~');
  expect(screen().includes('word0'), 'Plain text can return to first word');
  const beforeClick = screen();
  await key('\x1b[<0;40;10M');
  expect(screen() === beforeClick, 'Mouse click cannot become M shortcut');
  if (process.env.SEASHELL_TUI_EVIDENCE) writeFileSync(process.env.SEASHELL_TUI_EVIDENCE, screen());
  app.unmount();
  expect(rendered.includes('\x1b[?1000h') && rendered.includes('\x1b[?1000l'), 'Mouse modes restored');
  process.stdout.write(JSON.stringify({ passed: true }) + '\n');
} finally { app.unmount(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true }); }
