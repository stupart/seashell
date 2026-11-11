import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as microphone from '../../src/live-microphone.ts';
import * as computer from '../../src/live-system-audio.ts';
const root = mkdtempSync(join(tmpdir(), 'seashell-foreground-health-'));
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = join(root, 'library');
process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
delete process.env.SEASHELL_DISABLE_LISTENER;
delete process.env.SEASHELL_DISABLE_SYSTEM_AUDIO;
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { automation: { enabled: false } } }));
const mics: microphone.StartMicrophoneOptions[] = [];
const systems: Parameters<typeof computer.startSystemAudioCapture>[0][] = [];
let stops = 0;
const handle = () => ({ stop() { stops++; }, done: Promise.resolve(), startup: Promise.resolve(), process: {} });
let allowed = 0;
const permission = await import('../../src/microphone-permission.ts');
mock.module('../../src/microphone-permission.ts', () => ({ ...permission,
  allowMicrophone: async () => { allowed++; return { authorization: 'authorized', detail: 'Allowed.' }; } }));
mock.module('../../src/live-microphone.ts', () => ({ ...microphone, startMicrophoneCapture: (options: microphone.StartMicrophoneOptions) => { mics.push(options); return handle(); } }));
mock.module('../../src/live-system-audio.ts', () => ({ ...computer, startSystemAudioCapture: (options: Parameters<typeof computer.startSystemAudioCapture>[0]) => { systems.push(options); return handle(); } }));
const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns: 110, rows: 32 });
const app = render(<App />, { stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
const screen = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('🐚')));
const tick = () => Bun.sleep(80);
const level = { peak: 5000, rms: 1000, rmsDbfs: -30 };
try {
  await tick();
  assert.equal(mics.length, 1); assert.equal(systems.length, 1);
  assert(screen().includes('Starting recording'), 'opening capture is not confirmed recording');
  mics[0]!.onState({ state: 'unavailable' }); systems[0]!.onState({ state: 'unavailable' }); await tick();
  assert(screen().includes('Audio unavailable · not capturing'), 'all-source failure must not say Recording');
  input.write(' '); await tick(); input.write(' '); await tick();
  assert.equal(mics.length, 2); assert.equal(systems.length, 2);
  mics[0]!.onState({ state: 'stopped' }); systems[0]!.onState({ state: 'stopped' });
  mics[0]!.onLevel?.(level); systems[0]!.onLevel?.(level); await tick();
  assert(screen().includes('Starting recording'), 'late old callbacks cannot report or stop new capture');
  mics[1]!.onLevel?.(level); systems[1]!.onLevel?.(level); await tick();
  assert(screen().includes('● Recording') && !screen().includes('sound detected'), 'healthy sources stay out of the way');
  mics[1]!.onState({ state: 'unavailable' }); await tick();
  assert(screen().includes('● Recording') && screen().includes('Mic silent') && screen().includes('i mic help'),
    'one useful source keeps recording with a visible warning, and its help key leads the key bar');
  // macOS has not allowed the microphone: the recorder keeps checking, and Enter asks.
  mics[1]!.onState({ state: 'unavailable', code: 'microphone_permission', message: 'Microphone access is off for Seashell Microphone.' });
  await tick();
  assert(screen().includes('● Recording') && screen().includes('Mic not allowed') && screen().includes('Enter allow mic'),
    'a microphone macOS has not allowed is named, and Enter to allow leads the key bar');
  const stopsBefore = stops;
  input.write('\r'); await tick();
  assert.equal(allowed, 1, 'Enter asks macOS for the microphone');
  assert.equal(stops, stopsBefore, 'Enter does not stop the recording');
  assert.equal(mics.length, 2, 'the same recording carries on');
  assert(screen().includes('Microphone allowed'), 'says it worked');
  process.stdout.write(JSON.stringify({ passed: true }) + '\n');
} finally { app.unmount(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true }); }
