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

/** Run the player's inline script against a small fake DOM: enough to drive its keys, clicks and seeks. */
function playerHarness(html: string, view = 400) {
  type Listener = { fn: (event: FakeEvent) => void; once?: boolean };
  type FakeEvent = { type: string; key?: string; target: unknown; defaultPrevented: boolean; preventDefault(): void; metaKey: boolean; ctrlKey: boolean; altKey: boolean };
  const documentListeners: Record<string, Listener[]> = {};
  const fire = (listeners: Record<string, Listener[]>, event: FakeEvent) => {
    for (const listener of [...(listeners[event.type] ?? [])]) {
      if (listener.once) listeners[event.type] = listeners[event.type]!.filter((entry) => entry !== listener);
      listener.fn(event);
    }
  };
  class El {
    tagName: string; parent: El | null = null; children: (El | { nodeType: number; textContent: string })[] = [];
    attributes: Record<string, string> = {}; listeners: Record<string, Listener[]> = {}; classes = new Set<string>();
    tabIndex = -1; textContent = ''; style = { properties: {} as Record<string, string>, setProperty(name: string, value: string) { this.properties[name] = value; } };
    constructor(tag: string) { this.tagName = tag.toUpperCase(); }
    set className(value: string) { this.classes = new Set(value.split(' ').filter(Boolean)); }
    get classList() { const classes = this.classes; return { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), contains: (name: string) => classes.has(name) }; }
    append(...nodes: (El | { nodeType: number; textContent: string })[]) { for (const node of nodes) { if (node instanceof El) node.parent = this; this.children.push(node); } }
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    removeAttribute(name: string) { delete this.attributes[name]; }
    addEventListener(type: string, fn: (event: FakeEvent) => void, options?: { once?: boolean }) { (this.listeners[type] ??= []).push({ fn, once: options?.once }); }
    closest(selector: string) { const tags = selector.split(',').map((tag) => tag.trim().toUpperCase()); for (let el: El | null = this; el; el = el.parent) if (tags.includes(el.tagName)) return el; return null; }
    contains(node: unknown) { for (let el = node as El | null; el; el = el.parent) if (el === this) return true; return false; }
    focus() { doc.activeElement = this; dispatch(this, 'focusin'); }
    // Lines are 40px tall under the list's 20px top padding.
    get offsetTop() { return 20 + (this.parent?.children.indexOf(this) ?? 0) * 40; }
    get offsetHeight() { return 40; }
  }
  function dispatch(target: El, type: string, key?: string) {
    const event: FakeEvent = { type, key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, metaKey: false, ctrlKey: false, altKey: false };
    for (let el: El | null = target; el; el = el.parent) fire(el.listeners, event);
    fire(documentListeners, event);
    return event;
  }
  const body = new El('body');
  const list = Object.assign(new El('ol'), { clientHeight: view, scrollTop: 0, scrollTo({ top }: { top: number }) { this.scrollTop = top; } });
  const status = new El('p');
  let source = '';
  const video = Object.assign(new El('video'), {
    currentTime: 0, paused: true, videoWidth: 1920, videoHeight: 1200,
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
  });
  // Loading a movie reports its size at once.
  Object.defineProperty(video, 'src', { get: () => source, set: (value: string) => { source = value; dispatch(video, 'loadedmetadata'); } });
  const stage = new El('section');
  stage.append(video, status);
  body.append(stage, list);
  const json = /<script type="application\/json" id="meeting-data">(.*?)<\/script>/su.exec(html)![1]!;
  const doc = {
    body, activeElement: body as El,
    getElementById: () => ({ textContent: json }),
    querySelector: (selector: string) => ({ video, ol: list, '.status': status, '.stage': stage })[selector],
    createElement: (tag: string) => new El(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    addEventListener: (type: string, fn: (event: FakeEvent) => void) => { (documentListeners[type] ??= []).push({ fn }); },
  };
  const script = /<script>\n([\s\S]*?)<\/script>/u.exec(html)![1]!;
  new Function('document', 'matchMedia', 'getSelection', 'getComputedStyle', 'location', 'Element', script)(
    doc, () => ({ matches: true }), () => ({ isCollapsed: true }), () => ({ paddingTop: '20px' }), { hash: '' }, El);
  const items = list.children as El[];
  return {
    video, list, status, stage, items, doc,
    key: (key: string, target: El = doc.activeElement) => dispatch(target, 'keydown', key),
    click: (item: El) => dispatch(item, 'click'),
    current: () => items.findIndex((item) => item.classes.has('current')),
    focused: () => items.indexOf(doc.activeElement),
    stops: () => items.filter((item) => item.tabIndex === 0).map((item) => items.indexOf(item)),
  };
}

const lines = Array.from({ length: 12 }, (_, index) => ({ start: index * 10, end: index * 10 + 8, text: `Line ${index}` }));
const movie = (startOffsetSeconds: number, file = '/m/capture/video/000001.mp4') => ({ file, startOffsetSeconds });

test('the player works by keyboard alone: Space plays or pauses, the arrows move between lines, Return seeks', () => {
  const html = renderVideoPlayerPage('/m', createTranscriptRecord({ transcript: lines, speakers: [] }, { id: 'k', title: 'Keys' }),
    { ...movie(-2), segments: [movie(-2)] }, 31);
  const page = playerHarness(html);
  // Opens at 0:31 with that line current, selected, and the transcript's only tab stop.
  expect(page.current()).toBe(3);
  expect(page.items[3]!.getAttribute('aria-selected')).toBe('true');
  expect(page.stops()).toEqual([3]);
  // From the page, Down goes into the transcript at the current line; then line by line, keeping one tab stop.
  page.key('ArrowDown', page.doc.body);
  expect(page.focused()).toBe(3);
  page.key('ArrowDown'); page.key('ArrowDown'); page.key('ArrowUp');
  expect(page.focused()).toBe(4);
  expect(page.stops()).toEqual([4]);
  page.key('End');
  expect(page.focused()).toBe(11);
  page.key('Home');
  expect(page.focused()).toBe(0);
  // Return seeks to the focused line (video time = transcript time + offset) and plays.
  page.key('ArrowDown');
  const enter = page.key('Enter');
  expect(enter.defaultPrevented).toBe(true);
  expect(page.video.currentTime).toBe(8);
  expect(page.video.paused).toBe(false);
  expect(page.current()).toBe(1);
  // Space pauses and plays, from a line or from the page, and is left to the video's own controls there.
  expect(page.key(' ').defaultPrevented).toBe(true);
  expect(page.video.paused).toBe(true);
  page.key(' ', page.doc.body);
  expect(page.video.paused).toBe(false);
  expect(page.key(' ', page.video).defaultPrevented).toBe(false);
  expect(page.video.paused).toBe(false);
  // A click seeks and plays the same way.
  page.video.pause();
  page.click(page.items[6]!);
  expect([page.video.currentTime, page.video.paused, page.current()]).toEqual([58, false, 6]);
});

test('the player says when the video starts late and which part of a resumed call is showing', () => {
  const record = createTranscriptRecord({ transcript: lines, speakers: [] }, { id: 's', title: 'Status' });
  expect(playerHarness(renderVideoPlayerPage('/m', record, { ...movie(-1.5), segments: [movie(-1.5)] })).status.textContent).toBe('');
  const late = playerHarness(renderVideoPlayerPage('/m', record, { ...movie(-45), segments: [movie(-45)] }));
  expect(late.status.textContent).toBe('The video starts at 0:45; earlier lines have no picture.');
  expect(late.items.filter((item) => item.classes.has('before')).length).toBe(4);
  const resumed = playerHarness(renderVideoPlayerPage('/m', record,
    { ...movie(-1), segments: [movie(-1), movie(-70, '/m/capture/video/000002.mp4')] }, 75));
  expect(resumed.status.textContent).toBe('Video 2 of 2, from 1:10.');
  expect((resumed.video as unknown as { src: string }).src).toBe('capture/video/000002.mp4');
  expect(resumed.stage.style.properties['--ratio']).toBe(String(1920 / 1200));
});

test('the player page is labelled, themed, offline and small', () => {
  const html = renderVideoPlayerPage('/m', createTranscriptRecord({ transcript: lines, speakers: [] }, { id: 'p', title: 'Page' }),
    { ...movie(-1), segments: [movie(-1)] });
  expect(html).toContain('aria-label="Meeting video"');
  expect(html).toContain('<ol role="listbox" aria-label="Transcript">');
  expect(html).toContain('@media (prefers-color-scheme: dark)');
  expect(html).toContain('li:focus-visible { outline: 2px solid var(--accent)');
  expect(html).toContain('font-variant-numeric: tabular-nums');
  expect(html).toContain('font: 15px/1.45 system-ui');
  expect(html).not.toMatch(/<link|@import|@font-face|url\(/u);
  const shell = html.replace(/<script type="application\/json" id="meeting-data">.*?<\/script>/su, '');
  expect(shell.length).toBeLessThan(14_000);
});

test('a speaker is named when they start talking, every line is read out with its speaker, and a line matched to nobody after a named one says so', () => {
  const said = ['SPEAKER_00', 'SPEAKER_00', 'SPEAKER_01', undefined, undefined, 'SPEAKER_01'];
  const record = createTranscriptRecord({
    transcript: said.map((speaker, index) => ({ start: index * 5, end: index * 5 + 4, text: `Line ${index}`, ...(speaker ? { speaker } : {}) })),
    speakers: [{ id: 'SPEAKER_00', label: 'Avery' }, { id: 'SPEAKER_01', label: 'Rowan' }],
  }, { id: 'g', title: 'Grouped' });
  const page = playerHarness(renderVideoPlayerPage('/m', record, { ...movie(-1), segments: [movie(-1)] }));
  const names = page.items.map((item) => {
    const who = (item.children[1] as unknown as { children: { classes?: Set<string>; textContent: string }[] }).children[0]!;
    return who.classes ? `${who.textContent}${who.classes.has('unknown') ? ' (muted)' : ''}` : '-';
  });
  expect(names).toEqual(['Avery', '-', 'Rowan', 'Unknown (muted)', '-', 'Rowan']);
  // A new speaker starts a new turn, set apart by a little more space.
  expect(page.items.map((item) => item.classes.has('turn'))).toEqual([false, false, true, true, false, true]);
  // Every line is read out with its speaker, shown or not.
  expect(page.items.map((item) => item.getAttribute('aria-label'))).toEqual([
    '0:00 Avery: Line 0', '0:05 Avery: Line 1', '0:10 Rowan: Line 2', '0:15 Line 3', '0:20 Line 4', '0:25 Rowan: Line 5']);
});

test('in a meeting of an hour or more every time has hours, so the time column keeps one width', () => {
  const record = (ends: number) => createTranscriptRecord({
    transcript: [{ start: 5, end: 9, text: 'Hello' }, { start: ends, end: ends + 4, text: 'Bye' }], speakers: [] }, { id: 'h', title: 'Hours' });
  const times = (ends: number) => playerHarness(renderVideoPlayerPage('/m', record(ends), { ...movie(-1), segments: [movie(-1)] }))
    .items.map((item) => (item.children[0] as unknown as { textContent: string }).textContent);
  expect(times(3599)).toEqual(['0:05', '59:59']);
  expect(times(3700)).toEqual(['0:00:05', '1:01:40']);
});

test('opening deep in a meeting starts the view on a whole line, with the line being said in view', () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ start: index * 10, end: index * 10 + 8, text: `Line ${index}` }));
  const page = playerHarness(renderVideoPlayerPage('/m', createTranscriptRecord({ transcript: many, speakers: [] }, { id: 'd', title: 'Deep' }),
    { ...movie(-1), segments: [movie(-1)] }, 301), 410);
  expect(page.current()).toBe(30);
  const top = page.list.scrollTop + 20;
  // The first line below the fade starts exactly at its edge: no line is cut through.
  expect(page.items.some((item) => item.offsetTop === top)).toBe(true);
  const current = page.items[30]!;
  expect(current.offsetTop).toBeGreaterThanOrEqual(top);
  expect(current.offsetTop + current.offsetHeight).toBeLessThanOrEqual(page.list.scrollTop + 410 * 0.8);
});
