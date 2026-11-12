import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTranscriptRecord } from '../../src/transcript-record.ts';
import { saveTranscriptRecord } from '../../src/transcript-library.ts';
import { createMeetingArtifact, saveMeetingArtifact } from '../../src/meeting-artifact.ts';
import { writeBackgroundMeetingState } from '../../src/background-meeting-status.ts';
import { writeBackgroundWatchStatus } from '../../src/background-watch-status.ts';
import { CaptureHealthTracker } from '../../src/capture-health.ts';
import { LIVE_TEXT_PAUSED } from '../../src/live-text-guard.ts';

// Made-up data only, and no model: a fake engine answers the catch-up.
const root = mkdtempSync(join(tmpdir(), 'seashell-live-text-paused-'));
const library = join(root, 'library');
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = library;
process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
delete process.env.SEASHELL_DISABLE_LISTENER;
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { backend: 'codex', model: 'fixture' } }));
const columns = process.argv[2] === 'narrow' ? 56 : 100;
const rows = 24;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: rows });
mock.module('../../src/watch-lock.ts', () => ({ acquireMeetingWatchLock: () => undefined }));
const asked: string[] = [];
const client = { ...await import('../../src/humain-client.ts') };
mock.module('../../src/humain-client.ts', () => ({ ...client,
  meetingEngineActions: async () => new Set(['observe', 'reconcile', 'chat', 'extract', 'brief', 'draft']),
  runHumainMeeting: async (_action: string, request: { question: string }) => {
    asked.push(request.question);
    return { runId: 'r', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: { answer: 'They asked for the security summary.', evidenceSegmentIds: ['s000004'] } };
  } }));

// A call the background recorder is recording; live text paused after its seventh line.
const record = createTranscriptRecord({ transcript: Array.from({ length: 7 }, (_, index) => ({ id: `s${String(index).padStart(6, '0')}`,
  start: index * 7, end: index * 7 + 6, speaker: 'REMOTE_00', text: `Line ${index + 1} of the pilot call.` })),
speakers: [{ id: 'REMOTE_00', label: 'Remote speaker 1' }] }, { id: 'paused-call', title: 'Design review', now: new Date(Date.now() - 120_000) });
const saved = saveTranscriptRecord(library, record);
saveMeetingArtifact(library, createMeetingArtifact(record));
const health = new CaptureHealthTracker();
const heard = () => {
  health.pcm('microphone', { peak: 1000, rms: 500, rmsDbfs: -30 });
  health.pcm('systemAudio', { peak: 1000, rms: 500, rmsDbfs: -30 });
  writeBackgroundMeetingState(saved.directory, 'recording', { captureHealth: health.snapshot, audioSavedThroughMs: 118_000,
    draftStatus: { stage: 'paused', detail: LIVE_TEXT_PAUSED, queueDepth: 0 } });
};
heard();
writeBackgroundWatchStatus(library, { phase: 'recording', sessionId: record.id });

const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows });
const app = render(<App />, { stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
const screen = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('🐚')));
const flat = () => screen().replace(/\s+/gu, ' ');
const keyBar = () => screen().trimEnd().split('\n').at(-1)!.trim();
const type = async (key: string) => { heard(); input.write(key); await Bun.sleep(120); };
const until = async (condition: () => boolean, message: string) => {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(50);
  assert(condition(), `${message}\n${screen()}`);
};
try {
  await until(() => screen().includes('Live text paused') && screen().includes('Line 7 of the pilot call.'), 'the recording opens with its title saying live text paused');
  await until(() => flat().includes(LIVE_TEXT_PAUSED), 'the transcript\'s last row says why the words stopped');
  // Nothing fixes it but time: no key leads the key bar as its fix.
  assert(keyBar().startsWith('space stop'), `the key bar leads with what it always does\n${keyBar()}`);
  await type('i');
  await until(() => screen().includes('Audio help') && flat().includes(LIVE_TEXT_PAUSED), 'audio help opens on what the title says');
  await type('\x1b');
  await type('a');
  await until(() => screen().includes('what did I miss?'), 'a asks during the call');
  await type('\r');
  await until(() => screen().includes('Up to 0:48, when live text paused.') && screen().includes('They asked for the security summary.'),
    'the catch-up says how far it could read');
  assert(asked.at(-1)?.includes('to 0:48 on the transcript clock'), `the question reads up to where live text paused\n${asked.at(-1)}`);
  process.stdout.write(JSON.stringify({ passed: true }) + '\n');
} finally { app.unmount(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true }); }
