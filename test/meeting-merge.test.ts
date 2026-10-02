import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeBackgroundMeetingState } from '../src/background-meeting-status.ts';
import { assembleCaptureTrack } from '../src/capture-finalizer.ts';
import { CaptureSessionStore, loadCaptureSession } from '../src/capture-session.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { createMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { mergeMeetingFragments, planMeetingMerges } from '../src/meeting-merge.ts';
import { readMeetSamples } from '../src/meet-speakers.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { findTranscriptRecord, listTranscriptRecords, saveTranscriptRecord } from '../src/transcript-library.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A finished background meeting piece, laid out exactly as the watcher saves it. */
function piece(root: string, id: string, startedAtUnixMs: number, room: string, text: string) {
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: id, startedAtUnixMs,
    createdAt: new Date(startedAtUnixMs).toISOString() });
  for (const [trackId, sequence] of [['microphone', 1], ['system-audio', 1], ['system-audio', 2]] as const) {
    const source = join(root, `${id}-${trackId}-${sequence}.wav`);
    writeFileSync(source, pcmS16leToWav(Buffer.alloc(16_000 * 2, sequence)));
    store.commitChunk({ sourcePath: source, trackId, startSeconds: sequence - 1, endSeconds: sequence, audible: true });
  }
  writeFileSync(join(store.root, 'meet-speakers.jsonl'), [
    JSON.stringify({ version: 1, sessionId: id, origin: startedAtUnixMs }),
    JSON.stringify({ at: 0.5, meeting: room, ...(room ? { browser: 'safari' } : {}), source: 'google-meet-accessibility' }),
    JSON.stringify({ at: 1.5, meeting: room, ...(room ? { browser: 'safari' } : {}), source: 'google-meet-accessibility' }),
  ].join('\n') + '\n');
  store.setStatus('captured', 'signal-ended');
  const record = createTranscriptRecord({
    transcript: [{ start: 0.2, end: 1.8, text, speaker: 'SYSTEM' }],
    speakers: [{ id: 'SYSTEM', label: 'System audio' }],
  }, { id, now: new Date(startedAtUnixMs), title: 'Google Meet',
    source: { filename: 'Live capture session', duration: 2, format: 'capture-session/0.1' } });
  const saved = saveTranscriptRecord(root, record);
  saveMeetingArtifact(root, createMeetingArtifact(record, { mode: 'hybrid' }));
  store.setStatus('completed', 'automatic-meeting-finalized');
  store.attachTo(saved.directory);
  writeBackgroundMeetingState(saved.directory, 'ready');
}

test('split pieces of one call become one entry on one timeline', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-merge-'));
  roots.push(root);
  const start = Date.UTC(2026, 8, 30, 20, 1, 55);
  piece(root, 'piece-a', start, '/abc-defg-hij', 'first part');
  piece(root, 'piece-b', start + 255_000, '/abc-defg-hij', 'second part');
  const result = mergeMeetingFragments(root, ['piece-b', 'piece-a']);

  expect(listTranscriptRecords(root).map(entry => entry.id)).toEqual(['piece-a-merged']);
  const { record } = findTranscriptRecord(root, 'piece-a-merged');
  expect(record.createdAt).toBe(new Date(start).toISOString());
  expect(record.transcript.map(segment => [segment.text, segment.start])).toEqual([['first part', 0.2], ['second part', 255.2]]);
  expect(record.transcript.map(segment => segment.id)).toEqual(['s000001', 's000002']);
  expect(record.source.duration).toBe(257);

  const manifestPath = join(result.directory, 'capture', 'manifest.json');
  const manifest = loadCaptureSession(manifestPath);
  expect(manifest.status).toBe('completed');
  expect(manifest.chunks.filter(chunk => chunk.trackId === 'system-audio').map(chunk => [chunk.sequence, chunk.startMs]))
    .toEqual([[1, 0], [2, 1_000], [3, 255_000], [4, 256_000]]);
  // The finalizer can rebuild one continuous track for later speaker passes.
  const track = assembleCaptureTrack(manifestPath, manifest, 'system-audio')!;
  expect(Bun.file(track).size).toBe(44 + 257 * 16_000 * 2);
  rmSync(track);
  expect(readMeetSamples(manifestPath, manifest).map(sample => sample.at)).toEqual([0.5, 1.5, 255.5, 256.5]);

  expect(result.trashed).toHaveLength(2);
  expect(readdirSync(join(root, '_Trash'))).toHaveLength(2);
  expect(existsSync(join(root, '_Capture', 'piece-a-merged'))).toBe(false);
});

test('auto planning joins only consecutive pieces of the same room', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-merge-plan-'));
  roots.push(root);
  const start = Date.UTC(2026, 8, 30, 20, 0, 0);
  piece(root, 'm1-a', start, '/abc-defg-hij', 'one');
  piece(root, 'm1-b', start + 5 * 60_000, '/abc-defg-hij', 'two');
  // Same room three hours later is a different meeting.
  piece(root, 'm2-a', start + 3 * 3_600_000, '/abc-defg-hij', 'three');
  piece(root, 'm2-b', start + 3 * 3_600_000 + 10 * 60_000, '/abc-defg-hij', 'four');
  piece(root, 'm3-a', start + 3 * 3_600_000 + 12 * 60_000, '/klm-nopq-rst', 'five');
  piece(root, 'm3-b', start + 3 * 3_600_000 + 14 * 60_000, '/klm-nopq-rst', 'six');
  expect(planMeetingMerges(root, { watchLog: '' }).map(group => group.ids)).toEqual([['m1-a', 'm1-b'], ['m2-a', 'm2-b'], ['m3-a', 'm3-b']]);
  expect(planMeetingMerges(root, { watchLog: '', maxGapMinutes: 5 }).map(group => group.ids)).toEqual([['m1-a', 'm1-b'], ['m3-a', 'm3-b']]);
});

test('merging refuses a meeting that is still recording', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-merge-busy-'));
  roots.push(root);
  piece(root, 'done', 1_000_000, '/abc-defg-hij', 'done');
  piece(root, 'live', 1_100_000, '/abc-defg-hij', 'live');
  writeBackgroundMeetingState(findTranscriptRecord(root, 'live').path.replace(/\/transcript\.json$/u, ''), 'recording');
  expect(() => mergeMeetingFragments(root, ['done', 'live'])).toThrow('still recording');
  expect(listTranscriptRecords(root)).toHaveLength(2);
});

test('pieces without room evidence are told apart by the watcher log or saved meeting key', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-merge-log-'));
  roots.push(root);
  const start = Date.UTC(2026, 8, 30, 23, 28, 33);
  // Partial Accessibility reads record no room in the speaker evidence.
  piece(root, 'first-1', start, '', 'one');
  piece(root, 'first-2', start + 5 * 60_000, '', 'two');
  piece(root, 'second-1', start + 6 * 60_000, '', 'three');
  piece(root, 'second-2', start + 8 * 60_000, '', 'four');
  const started = (sessionId: string, room: string) => JSON.stringify({ type: 'meeting.started', at: '', sessionId,
    candidate: { id: `meet:safari:${room}` } });
  const watchLog = [started('first-1', '/abc-defg-hij'), started('first-2', '/abc-defg-hij'), started('second-1', '/klm-nopq-rst'), '{"torn'].join('\n');
  writeBackgroundMeetingState(findTranscriptRecord(root, 'second-2').path.replace(/\/transcript\.json$/u, ''), 'ready',
    { meetingKey: 'meet:chrome:/klm-nopq-rst' });
  expect(planMeetingMerges(root, { watchLog }).map(group => [group.meeting, group.ids])).toEqual([
    ['/abc-defg-hij', ['first-1', 'first-2']], ['/klm-nopq-rst', ['second-1', 'second-2']],
  ]);
  // Without any identity, same-titled pieces fall back to one group.
  expect(planMeetingMerges(root, { watchLog: '' }).map(group => group.ids)).toEqual([['first-1', 'first-2', 'second-1']]);
});
