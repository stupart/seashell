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
 * (or Return on it) seeks there; the line being said is highlighted and kept in
 * view. Space plays or pauses, and the arrow keys move between lines. Everything
 * is inline, so it works offline, and every piece of meeting text is set as
 * text, never HTML.
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
:root { color-scheme: light dark; --bg: #f6f5f2; --panel: #fff; --text: #1d1d1f; --muted: #6b6b70;
  --line: #e4e2dd; --accent: #0a66d8; --hover: rgb(127 127 127 / 8%); --current: rgb(10 102 216 / 10%); --gutter: 20px; }
@media (prefers-color-scheme: dark) { :root { --bg: #161617; --panel: #1e1e20; --text: #f2f2f2; --muted: #a1a1a6;
  --line: #2d2d30; --accent: #5aa2ff; --hover: rgb(127 127 127 / 10%); --current: rgb(90 162 255 / 16%); } }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--bg); color: var(--text);
  font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; -webkit-text-size-adjust: 100%; }
header { padding: 14px var(--gutter); border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; text-wrap: balance;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
main { display: grid; grid-template-columns: minmax(0, 1fr) clamp(360px, 32vw, 480px); min-height: 0; }
/* The video is only as wide as the picture fits (--ratio is set once it loads), so it never letterboxes whatever
   the movie's shape; a narrower one is centred, and the status line shares its edges. */
.stage { --fit: calc((100cqh - 38px) * var(--ratio, 1.6)); display: flex; flex-direction: column; gap: 10px;
  padding: var(--gutter); min-height: 0; container-type: size; }
video, .status { width: 100%; max-width: var(--fit); margin-inline: auto; }
@media (min-width: 861px) { .stage:has(.status:empty) { --fit: calc(100cqh * var(--ratio, 1.6)); } }
/* The clip rounds WebKit's paused overlay too; the ring keeps a white slide's edge on a light page. */
video { display: block; flex: none; height: auto; aspect-ratio: auto 16 / 10; border-radius: 8px;
  box-shadow: 0 0 0 1px var(--line); clip-path: inset(-1px round 9px); }
video:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.status { margin-block: 0; color: var(--muted); font-size: 13px; }
.status:empty { display: none; }
.transcript { display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; background: var(--panel);
  border-left: 1px solid var(--line); }
/* The first line starts level with the video; lines fade out over the list's padding rather than being cut. */
ol { --top: var(--gutter); --end: 32px; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px;
  align-content: start; position: relative; min-height: 0; margin: 0; padding: var(--top) 0 var(--end); list-style: none;
  overflow-y: auto; overscroll-behavior: contain;
  mask-image: linear-gradient(transparent, #000 var(--top), #000 calc(100% - var(--end)), transparent); }
li { grid-column: 1 / -1; display: grid; grid-template-columns: 4em minmax(0, 1fr); grid-template-columns: subgrid;
  align-items: baseline; margin: 0 8px; padding: 8px 12px; border-radius: 8px; cursor: pointer; overflow-wrap: anywhere;
  text-wrap: pretty; }
li > div { max-width: 66ch; }
li.turn { margin-top: 16px; }
@media (pointer: coarse) { li { min-height: 44px; padding-block: 11px; } }
@media (hover: hover) { li:hover { background: var(--hover); } }
li.current { background: var(--current); }
li.before { color: var(--muted); }
li:focus { outline: none; }
li:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
time { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.speaker { display: block; font-size: 13px; font-weight: 600; }
.speaker.unknown { color: var(--muted); }
@media (max-width: 860px) {
  header { padding-bottom: 0; border-bottom: 0; }
  main { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .stage { --fit: calc(45vh * var(--ratio, 1.6)); container-type: normal; }
  .transcript { border-left: 0; border-top: 1px solid var(--line); }
  ol { --top: 8px; }
}
</style>
</head>
<body>
<header><h1 title="${title}">${title}</h1></header>
<main>
  <section class="stage">
    <video controls playsinline preload="metadata" aria-label="Meeting video"></video>
    <p class="status" role="status"></p>
  </section>
  <div class="transcript"><ol role="listbox" aria-label="Transcript"></ol></div>
</main>
<script type="application/json" id="meeting-data">${scriptJson(data)}</script>
<script>
const data = JSON.parse(document.getElementById('meeting-data').textContent);
const video = document.querySelector('video');
const stage = document.querySelector('.stage');
const list = document.querySelector('ol');
const status = document.querySelector('.status');
const movies = data.movies;
const motion = matchMedia('(prefers-reduced-motion: no-preference)');
let movie = -1;
let current = -1;
let stop = null;
let scrolledAt = 0;
// In a meeting of an hour or more every time has hours, so the column keeps one width.
const hours = data.lines.some((line) => line.start >= 3600);
const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, rest = String(s % 60).padStart(2, '0');
  return h || hours ? h + ':' + String(m).padStart(2, '0') + ':' + rest : m + ':' + rest;
};
// Video time = transcript time + offset. A later movie takes over once it has started.
const movieAt = (t) => movies.reduce((found, entry, index) => (t + entry.offset >= 0 ? index : found), 0);
const firstPicture = -movies[0].offset;
let said = '';
const items = data.lines.map((line, index) => {
  const item = document.createElement('li');
  item.setAttribute('role', 'option');
  item.tabIndex = -1;
  const time = document.createElement('time');
  time.textContent = clock(line.start);
  // Read out whole, with its speaker, whether or not the name shows.
  item.setAttribute('aria-label', time.textContent + (line.speaker ? ' ' + line.speaker + ': ' : ' ') + line.text);
  const body = document.createElement('div');
  // A name shows when the speaker changes; a line nobody was matched to after a named one says so.
  if (line.speaker !== said) {
    if (index) item.classList.add('turn');
    const who = document.createElement('span');
    who.className = line.speaker ? 'speaker' : 'speaker unknown';
    who.textContent = line.speaker || 'Unknown';
    body.append(who);
  }
  said = line.speaker;
  body.append(document.createTextNode(line.text));
  item.append(time, body);
  if (line.end < firstPicture) item.classList.add('before');
  list.append(item);
  return item;
});
const lineOf = (node) => (node instanceof Element ? node.closest('li') : null);
// One tab stop in the transcript: the line being said, or the one last moved to.
function tabStop(item) {
  if (!item || item === stop) return;
  if (stop) stop.tabIndex = -1;
  stop = item;
  item.tabIndex = 0;
}
// Scroll the transcript, never the page. 'follow' moves only once the line nears
// the bottom (or is above the top), and then brings it to a quarter of the way down,
// starting the view on a whole line rather than through one.
function reveal(item, how) {
  const view = list.clientHeight, top = item.offsetTop, bottom = top + item.offsetHeight, at = list.scrollTop;
  const style = getComputedStyle(list), pad = parseFloat(style.paddingTop), end = parseFloat(style.paddingBottom);
  let target;
  if (how === 'nearest') {
    if (top < at + pad) target = top - pad;
    else if (bottom > at + view - end) target = bottom - view + end;
    else return;
  } else {
    if (how === 'follow' && top >= at + pad && bottom <= at + view * 0.8) return;
    target = Math.max(0, top - Math.max(pad, Math.min(view * 0.25, view - (bottom - top) - end)));
    // The view's top edge falls through a line or in the gap after one: move to the nearer whole line,
    // going up by no more than a quarter of the view.
    const cut = items.find((entry) => entry.offsetTop + entry.offsetHeight > target + pad);
    if (cut && cut.offsetTop !== target + pad) {
      const line = cut.offsetTop < target + pad ? cut : items[items.indexOf(cut) - 1];
      const next = line ? items[items.indexOf(line) + 1] : cut;
      const up = line ? line.offsetTop - pad : -Infinity, down = next ? next.offsetTop - pad : Infinity;
      target = target - up <= view * 0.25 && target - up <= down - target ? up : Number.isFinite(down) ? down : up;
    }
  }
  const smooth = how === 'follow' && motion.matches && Math.abs(target - at) < view * 2;
  list.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
}
video.addEventListener('loadedmetadata', () => {
  if (video.videoHeight) stage.style.setProperty('--ratio', String(video.videoWidth / video.videoHeight));
});
function load(index, then) {
  if (index === movie) { then(); return; }
  movie = index;
  video.addEventListener('loadedmetadata', then, { once: true });
  video.src = movies[index].src;
  say();
}
function seek(t, play, how) {
  const index = movieAt(t);
  load(index, () => {
    video.currentTime = Math.max(0, t + movies[index].offset);
    if (play) video.play().catch(() => {});
    highlight(how);
  });
}
function highlight(how = 'follow') {
  if (movie < 0) return;
  const t = video.currentTime - movies[movie].offset;
  let index = -1;
  while (index + 1 < data.lines.length && data.lines[index + 1].start <= t + 0.05) index++;
  if (index === current) return;
  items[current]?.classList.remove('current');
  items[current]?.removeAttribute('aria-selected');
  current = index;
  const item = items[index];
  if (!item) return;
  item.classList.add('current');
  item.setAttribute('aria-selected', 'true');
  if (!list.contains(document.activeElement)) tabStop(item);
  if (how !== 'none' && Date.now() - scrolledAt > 4000) reveal(item, how);
}
function say() {
  const notes = [];
  if (items.some((item) => item.classList.contains('before'))) notes.push('The video starts at ' + clock(firstPicture) + '; earlier lines have no picture.');
  // A resumed call has a movie per stretch, each with its own clock.
  if (movie > 0) notes.push('Recording resumed at ' + clock(-movies[movie].offset) + '.');
  else if (movies.length > 1) notes.push('The recording resumes at ' + clock(-movies[1].offset) + '.');
  status.textContent = notes.join(' ');
}
function choose(item) {
  tabStop(item);
  seek(data.lines[items.indexOf(item)].start, true, 'none');
}
function moveTo(item) {
  if (!item) return;
  tabStop(item);
  item.focus({ preventScroll: true });
  reveal(item, 'nearest');
  scrolledAt = Date.now();
}
list.addEventListener('click', (event) => {
  const item = lineOf(event.target);
  if (item && getSelection().isCollapsed) choose(item);
});
list.addEventListener('focusin', (event) => tabStop(lineOf(event.target)));
list.addEventListener('keydown', (event) => {
  const item = lineOf(event.target);
  if (!item || event.metaKey || event.ctrlKey || event.altKey) return;
  const index = items.indexOf(item);
  const to = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
  if (to !== undefined) { event.preventDefault(); moveTo(items[to]); }
  else if (event.key === 'Enter') { event.preventDefault(); choose(item); }
  else if (event.key !== ' ') scrolledAt = Date.now();
});
document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || target === video ||
      (target instanceof Element && target.closest('a, button, input, select, textarea'))) return;
  if (event.key === ' ') {
    event.preventDefault();
    if (video.paused) video.play().catch(() => {}); else video.pause();
  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !lineOf(target)) {
    event.preventDefault();
    moveTo(stop ?? items[0]);
  }
});
for (const name of ['wheel', 'touchmove', 'pointerdown']) list.addEventListener(name, () => { scrolledAt = Date.now(); }, { passive: true });
video.addEventListener('seeking', () => { scrolledAt = 0; });
video.addEventListener('timeupdate', () => highlight());
video.addEventListener('seeked', () => highlight());
video.addEventListener('ended', () => {
  if (movie + 1 < movies.length) load(movie + 1, () => { video.currentTime = 0; video.play().catch(() => {}); });
});
video.addEventListener('error', () => {
  status.textContent = 'This browser cannot play the video. Try Safari or Chrome, or open the movie from the meeting folder.';
});
tabStop(items[0]);
const linked = /(?:^#|&)t=(\\d+(?:\\.\\d+)?)/.exec(location.hash);
seek(linked ? Number(linked[1]) : data.startAt ?? Math.max(0, firstPicture), false, 'jump');
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
