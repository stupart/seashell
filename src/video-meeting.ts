import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { pathToFileURL } from 'url';
import {
  captureVideoMap,
  loadCaptureSession,
  MEETING_VIDEO_FILE,
  type MeetingVideoMap,
  type MeetingVideoSegment,
} from './capture-session.ts';
import { findTranscriptRecord } from './transcript-library.ts';
import type { TranscriptRecord } from './transcript-types.ts';

export type { MeetingVideoMap, MeetingVideoSegment } from './capture-session.ts';
export const VIDEO_PLAYER_FILE = 'video.html';

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function segmentFrom(value: unknown): MeetingVideoSegment | undefined {
  if (!plain(value) || typeof value.file !== 'string' || !value.file ||
      typeof value.startOffsetSeconds !== 'number' || !Number.isFinite(value.startOffsetSeconds)) return undefined;
  const duration = value.durationSeconds;
  return Object.freeze({
    file: value.file,
    startOffsetSeconds: value.startOffsetSeconds,
    ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? { durationSeconds: duration } : {}),
  });
}

export function readMeetingVideoMap(path: string): MeetingVideoMap | undefined {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
  const first = segmentFrom(value);
  if (!first || !plain(value)) return undefined;
  const segments = Array.isArray(value.segments) ? value.segments.flatMap((entry) => segmentFrom(entry) ?? []) : [];
  return Object.freeze({
    ...(value as object),
    ...first,
    segments: Object.freeze(segments.length ? segments : [first]),
  }) as MeetingVideoMap;
}

/**
 * The meeting folder's video map. video.json when its movies are where it
 * says; otherwise rebuilt from the capture bundle, which keeps the movies
 * (a recovered capture, or a folder that moved).
 */
export function videoMapIn(directory: string): MeetingVideoMap | undefined {
  const saved = readMeetingVideoMap(join(directory, MEETING_VIDEO_FILE));
  if (saved && saved.segments.every((segment) => existsSync(segment.file))) return saved;
  const bundle = join(directory, 'capture');
  try { return captureVideoMap(loadCaptureSession(join(bundle, 'manifest.json')), bundle); }
  catch { return undefined; }
}

/** A meeting's video, if it has one. The movie's time is transcript time + startOffsetSeconds. */
export function meetingVideo(libraryDir: string, id: string): MeetingVideoMap | undefined {
  return videoMapIn(dirname(findTranscriptRecord(libraryDir, id).path));
}

function writeAtomic(path: string, contents: string): void {
  const temporary = join(dirname(path), `.${path.split(sep).at(-1)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

/** JSON that is safe inside a <script> element: no "</script", no "<!--". */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
}

function movieUrl(directory: string, file: string): string {
  const path = relative(directory, file);
  return path.startsWith('..') || path.startsWith(sep)
    ? pathToFileURL(file).href
    : path.split(sep).map(encodeURIComponent).join('/');
}

/**
 * A page that plays the meeting's video beside its transcript. Clicking a line
 * seeks there; the line being said is highlighted. Everything is inline, so it
 * works offline, and every piece of meeting text is set as text, never HTML.
 */
export function renderVideoPlayerPage(directory: string, record: TranscriptRecord, video: MeetingVideoMap, startAtSeconds?: number): string {
  const speakers = new Map(record.speakers.map((speaker) => [speaker.id, speaker.label]));
  const data = {
    startAt: startAtSeconds ?? null,
    movies: video.segments.map((segment) => ({
      src: movieUrl(directory, segment.file),
      offset: segment.startOffsetSeconds,
    })),
    lines: record.transcript.toSorted((left, right) => left.start - right.start).map((segment) => ({
      start: segment.start,
      end: segment.end,
      speaker: segment.speaker ? speakers.get(segment.speaker) ?? segment.speaker : '',
      text: segment.text,
    })),
  };
  const title = escapeHtml(record.title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light dark; --bg: #f6f5f2; --panel: #ffffff; --text: #1d1d1f; --muted: #6e6e73;
  --line: #e4e2dd; --accent: #0a66d8; --current: #fff3d1; }
@media (prefers-color-scheme: dark) { :root { --bg: #161617; --panel: #1e1e20; --text: #f2f2f2; --muted: #9a9aa0;
  --line: #2d2d30; --accent: #5aa2ff; --current: #3b3322; } }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--bg); color: var(--text);
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
header { padding: 14px 20px; border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 17px; font-weight: 600; }
main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); min-height: 0; }
.stage { display: flex; flex-direction: column; gap: 10px; padding: 20px; min-height: 0; }
video { width: 100%; max-height: calc(100vh - 130px); background: #000; border-radius: 8px; }
.status { margin: 0; color: var(--muted); font-size: 13px; }
ol { margin: 0; padding: 8px 0; list-style: none; overflow-y: auto; background: var(--panel); border-left: 1px solid var(--line); }
li { display: grid; grid-template-columns: 4.5em minmax(0, 1fr); gap: 10px; padding: 8px 16px; cursor: pointer; }
li:hover, li:focus-visible { background: color-mix(in srgb, var(--accent) 9%, transparent); outline: none; }
li.current { background: var(--current); }
li.before { color: var(--muted); }
time { padding-top: 1px; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.speaker { display: block; font-size: 13px; font-weight: 600; }
@media (max-width: 860px) {
  main { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  video { max-height: 45vh; }
  ol { border-left: 0; border-top: 1px solid var(--line); }
}
</style>
</head>
<body>
<header><h1>${title}</h1></header>
<main>
  <section class="stage">
    <video controls playsinline preload="metadata"></video>
    <p class="status">Click a line to see that moment.</p>
  </section>
  <ol aria-label="Transcript"></ol>
</main>
<script type="application/json" id="meeting-data">${scriptJson(data)}</script>
<script>
const data = JSON.parse(document.getElementById('meeting-data').textContent);
const video = document.querySelector('video');
const list = document.querySelector('ol');
const status = document.querySelector('.status');
const movies = data.movies;
let movie = -1;
let current = -1;
let scrolledAt = 0;
const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, rest = String(s % 60).padStart(2, '0');
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + rest : m + ':' + rest;
};
// Video time = transcript time + offset. A later movie takes over once it has started.
const movieAt = (t) => movies.reduce((found, entry, index) => (t + entry.offset >= 0 ? index : found), 0);
const firstPicture = -movies[0].offset;
const items = data.lines.map((line) => {
  const item = document.createElement('li');
  item.tabIndex = 0;
  const time = document.createElement('time');
  time.textContent = clock(line.start);
  const body = document.createElement('div');
  if (line.speaker) {
    const who = document.createElement('span');
    who.className = 'speaker';
    who.textContent = line.speaker;
    body.append(who);
  }
  body.append(document.createTextNode(line.text));
  item.append(time, body);
  if (line.end < firstPicture) item.classList.add('before');
  item.addEventListener('click', () => seek(line.start, true));
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); seek(line.start, true); }
  });
  list.append(item);
  return item;
});
function load(index, then) {
  if (index === movie) { then(); return; }
  movie = index;
  video.addEventListener('loadedmetadata', then, { once: true });
  video.src = movies[index].src;
}
function seek(t, play) {
  const index = movieAt(t);
  load(index, () => {
    video.currentTime = Math.max(0, t + movies[index].offset);
    if (play) video.play().catch(() => {});
    highlight();
  });
}
function highlight() {
  if (movie < 0) return;
  const t = video.currentTime - movies[movie].offset;
  let index = -1;
  while (index + 1 < data.lines.length && data.lines[index + 1].start <= t + 0.05) index++;
  if (index === current) return;
  items[current]?.classList.remove('current');
  current = index;
  const item = items[index];
  if (!item) return;
  item.classList.add('current');
  if (Date.now() - scrolledAt > 4000) item.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
for (const name of ['wheel', 'touchmove']) list.addEventListener(name, () => { scrolledAt = Date.now(); }, { passive: true });
video.addEventListener('timeupdate', highlight);
video.addEventListener('seeked', highlight);
video.addEventListener('ended', () => {
  if (movie + 1 < movies.length) load(movie + 1, () => { video.currentTime = 0; video.play().catch(() => {}); });
});
video.addEventListener('error', () => {
  status.textContent = 'This browser cannot play the video. Try Safari or Chrome, or open the movie from the meeting folder.';
});
if (firstPicture > 1) status.textContent = 'The video starts at ' + clock(firstPicture) + ' in the transcript. Click a line to see that moment.';
const linked = /(?:^#|&)t=(\\d+(?:\\.\\d+)?)/.exec(location.hash);
seek(linked ? Number(linked[1]) : data.startAt ?? Math.max(0, firstPicture), false);
</script>
</body>
</html>
`;
}

export interface OpenMeetingVideoOptions {
  readonly atSeconds?: number;
  /** Test seam; production opens the page in the default browser. */
  readonly open?: (path: string) => void;
}

/**
 * Write video.html beside the transcript and open it. Also refreshes
 * video.json when it is missing or points at movies that have moved.
 */
export function openMeetingVideo(libraryDir: string, id: string, options: OpenMeetingVideoOptions = {}): { page: string; video: MeetingVideoMap } {
  const { path, record } = findTranscriptRecord(libraryDir, id);
  const directory = dirname(path);
  const video = videoMapIn(directory);
  if (!video) throw new Error(`${record.title} has no video. Recordings with video on keep it in the meeting folder.`);
  const mapPath = join(directory, MEETING_VIDEO_FILE);
  const saved = readMeetingVideoMap(mapPath);
  if (!saved || saved.file !== video.file || saved.segments.length !== video.segments.length) {
    writeAtomic(mapPath, `${JSON.stringify(video, null, 2)}\n`);
  }
  const page = join(directory, VIDEO_PLAYER_FILE);
  writeAtomic(page, renderVideoPlayerPage(directory, record, video, options.atSeconds));
  (options.open ?? ((target: string) => {
    const result = spawnSync('/usr/bin/open', [target], { stdio: 'ignore', timeout: 10_000 });
    if (result.error || result.status !== 0) throw new Error(`Could not open ${target}`);
  }))(page);
  return { page, video };
}
