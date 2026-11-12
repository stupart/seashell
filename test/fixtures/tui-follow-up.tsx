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

// Made-up data only, and no model: the follow-up comes from a fake engine that can be told to fail.
const root = mkdtempSync(join(tmpdir(), 'seashell-follow-up-ui-'));
const library = join(root, 'library');
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = library;
process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
process.env.SEASHELL_TEMPLATES_DIR = join(root, 'Templates');
process.env.SEASHELL_VOCABULARY_FILE = join(root, 'Vocabulary.txt');
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
process.env.SEASHELL_DISABLE_LISTENER = '1';
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { automation: { enabled: false }, backend: 'codex', model: 'fixture' } }));
const columns = 100;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 30 });
mock.module('../../src/watch-lock.ts', () => ({ acquireMeetingWatchLock: () => undefined }));
const asks: string[] = [];
let down = false;
const client = { ...await import('../../src/humain-client.ts') };
mock.module('../../src/humain-client.ts', () => ({ ...client,
  meetingEngineActions: async () => new Set(['observe', 'reconcile', 'chat', 'extract', 'brief', 'draft']),
  runHumainMeeting: async (_action: string, request: { draft?: { ask?: string }; segments: Array<{ id: string }> }) => {
    asks.push(request.draft?.ask ?? '');
    if (down) throw new Error('The AI did not answer.');
    return { runId: 'r', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: { subject: 'Next steps', paragraphs: [
      { kind: 'greeting', text: 'Hi Dana,', evidenceSegmentIds: [] },
      { kind: 'body', text: 'Our budget is ten thousand.', evidenceSegmentIds: [request.segments[0]!.id] },
    ] } };
  } }));

const record = createTranscriptRecord({ transcript: [{ start: 0, end: 2, text: 'Our budget is ten thousand.' }], speakers: [] },
  { id: 'acme-call', title: 'Acme discovery call', now: new Date(Date.now() - 3_600_000) });
saveTranscriptRecord(library, record);
// From a calendar invite: the email is for everyone on it but you.
saveMeetingArtifact(library, createMeetingArtifact(record, { calendar: { provider: 'macos-eventkit', eventId: 'acme', title: 'Acme discovery call',
  startAt: record.createdAt, endAt: record.createdAt, calendar: 'you@example.com',
  attendees: [{ name: 'You', email: 'you@example.com' }, { name: 'Dana Whitfield', email: 'dana@acme.example' }] } }));

const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows: 30 });
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
  await type('u'); await type('e');
  for (const ch of 'keep it short') await type(ch);
  await type('\r');
  await until(() => screen().includes('Subject: Next steps') && screen().includes('g write again'), 'the email offers to write it again');
  // Wide, the To line has room for addresses.
  assert(screen().includes('To: Dana Whitfield <dana@acme.example>'), `the To line says who, with their address\n${screen()}`);
  // Where each paragraph came from, as the notes say it: a zero-padded time against the right edge.
  await type('t');
  await until(() => /Our budget is ten thousand\. +00:00$/mu.test(screen()), 'times sit in the notes\' column, zero-padded');
  await type('t');
  // g brings back "Anything to add?" with what was typed last time, over the email it rewrites.
  await type('g');
  await until(() => screen().includes('Anything to add? keep it short█'), 'writing it again starts from the last ask');
  assert(screen().includes('Subject: Next steps') && screen().includes('Our budget is ten thousand.'), `the email stays on screen behind its prompt\n${screen()}`);
  for (const ch of ' and warm') await type(ch);
  await type('\r');
  await until(() => asks.length === 2 && screen().includes('Subject: Next steps'), 'and Enter writes it again');
  assert.equal(asks[1], 'keep it short and warm');
  // A failure says so, and Enter tries again with the same ask.
  down = true;
  await type('g'); await type('\r');
  await until(() => screen().includes('The AI did not answer.') && screen().includes('Enter try again'), 'a failure offers to try again');
  assert(screen().includes('g change what to add') && !screen().includes('g write again'), 'and g changes what to add');
  down = false;
  await type('\r');
  await until(() => asks.length === 4 && screen().includes('Subject: Next steps'), 'Enter tries again');
  assert.equal(asks[3], 'keep it short and warm');
  process.stdout.write(JSON.stringify({ passed: true }) + '\n');
} finally { app.unmount(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true }); }
