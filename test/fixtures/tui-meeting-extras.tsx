import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

// Made-up meetings in a temporary library. Nothing opens a browser, a microphone or a model.
const root = mkdtempSync(join(tmpdir(), 'seashell-meeting-extras-'));
const library = join(root, 'library');
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = library;
process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
process.env.SEASHELL_TEMPLATES_DIR = join(root, 'Templates');
process.env.SEASHELL_VOICES_DIR = join(root, 'Voices');
process.env.SEASHELL_EXTRACTORS_DIR = join(root, 'Extractors');
process.env.SEASHELL_AUTOMATIONS_DIR = join(root, 'Automations');
process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify({ meeting: { mode: 'post-session', routes: {
  reconciliation: { backend: 'claude-code', model: 'sonnet' }, chat: { backend: 'claude-code', model: 'sonnet' } } } }));
const columns = process.argv[2] === 'narrow' ? 56 : 100;
const narrow = columns < 72;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 30 });

const { createTranscriptRecord } = await import('../../src/transcript-record.ts');
const { saveTranscriptRecord, findTranscriptRecord } = await import('../../src/transcript-library.ts');
const { createMeetingArtifact, loadMeetingArtifact, saveMeetingArtifact, transcriptSegmentId } = await import('../../src/meeting-artifact.ts');
const { writeBackgroundWatchStatus } = await import('../../src/background-watch-status.ts');
const { videoRequestPath } = await import('../../src/video-recording.ts');
const lines = Array.from({ length: 30 }, (_, index) => ({ start: index * 10, end: index * 10 + 8,
  speaker: ['LOCAL', 'REMOTE_00', 'REMOTE_01'][index % 3]!, text: `Line ${index + 1} of a made-up call about the pilot.` }));
const add = (id: string, title: string, hoursAgo: number) => {
  const record = createTranscriptRecord({ transcript: lines, speakers: [
    { id: 'LOCAL', label: 'Microphone' },
    { id: 'REMOTE_00', label: 'Dana', suggestion: { source: 'voice', previous: 'Remote speaker 1', similarity: 0.81 } },
    { id: 'REMOTE_01', label: 'Priya', suggestion: { source: 'voice', previous: 'Remote speaker 2', similarity: 0.77 } },
  ] as never }, { id, title, now: new Date(Date.now() - hoursAgo * 3_600_000) });
  const { directory } = saveTranscriptRecord(library, record);
  const artifact = createMeetingArtifact(record);
  artifact.status = 'ready';
  artifact.analysis = { final: true, runId: 'fixture', createdAt: record.createdAt, summary: 'A made-up summary.', claims: [] } as never;
  saveMeetingArtifact(library, artifact);
  return directory;
};
// The newest opens first: a call where your microphone heard almost nothing.
const quiet = add('quiet-call', 'Quiet call', 1);
const now = Date.now();
const source = { state: 'stopped', updatedAtUnixMs: now, warnings: [] };
mkdirSync(join(quiet, 'capture'), { recursive: true });
writeFileSync(join(quiet, 'capture', 'capture-health.json'), JSON.stringify({ schemaVersion: 1, updatedAtUnixMs: now, microphone: source, systemAudio: source,
  coverage: { yourSideAudibleSeconds: 10, otherSideAudibleSeconds: 1800, yourSideAudibleShare: 0.006, yourSideMissing: true } }));
const filmed = add('filmed-call', 'Filmed call', 5);
const movie = join(filmed, 'capture', 'video', 'segment-1.mov');
mkdirSync(dirname(movie), { recursive: true });
writeFileSync(movie, '');
writeFileSync(join(filmed, 'video.json'), JSON.stringify({ file: movie, startOffsetSeconds: 0, segments: [{ file: movie, startOffsetSeconds: 0 }] }));
writeBackgroundWatchStatus(library, { phase: 'watching' });

mock.module('../../src/watch-lock.ts', () => ({ acquireMeetingWatchLock: () => undefined }));
const features = { ...await import('../../src/feature-status.ts') };
mock.module('../../src/feature-status.ts', () => ({ ...features, readFeatureStatuses: async () => [] }));
const video = { ...await import('../../src/video-meeting.ts') };
const played: Array<{ id: string; atSeconds?: number }> = [];
mock.module('../../src/video-meeting.ts', () => ({ ...video,
  openMeetingVideo: (libraryDir: string, id: string, options: { atSeconds?: number } = {}) => {
    played.push({ id, ...options });
    return video.openMeetingVideo(libraryDir, id, { ...options, open: () => {} });
  } }));
const enrichment = { ...await import('../../src/meeting-enrichment.ts') };
mock.module('../../src/meeting-enrichment.ts', () => ({ ...enrichment,
  async enrichMeeting(libraryDir: string, id: string) {
    const artifact = loadMeetingArtifact(libraryDir, id)!;
    const next = { ...artifact, analysis: { ...artifact.analysis!, runId: 'rewritten', summary: 'Rewritten made-up summary.' } };
    saveMeetingArtifact(libraryDir, next);
    return next;
  } }));
const extractors = { ...await import('../../src/extractors.ts') };
const extracted: Array<{ id: string; route?: unknown }> = [];
mock.module('../../src/extractors.ts', () => ({ ...extractors,
  async runAutomaticExtractors(libraryDir: string, id: string, options: { route?: unknown }) {
    extracted.push({ id, route: options.route });
    const artifact = loadMeetingArtifact(libraryDir, id)!;
    const cited = transcriptSegmentId(findTranscriptRecord(libraryDir, id).record, 1);
    saveMeetingArtifact(libraryDir, { ...artifact, insights: [{ extractor: 'Customer pains', createdAt: new Date().toISOString(), runId: 'x',
      fields: [{ name: 'Pains', items: [{ text: 'Made-up pain point.', evidenceSegmentIds: [cited] }] }] }] });
    return { ran: [], failed: [] };
  } }));

const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows: 30 });
const app = render(<App />, { stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
const screen = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('🐚')));
const until = async (check: () => boolean, label: string) => {
  const end = Date.now() + 4000;
  while (!check() && Date.now() < end) await Bun.sleep(20);
  assert.ok(check(), `${label}\n${screen()}`);
};
const type = async (...keys: string[]) => { for (const key of keys) { input.write(key); await Bun.sleep(90); } };
const speakers = (id: string) => findTranscriptRecord(library, id).record.speakers;
try {
  // Your side: said in the meeting, never in the list.
  await until(() => screen().includes('Quiet call') && screen().includes("Your side wasn't recorded"), 'the open meeting says your side was barely heard');
  await Bun.sleep(300);
  if (!screen().includes('Meetings')) await type('h');
  await until(() => screen().includes('Meetings') && screen().includes('Filmed call'), 'the list opens');
  if (narrow) assert.ok(!screen().includes("Your side wasn't"), 'the narrow list never says it');

  // Video: w appears only for a meeting with video, and opens at the line at the top.
  assert.ok(!screen().includes('w watch video'));
  await type('\x1b[B', '\r');
  await until(() => screen().includes('Filmed call') && screen().includes('w watch video'), 'a meeting with video offers w');
  await type('w');
  await until(() => played.length === 1, 'w opens the video');
  assert.equal(played[0]!.id, 'filmed-call');
  assert.equal(played[0]!.atSeconds, undefined, 'from the notes it starts at the beginning');
  await type('2', ...Array(12).fill('\x1b[B'), 'w');
  await until(() => played.length === 2, 'w opens the video again');
  const top = screen().split('\n').find((line) => /^\s*\d\d:\d\d/u.test(line));
  assert.ok(top, 'a timed line is at the top');
  assert.ok(played[1]!.atSeconds! > 0, 'it opens where the transcript was scrolled to');
  await until(() => screen().includes(`Opened the video at ${top!.trim().slice(0, 5)}`), 'and says where');

  // Suggested names: y keeps one, n says it is not them.
  await type('r');
  await until(() => screen().includes('Dana · suggested') && screen().includes('y keep'), 'suggested names are marked');
  await type('y');
  await until(() => speakers('filmed-call').find((speaker) => speaker.id === 'REMOTE_00')?.suggestion === undefined, 'y keeps Dana');
  assert.equal(speakers('filmed-call').find((speaker) => speaker.id === 'REMOTE_00')!.label, 'Dana');
  await type('\x1b[B');
  await until(() => screen().includes('n not Priya'), 'the key bar names who it is not');
  await type('n');
  await until(() => speakers('filmed-call').find((speaker) => speaker.id === 'REMOTE_01')?.label === 'Remote speaker 2', 'n undoes Priya');
  assert.equal(speakers('filmed-call').find((speaker) => speaker.id === 'REMOTE_01')!.suggestion, undefined);
  await type('\x1b');

  // Rewriting notes runs the extractors that fit, then shows what they found.
  await type('1', 'g');
  await until(() => screen().includes('Enter rewrite notes'), 'g opens the notes setup, where Enter rewrites');
  await type('\r');
  await until(() => /Rewrite (and replace )?these notes\?/u.test(screen()), 'rewriting asks first, saying the notes are replaced');
  await type('y');
  await until(() => extracted.length === 1, 'the extractors run after the notes');
  assert.deepEqual(extracted[0], { id: 'filmed-call', route: { backend: 'claude-code', model: 'sonnet' } });
  await until(() => screen().includes('Insights') && screen().includes('Made-up pain point.'), 'the notes show the new insights');
  await until(() => screen().includes('Meeting notes and analysis are ready.'), 'and the work is done');
  // Ink swaps in the input handler a moment after the frame; a key sooner meets the busy one.
  await Bun.sleep(250);

  // V records with video; plain Space is audio only and drops a request for video.
  await type('V');
  await until(() => existsSync(videoRequestPath()) && existsSync(process.env.SEASHELL_MEETING_COMMAND_PATH!), 'V asks the recorder for video');
  assert.equal(JSON.parse(readFileSync(process.env.SEASHELL_MEETING_COMMAND_PATH!, 'utf8')).command, 'start');
  await type(' ');
  await until(() => !existsSync(videoRequestPath()), 'Space records audio only');
  for (const line of screen().split('\n')) assert.ok(Bun.stringWidth(line) <= columns, `fits ${columns} columns: ${line}`);
  console.log(JSON.stringify({ passed: true }));
} finally { app.unmount(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true }); }
