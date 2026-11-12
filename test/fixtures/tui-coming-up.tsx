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
import { writeNextMeeting } from '../../src/briefs.ts';

// Made-up data only, and no model: a fake engine writes the brief.
const root = mkdtempSync(join(tmpdir(), 'seashell-coming-up-ui-'));
const library = join(root, 'library');
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = library;
process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
process.env.SEASHELL_TEMPLATES_DIR = join(root, 'Templates');
process.env.SEASHELL_VOCABULARY_FILE = join(root, 'Vocabulary.txt');
process.env.SEASHELL_BRIEFS_DIR = join(root, 'Briefs');
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
process.env.SEASHELL_DISABLE_LISTENER = '1';
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { automation: { enabled: false }, backend: 'codex', model: 'fixture' } }));
const columns = 100;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 30 });
mock.module('../../src/watch-lock.ts', () => ({ acquireMeetingWatchLock: () => undefined }));
const client = { ...await import('../../src/humain-client.ts') };
mock.module('../../src/humain-client.ts', () => ({ ...client,
  meetingEngineActions: async () => new Set(['observe', 'reconcile', 'chat', 'extract', 'brief', 'draft']),
  runHumainMeeting: async (_action: string, request: { meetings: Array<{ meetingId: string }> }) => ({
    runId: 'r', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: { summary: 'They wait on the security summary.', sections: [
      { heading: 'Still open', items: [{ text: 'Send the security summary.', sources: [{ meetingId: request.meetings[0]!.meetingId, evidenceSegmentIds: ['s000040'] }] }] },
    ] } }) }));

// A past meeting whose notes cite a line well down its transcript.
const record = createTranscriptRecord({ transcript: Array.from({ length: 100 }, (_, index) => ({ id: `s${String(index).padStart(6, '0')}`,
  start: index * 7, end: index * 7 + 6, text: index === 40 ? 'I will send the security summary by Friday.' : `Line ${index} of the pilot call.` })), speakers: [] },
{ id: 'roadmap', title: 'Roadmap review', now: new Date(Date.now() - 3 * 86_400_000) });
saveTranscriptRecord(library, record);
const artifact = createMeetingArtifact(record);
saveMeetingArtifact(library, { ...artifact, status: 'ready', analysis: { final: true, summary: 'Pilot call.', runId: 'r', createdAt: record.createdAt,
  claims: [{ id: 'c1', type: 'action_item', text: 'Send the security summary.', person: 'You', due: 'Fri', evidenceSegmentIds: ['s000040'], confidence: 0.9 }] } });
const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
writeNextMeeting(library, { upcoming: { title: 'Roadmap review', startsAt: at(1), eventId: 'roadmap-series', attendees: [] }, history: 1, later: [
  { upcoming: { title: 'Lunch with Sam', startsAt: at(20), eventId: 'lunch', attendees: [] }, history: 0 },
] });

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
  await until(() => screen().includes('b coming up'), 'b offers what is coming up');
  await Bun.sleep(200);
  await type('b');
  await until(() => screen().includes('Coming up') && screen().includes('Roadmap review') && screen().includes('Lunch with Sam')
    && screen().includes('make brief') && screen().includes('no history'), 'b lists every meeting coming up, tomorrow\'s too, and where each brief stands');
  await type('\r');
  await until(() => screen().includes('Brief · Roadmap review') && screen().includes('from Roadmap review,') && screen().includes('You · Fri'),
    'Enter makes the brief; it names the one past meeting once, and the owner sits on the right');
  await type('\x1b');
  await until(() => screen().includes('Coming up') && screen().includes('brief ready'), 'Esc goes back to the list, which says the brief is ready');
  await type('\x1b[B'); await type('\r');
  await until(() => screen().includes('No past meetings with these people or this title.'), 'a meeting with no history says so, in one row');
  await type('\x1b[A'); await type('\r');
  await until(() => screen().includes('Brief · Roadmap review') && screen().includes('Enter where it was said'), 'a saved brief opens at once');
  await type('\r');
  await until(() => screen().includes('2 Transcript') && screen().split('\n').slice(3, 6).join('\n').includes('I will send the security summary'),
    'Enter opens the past meeting at the line the point cites');
  process.stdout.write(JSON.stringify({ passed: true }) + '\n');
} finally { app.unmount(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true }); }
