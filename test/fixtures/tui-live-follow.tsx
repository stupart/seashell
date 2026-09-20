import { mock } from 'bun:test';
import React from 'react';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { render } from 'ink';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StartMicrophoneOptions } from '../../src/live-microphone.ts';
import { listTranscriptRecords, loadTranscriptPath } from '../../src/transcript-library.ts';

const root = mkdtempSync(join(tmpdir(), 'seashell-live-follow-'));
const narrow = process.argv[2] === 'narrow';
const columns = narrow ? 48 : 100;
const rows = narrow ? 24 : 28;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: rows });
const library = join(root, 'library');
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = library;
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({
  meeting: { automation: { enabled: false } },
}));
const microphone = { ...await import('../../src/live-microphone.ts') };
const scheduler = { ...await import('../../src/local-asr-scheduler.ts') };
const { pcmS16leToWav, pcmS16leSignalLevel } = await import('../../src/live-system-audio.ts');
let capture: StartMicrophoneOptions | undefined;
let nextText = '';
let completed = 0;
mock.module('../../src/live-microphone.ts', () => ({
  ...microphone,
  startMicrophoneCapture(options: StartMicrophoneOptions) {
    capture = options;
    options.onState({ state: 'active' });
    return { done: Promise.resolve(), startup: Promise.resolve(), stop() {} };
  },
}));
mock.module('../../src/local-asr-scheduler.ts', () => ({
  ...scheduler,
  OwnedWhisperServer: class {
    async transcribe() { completed++; return nextText; }
    async stop() {}
  },
}));
const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } }), { columns, rows });
const app = render(<App />, {
  stdin: input as unknown as NodeJS.ReadStream,
  stdout: output as unknown as NodeJS.WriteStream,
  stderr: output as unknown as NodeJS.WriteStream,
  patchConsole: false, exitOnCtrlC: false,
});
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  if (!check()) throw new Error('TUI did not process the fixture audio');
};
const screen = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('🐚 Sea Shell')));
let sequence = 0;
const emit = async (text: string) => {
  nextText = text;
  sequence++;
  const path = join(root, `${sequence}.wav`);
  const pcm = Buffer.alloc(32000);
  writeFileSync(path, pcmS16leToWav(pcm));
  capture!.onChunk({ path, sequence, source: 'microphone', audible: true,
    startSeconds: sequence * 10, endSeconds: sequence * 10 + 1,
    level: pcmS16leSignalLevel(pcm),
    clock: { kind: 'device-sample-clock', originUnixMs: capture!.sessionStartedAtUnixMs,
      sampleRate: 16000, uncertaintyMs: 1 },
  });
  await until(() => completed === sequence);
  await Bun.sleep(60);
};
try {
  await until(() => Boolean(capture));
  input.write('m');
  await Bun.sleep(60);
  for (let index = 1; index <= 14; index++) await emit(`Live sentence ${index}: The next meeting is on Tuesday.`);
  if (process.env.SEASHELL_TUI_EVIDENCE) writeFileSync(process.env.SEASHELL_TUI_EVIDENCE, screen());
  const followsLatest = /Live sentence 14:[\s\S]*Tuesday\./u.test(screen());
  input.write('\x1b[A');
  await Bun.sleep(60);
  const beforeAppend = screen();
  await emit('Live sentence 15: The next meeting is on Tuesday.');
  const whileBrowsing = screen();
  input.write('\x1b[6~');
  await Bun.sleep(60);
  input.write('\x1b[6~');
  await Bun.sleep(60);
  await emit('Live sentence 16: The next meeting is on Tuesday.');
  const resumesAtBottom = /Live sentence 16:[\s\S]*Tuesday\./u.test(screen());
  input.write('\x1b[A');
  await Bun.sleep(60);
  input.write('l');
  await Bun.sleep(60);
  const returnsToLatest = /Live sentence 16:[\s\S]*Tuesday\./u.test(screen());
  await emit('...');
  const record = listTranscriptRecords(library)[0]!;
  const transcript = loadTranscriptPath(join(record.directory, 'transcript.json'));
  process.stdout.write(`${JSON.stringify({
    followsLatest, returnsToLatest, resumesAtBottom,
    stayedWhileBrowsing: /Live sentence \d+/u.exec(beforeAppend)?.[0] ===
      /Live sentence \d+/u.exec(whileBrowsing)?.[0] && !whileBrowsing.includes('Live sentence 15'),
    punctuationSaved: transcript.transcript.some((segment) => segment.text === '...'),
    textCount: transcript.transcript.length,
  })}\n`);
} finally {
  app.unmount();
  input.destroy();
  output.destroy();
  rmSync(root, { recursive: true, force: true });
}
