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
const root = mkdtempSync(join(tmpdir(), 'seashell-background-ui-'));
const library = join(root, 'library');
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = library;
process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
delete process.env.SEASHELL_DISABLE_LISTENER;
writeFileSync(process.env.SEASHELL_CONFIG, '{}');
const columns = process.argv[2] === 'narrow' ? 48 : 110;
const rows = 32;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: rows });
mock.module('../../src/watch-lock.ts', () => ({ acquireMeetingWatchLock: () => undefined }));
const decisions: unknown[][] = [];
mock.module('../../src/meeting-consent.ts', () => ({ writeMeetingConsent: (...args: unknown[]) => { decisions.push(args); } }));
const meetWarning = 'Meet detection unavailable. Check Speakers.';
writeBackgroundWatchStatus(library, { phase: 'watching', warning: meetWarning });
const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows });
const app = render(<App />, { stdin: input as any, stdout: output as any, stderr: output as any,
  debug: true, patchConsole: false, exitOnCtrlC: false });
const screen = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('🐚')));
const type = async (key: string) => { input.write(key); await Bun.sleep(100); };
const until = async (condition: () => boolean, message: string) => {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(50);
  assert(condition(), `${message}\n${screen()}`);
};
try {
  // Warnings take the title's status slot: whole when there is room, the first sentence when narrow.
  const shownWarning = columns >= 80 ? 'Meet detection unavailable. Check Speakers' : 'Meet detection';
  await until(() => screen().includes(shownWarning), 'idle watcher must expose detection failures');
  // This Mac's own setup decides between the two; neither may claim a recording.
  assert((screen().includes('Ready · watching for calls') || screen().includes("Can't record yet")) && !screen().includes('● Recording'),
    `detection failure cannot imply capture is active\n${screen()}`);
  writeBackgroundWatchStatus(library, { phase: 'awaiting-consent', candidate: { id: 'call', title: 'Design meeting', appName: 'Chrome' }, consentId: 'suggestion-1' });
  await until(() => screen().includes('Record "Design meeting"?  m record  x ignore'), 'asks in the key bar before recording');
  assert(screen().includes('Call noticed') && !screen().includes('● Recording'), 'a noticed call is not a recording');
  assert(!screen().includes('Meet detection unavailable'), 'recovered detection clears the warning');
  await type('m');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]![3], 'suggestion-1', 'approval is scoped to this exact suggestion');
  assert(screen().includes('Starting the recording'), 'request is not confirmation');
  const first = createTranscriptRecord({ transcript: [], speakers: [{ id: 'LOCAL', label: 'Microphone' }] },
    { id: 'background-call', title: 'Design meeting', now: new Date(Date.now() - 120_000) });
  const saved = saveTranscriptRecord(library, first);
  saveMeetingArtifact(library, createMeetingArtifact(first));
  const health = new CaptureHealthTracker();
  health.state('microphone', { state: 'unavailable', code: 'microphone_stopped', message: 'The microphone stopped.' });
  health.pcm('systemAudio', { peak: 1000, rms: 500, rmsDbfs: -30 });
  writeBackgroundMeetingState(saved.directory, 'recording', { captureHealth: health.snapshot, audioSavedThroughMs: 110_000,
    draftStatus: { stage: 'waiting', detail: 'Waiting for speech', queueDepth: 0 } });
  writeBackgroundWatchStatus(library, { phase: 'recording', sessionId: first.id, warning: meetWarning });
  await until(() => screen().includes('Mic silent'), 'new meeting opens automatically and exposes microphone failure');
  // One status slot, most urgent first: the microphone outranks the observer's warning.
  assert(screen().includes('● Recording'), 'confirmed audio capture continues');
  if (columns >= 80) assert(screen().includes('Audio saved through 1:50'), 'saved duration comes from committed audio');
  // With the mic the problem, help is about the mic and leads with what Seashell found.
  await type('i'); assert(screen().includes('Mic help') && screen().replace(/\s+/gu, ' ').includes('Your mic has sent nothing since the call started.'),
    `audio help is reachable\n${screen()}`);
  await type('\x1b'); assert(!screen().includes('Mic help'), 'Escape closes audio help without quitting');
  const transcript = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, start: i, end: i + 1, text: `Live sentence ${String(i).padStart(3, '0')}.`, speaker: 'LOCAL' }));
  saveTranscriptRecord(library, { ...first, transcript }, { provisional: true });
  await until(() => screen().includes('Live sentence 199.'), 'draft text appears while recording, not just after finalization');
  await type('r'); assert(screen().includes('Review and edit'), 'live drafts cannot be renamed while recorder owns them');
  // Clear the notice through the transcript tab, then scroll away from the live edge.
  await type('2'); await type('\x1b[5~');
  assert(!screen().includes('Live sentence 199.'), 'page up leaves the live edge');
  saveTranscriptRecord(library, { ...first, transcript: [...transcript, { id: 's200', start: 200, end: 201, text: 'New live sentence 200.', speaker: 'LOCAL' }] }, { provisional: true });
  await Bun.sleep(1200);
  assert(!screen().includes('200.'), 'new text does not yank the reader back to the bottom');
  await type('l'); assert(screen().includes('200.'), 'Latest resumes following live text');
  writeBackgroundMeetingState(saved.directory, 'ready', { captureHealth: health.stop() });
  writeBackgroundWatchStatus(library, { phase: 'watching', warning: meetWarning });
  await until(() => screen().includes('Saved · audio needs review'), 'capture failure remains visible after finalization');
  assert(!screen().includes(meetWarning), 'current detection warning must not attach to a saved transcript');
  writeBackgroundWatchStatus(library, { phase: 'awaiting-consent', candidate: { id: 'next', title: 'Next call', appName: 'Chrome' }, consentId: 'suggestion-2' });
  await until(() => screen().includes('Record "Next call"?'), 'next approval is visible separately');
  // Narrow, the meeting's title gives way to what happened to it.
  assert((columns < 80 || screen().includes('Design meeting')) && screen().includes('Saved · audio needs review'), 'new approval must not relabel the saved transcript');
  // A second meeting becomes the current view without reusing the old transcript.
  const second = createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'Second meeting live text.' }], speakers: [] }, { id: 'second-call', title: 'Second meeting' });
  const secondSaved = saveTranscriptRecord(library, second);
  saveMeetingArtifact(library, createMeetingArtifact(second));
  writeBackgroundMeetingState(secondSaved.directory, 'recording', { captureHealth: health.snapshot });
  writeBackgroundWatchStatus(library, { phase: 'recording', sessionId: second.id });
  await until(() => screen().includes('Second meeting live text.'), 'next meeting opens in its own transcript');
  await type('h'); await type('\x1b[B'); await type('\r');
  // Narrow, the slot is cut short; the title still names the meeting being read.
  assert(screen().includes(columns >= 80 ? 'Design meeting' : 'Saved · audio needs review') && screen().includes(columns >= 80 ? '● Another call is recording' : '● Another')
    && screen().includes('l go to the call'),
    `history view keeps its identity while another call records\n${screen()}`);
  await type('l');
  writeBackgroundWatchStatus(library, { phase: 'recording', sessionId: second.id }, Date.now() - 31_000);
  await until(() => screen().includes('Recording status unconfirmed'), 'stale watcher heartbeat must not claim active recording');
  process.stdout.write(JSON.stringify({ consent: true, recordingState: true, liveText: true, scroll: true, audioHelp: true, historyIdentity: true, staleStatus: true, observerWarning: true }) + '\n');
} finally { app.unmount(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true }); }
