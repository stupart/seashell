import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { CaptureSessionStore, loadCaptureSession, type CaptureVideoSegment } from '../src/capture-session.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';
import { meetingVideo, openMeetingVideo, renderVideoPlayerPage, videoMapIn } from '../src/video-meeting.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function library(): string {
  const root = mkdtempSync(join(tmpdir(), 'seashell-video-meeting-'));
  roots.push(root);
  return root;
}

function segment(store: CaptureSessionStore, firstFrameMs: number, finished: boolean): Omit<CaptureVideoSegment, 'recordedAt'> {
  const slot = store.nextVideoSegment();
  writeFileSync(slot.path, Buffer.alloc(64, 1));
  return { id: slot.id, sequence: slot.sequence, relativePath: slot.relativePath, sidecarRelativePath: slot.sidecarRelativePath,
    firstFrameMs, fps: 2, quality: 'medium', finished, target: { kind: 'window', app: 'zoom.us', bundleId: 'us.zoom.xos' },
    ...(finished ? { durationMs: 90_000 } : {}) };
}

const transcript = {
  transcript: [
    { start: 1, end: 3, speaker: 'SPEAKER_00', text: 'Before the picture starts.' },
    { start: 4.5, end: 9, speaker: 'SPEAKER_01', text: 'Look at <script>alert("slide")</script> & this chart' },
    { start: 12, end: 15, text: 'Line\u2028separated </script><!-- comment' },
  ],
  speakers: [{ id: 'SPEAKER_00', label: 'Avery' }, { id: 'SPEAKER_01', label: 'Rowan <b>Lead</b>' }],
};

/** A finished meeting with one movie whose first frame is 3.25 s into the session. */
async function meetingWithVideo(libraryDir: string, id = 'meeting-video-1') {
  const store = new CaptureSessionStore({ libraryDir, sessionId: id, startedAtUnixMs: 1_800_000_000_000 });
  await store.recordVideoSegmentAsync(segment(store, 3_250, false));
  const final = { ...store.manifest.video!.segments[0]!, durationMs: 90_000, finished: true, bytes: 64 };
  await store.recordVideoSegmentAsync(final);
  const record = createTranscriptRecord(transcript, { id, title: 'Roadmap <review> & "plans"', now: new Date(1_800_000_000_000) });
  const saved = saveTranscriptRecord(libraryDir, record);
  store.setStatus('completed', 'test');
  store.attachTo(saved.directory);
  return { record, directory: saved.directory };
}

test('movies are journaled at their first frame and when final, and replay from the journal', async () => {
  const libraryDir = library();
  const store = new CaptureSessionStore({ libraryDir, sessionId: 'journal', startedAtUnixMs: 1 });
  expect(store.nextVideoSegment()).toMatchObject({ id: 'video.000001', relativePath: 'video/000001.mp4', sidecarRelativePath: 'video/000001.json' });
  const first = segment(store, 2_000, false);
  await store.recordVideoSegmentAsync(first);
  await store.recordVideoSegmentAsync({ ...first, finished: true, durationMs: 4_000 });
  // A slot whose movie is still on disk is never handed out again.
  expect(store.nextVideoSegment().sequence).toBe(2);
  const second = segment(store, 9_000, false);
  await store.recordVideoSegmentAsync(second);
  // The projection may lag a crash; the journal still knows both movies.
  const manifest = JSON.parse(readFileSync(store.manifestPath, 'utf8'));
  delete manifest.video;
  writeFileSync(store.manifestPath, JSON.stringify(manifest));
  const loaded = loadCaptureSession(store.manifestPath);
  expect(loaded.video?.segments.map((entry) => [entry.id, entry.finished, entry.durationMs])).toEqual([
    ['video.000001', true, 4_000], ['video.000002', false, undefined],
  ]);
  await expect(store.recordVideoSegmentAsync({ ...second, relativePath: '../../escape.mp4' })).rejects.toThrow('escapes');
});

test('attaching a capture writes video.json: an absolute movie and where transcript time 0 falls on it', async () => {
  const libraryDir = library();
  const { directory } = await meetingWithVideo(libraryDir);
  const map = JSON.parse(readFileSync(join(directory, 'video.json'), 'utf8'));
  const file = join(directory, 'capture', 'video', '000001.mp4');
  expect(map).toEqual({
    file, startOffsetSeconds: -3.25, durationSeconds: 90,
    target: { kind: 'window', app: 'zoom.us', bundleId: 'us.zoom.xos' },
    segments: [{ file, startOffsetSeconds: -3.25, durationSeconds: 90 }],
  });
  expect(existsSync(map.file)).toBe(true);
  expect(meetingVideo(libraryDir, 'meeting-video-1')).toEqual(map);
});

test('a meeting without video gets no video.json, and asking to watch it says so', async () => {
  const libraryDir = library();
  const store = new CaptureSessionStore({ libraryDir, sessionId: 'audio-only', startedAtUnixMs: 1 });
  const saved = saveTranscriptRecord(libraryDir, createTranscriptRecord(transcript, { id: 'audio-only', title: 'Audio only' }));
  store.attachTo(saved.directory);
  expect(existsSync(join(saved.directory, 'video.json'))).toBe(false);
  expect(meetingVideo(libraryDir, 'audio-only')).toBeUndefined();
  expect(() => openMeetingVideo(libraryDir, 'audio-only', { open: () => {} })).toThrow('Audio only has no video');
});

test('a moved meeting finds its movie in the capture bundle and repairs video.json', async () => {
  const libraryDir = library();
  const { directory } = await meetingWithVideo(libraryDir);
  const moved = join(dirname(directory), 'renamed-meeting');
  renameSync(directory, moved);
  expect(videoMapIn(moved)?.file).toBe(join(moved, 'capture', 'video', '000001.mp4'));
  const opened: string[] = [];
  const { page } = openMeetingVideo(libraryDir, 'meeting-video-1', { open: (path) => opened.push(path) });
  expect(opened).toEqual([page]);
  expect(JSON.parse(readFileSync(join(moved, 'video.json'), 'utf8')).file).toBe(join(moved, 'capture', 'video', '000001.mp4'));
});

test('the player page escapes every piece of meeting text and needs no network', async () => {
  const libraryDir = library();
  const { directory, record } = await meetingWithVideo(libraryDir);
  const { page } = openMeetingVideo(libraryDir, record.id, { atSeconds: 754, open: () => {} });
  expect(page).toBe(join(directory, 'video.html'));
  const html = readFileSync(page, 'utf8');
  expect(html).toContain('<title>Roadmap &#60;review&#62; &#38; &#34;plans&#34;</title>');
  expect(html).not.toContain('<script>alert');
  expect(html).not.toContain('<b>Lead');
  expect(html).not.toContain('<!-- comment');
  expect(html.match(/<\/script>/gu)).toHaveLength(2);
  expect(html).not.toMatch(/https?:\/\//u);
  expect(html).not.toContain('\u2028');
  const data = JSON.parse(/<script type="application\/json" id="meeting-data">(.*?)<\/script>/su.exec(html)![1]!);
  expect(data).toEqual({
    startAt: 754,
    movies: [{ src: 'capture/video/000001.mp4', offset: -3.25 }],
    lines: [
      { start: 1, end: 3, speaker: 'Avery', text: 'Before the picture starts.' },
      { start: 4.5, end: 9, speaker: 'Rowan <b>Lead</b>', text: 'Look at <script>alert("slide")</script> & this chart' },
      { start: 12, end: 15, speaker: '', text: 'Line\u2028separated </script><!-- comment' },
    ],
  });
  // The inline player parses, and sets meeting text only through textContent.
  const script = /<script>\n([\s\S]*?)<\/script>/u.exec(html)![1]!;
  expect(() => new Function(script)).not.toThrow();
  expect(script).not.toContain('innerHTML');
});

test('movie paths with spaces and symbols are URL-encoded relative to the page', () => {
  const html = renderVideoPlayerPage('/Library/Meeting #1', createTranscriptRecord(transcript, { id: 'x', title: 'x' }), {
    file: '/Library/Meeting #1/capture/video/000001.mp4', startOffsetSeconds: -1,
    segments: [{ file: '/Library/Meeting #1/capture/video/000001.mp4', startOffsetSeconds: -1 },
      { file: '/Elsewhere/part two.mp4', startOffsetSeconds: -600 }],
  });
  expect(html).toContain('"src":"capture/video/000001.mp4"');
  expect(html).toContain('"src":"file:///Elsewhere/part%20two.mp4"');
});
