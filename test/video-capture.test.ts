import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CaptureVideoSegment, CaptureVideoSlot } from '../src/capture-session.ts';
import {
  readVideoSidecar,
  screenCaptureArguments,
  screenCapturePermission,
  startVideoCapture,
  startVideoTrack,
  type VideoCaptureHandle,
  type VideoCaptureRequest,
  type VideoCaptureResult,
  type VideoState,
} from '../src/video-capture.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'seashell-video-capture-'));
  roots.push(root);
  return root;
}

const request: VideoCaptureRequest = { target: { kind: 'window', pid: 42, bundleIds: ['us.zoom.xos'] }, fps: 2, quality: 'medium' };

/**
 * A stand-in for seashell-screen-capture that speaks its protocol: JSON events
 * on stderr, a movie and a sidecar, a clean finish on SIGINT.
 */
const FAKE_HELPER = `
const [mode, ...args] = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const output = value('--output'), sidecar = value('--sidecar');
const origin = Number(value('--session-origin-unix-ms'));
const emit = (event) => process.stderr.write(JSON.stringify(event) + '\\n');
const fs = require('fs');
const first = origin + 1250;
const writeSidecar = (finished, extra = {}) => fs.writeFileSync(sidecar, JSON.stringify({ schemaVersion: 1, file: 'x.mp4',
  codec: 'h264', fps: 2, width: 1920, height: 1080, firstFrameUnixMs: first, frames: 4, finished,
  target: { kind: 'window', app: 'zoom.us', bundleId: 'us.zoom.xos', title: 'Zoom Meeting (private)' }, ...extra }));
if (mode === 'permission') { emit({ type: 'error', code: 'permission', message: 'Screen Recording is off.' }); process.exit(77); }
if (mode === 'args') { fs.writeFileSync(output + '.args', JSON.stringify(args)); }
if (mode === 'no-window') { emit({ type: 'error', code: 'no-window', message: 'No call window is open to film.' }); process.exit(4); }
if (mode === 'tab') {
  emit({ type: 'target', kind: 'window', app: 'Google Chrome', bundleId: 'com.google.Chrome', call: 'Google Meet', title: 'Meet - abc-defg-hij' });
  setTimeout(() => emit({ type: 'waiting', message: 'The browser is showing another tab, so the video is paused until the call shows again.' }), 40);
  setTimeout(() => emit({ type: 'target', kind: 'window', app: 'Google Chrome', bundleId: 'com.google.Chrome', call: 'the call' }), 60);
} else emit({ type: 'target', kind: 'window', app: 'zoom.us', bundleId: 'us.zoom.xos', width: 1920, height: 1080 });
if (mode === 'no-frames') {
  process.on('SIGINT', () => { emit({ type: 'error', code: 'no-frames', message: 'No screen frames arrived.' }); process.exit(3); });
} else {
  setTimeout(() => {
    fs.writeFileSync(output, Buffer.alloc(2048, 1));
    writeSidecar(false);
    emit({ type: 'first-frame', firstFrameUnixMs: first });
    if (mode === 'crash') setTimeout(() => process.exit(1), 30);
  }, 20);
  process.on('SIGINT', () => {
    if (mode === 'stubborn') return;
    writeSidecar(true, { durationMs: 61_000 });
    emit({ type: 'stopped', frames: 4, bytes: 2048, saved: true });
    process.exit(0);
  });
}
// Signal handlers are installed: the test may stop it now.
emit({ type: 'warning', message: 'fake ready' });
setInterval(() => {}, 1000);
`;

function fakeHelper(root: string, mode: string): string {
  const script = join(root, 'fake-helper.js');
  writeFileSync(script, FAKE_HELPER);
  const wrapper = join(root, `fake-helper-${mode}`);
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${mode} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

/** Stops `stopAfterMs` after the fake helper is ready, so a slow start never races the stop. */
function run(mode: string, options: { stopAfterMs?: number; stopTimeoutMs?: number } = {}) {
  const root = temporary();
  const firstFrames: number[] = [];
  const warnings: string[] = [];
  const events: string[] = [];
  const ready = () => {
    if (options.stopAfterMs !== undefined) setTimeout(() => handle.stop(), options.stopAfterMs);
  };
  const handle = startVideoCapture({
    request,
    outputPath: join(root, '000001.mp4'),
    sidecarPath: join(root, '000001.json'),
    sessionStartedAtUnixMs: 1_800_000_000_000,
    command: fakeHelper(root, mode),
    onFirstFrame: (info) => firstFrames.push(info.firstFrameUnixMs),
    onWarning: (message) => { if (message === 'fake ready') ready(); else warnings.push(message); },
    onTarget: (filming) => events.push(`${filming.kind}: ${filming.name}`),
    onWaiting: (message) => events.push(`waiting: ${message}`),
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
  });
  return { root, handle, firstFrames, warnings, events };
}

test('helper arguments carry the window, the session clock and the settings', () => {
  expect(screenCaptureArguments({ request, outputPath: '/b/video/000001.mp4', sidecarPath: '/b/video/000001.json', sessionStartedAtUnixMs: 7 }))
    .toEqual(['--output', '/b/video/000001.mp4', '--sidecar', '/b/video/000001.json', '--session-origin-unix-ms', '7',
      '--fps', '2', '--quality', 'medium', '--pid', '42', '--bundle-id', 'us.zoom.xos']);
  expect(screenCaptureArguments({ request: { target: { kind: 'display', display: 2 }, fps: 5, quality: 'low' },
    outputPath: 'o', sidecarPath: 's', sessionStartedAtUnixMs: 1 }).slice(6)).toEqual(['--fps', '5', '--quality', 'low', '--display', '2']);
  expect(screenCaptureArguments({ request: { target: { kind: 'window', appName: 'Keynote', callWindowOnly: true }, fps: 2, quality: 'high' },
    outputPath: 'o', sidecarPath: 's', sessionStartedAtUnixMs: 1 }).slice(10)).toEqual(['--app-name', 'Keynote', '--call-window-only']);
  expect(screenCaptureArguments({ request: { target: { kind: 'window', bundleIds: ['com.google.Chrome'], browserBundleIds: ['com.google.Chrome', 'com.apple.Safari'],
    callTitle: ' Weekly sync ' }, fps: 2, quality: 'high' }, outputPath: 'o', sidecarPath: 's', sessionStartedAtUnixMs: 1 }).slice(10))
    .toEqual(['--bundle-id', 'com.google.Chrome', '--browser-bundle-id', 'com.google.Chrome', '--browser-bundle-id', 'com.apple.Safari', '--call-title', 'Weekly sync']);
});

test('a stopped recording reports its first frame, then the finished movie from its sidecar', async () => {
  const { handle, firstFrames } = run('normal', { stopAfterMs: 100 });
  const result = await handle.done;
  expect(firstFrames).toEqual([1_800_000_001_250]);
  expect(result).toMatchObject({ saved: true, requestedStop: true, segment: {
    firstFrameUnixMs: 1_800_000_001_250, durationMs: 61_000, frames: 4, bytes: 2048, codec: 'h264', finished: true,
    target: { kind: 'window', app: 'zoom.us', bundleId: 'us.zoom.xos' },
  } });
  // The window title stays in the sidecar; it is not carried into the capture.
  expect(JSON.stringify(result)).not.toContain('private');
});

test('missing Screen Recording access is a warning with the fix, never a prompt', async () => {
  const { handle } = run('permission');
  const result = await handle.done;
  expect(result).toMatchObject({ saved: false, reason: 'permission', requestedStop: false });
  expect(result.saved === false && result.message).toContain('seashell meeting video setup');
});

test('a crashed helper keeps the movie written so far', async () => {
  const { handle } = run('crash');
  const result = await handle.done;
  expect(result).toMatchObject({ saved: true, requestedStop: false, segment: { bytes: 2048, finished: false } });
});

test('a helper that will not stop is killed after its deadline, keeping its fragments', async () => {
  const started = Date.now();
  const { handle } = run('stubborn', { stopAfterMs: 100, stopTimeoutMs: 200 });
  const result = await handle.done;
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result).toMatchObject({ saved: true, requestedStop: true, segment: { finished: false } });
});

test('with no call window the helper says so and films nothing; no frames means no movie', async () => {
  const none = run('no-window');
  const result = await none.handle.done;
  expect(result.saved === false && [result.reason, result.message]).toEqual(['no-window', 'No call window is open, so nothing is filmed; the audio is recording.']);
  expect([none.events, existsSync(join(none.root, '000001.mp4'))]).toEqual([[], false]);
  const empty = run('no-frames', { stopAfterMs: 0 });
  expect(await empty.handle.done).toMatchObject({ saved: false, reason: 'no-frames' });
});

test('what is filmed is named by the call, never the tab\'s title; another tab pauses it', async () => {
  const zoom = run('normal', { stopAfterMs: 50 });
  await zoom.handle.done;
  expect(zoom.events).toEqual(['window: the Zoom window']);
  const browser = run('tab', { stopAfterMs: 100 });
  await browser.handle.done;
  expect(browser.events).toEqual(['window: the Google Meet window',
    'waiting: The browser is showing another tab, so the video is paused until the call shows again.', 'window: the call window']);
  expect(browser.events.join(' ')).not.toContain('abc-defg-hij');
});

test('a missing helper resolves instead of throwing', async () => {
  const root = temporary();
  const handle = startVideoCapture({ request, outputPath: join(root, 'a.mp4'), sidecarPath: join(root, 'a.json'),
    sessionStartedAtUnixMs: 1, command: join(root, 'missing-helper') });
  expect(await handle.done).toMatchObject({ saved: false, reason: 'failed' });
});

test('sidecars without a first frame are not movies', () => {
  const root = temporary();
  const path = join(root, 's.json');
  writeFileSync(path, JSON.stringify({ finished: true }));
  expect(readVideoSidecar(path)).toBeUndefined();
  writeFileSync(path, '{broken');
  expect(readVideoSidecar(path)).toBeUndefined();
  writeFileSync(path, JSON.stringify({ firstFrameUnixMs: 5, durationMs: -1, finished: false, target: { kind: 'elsewhere' } }));
  expect(readVideoSidecar(path)).toEqual({ firstFrameUnixMs: 5, finished: false });
});

function slots(root: string) {
  let next = 0;
  return (): CaptureVideoSlot => {
    next++;
    const name = String(next).padStart(6, '0');
    return { id: `video.${name}`, sequence: next, relativePath: `video/${name}.mp4`, sidecarRelativePath: `video/${name}.json`,
      path: join(root, `${name}.mp4`), sidecarPath: join(root, `${name}.json`) };
  };
}

function scriptedStarter(results: VideoCaptureResult[], firstFrameUnixMs = 1_000_400) {
  const started: string[] = [];
  const starter = (options: Parameters<typeof startVideoCapture>[0]): VideoCaptureHandle => {
    started.push(options.outputPath);
    const result = results.shift() ?? { saved: false, reason: 'failed', message: 'out of script', requestedStop: false };
    let finish: (value: VideoCaptureResult) => void = () => {};
    const done = new Promise<VideoCaptureResult>((resolve) => { finish = resolve; });
    if (result.saved) options.onFirstFrame?.({ firstFrameUnixMs, finished: false });
    // A result that waits for stop() models a helper still recording.
    if (!result.requestedStop) queueMicrotask(() => finish(result));
    return { done, stop: () => finish({ ...result, requestedStop: true }) };
  };
  return { starter, started };
}

test('a video track restarts a crashed recorder into a new movie and lists both on the session clock', async () => {
  const root = temporary();
  const segments: Array<Omit<CaptureVideoSegment, 'recordedAt'>> = [];
  const states: VideoState[] = [];
  const warnings: string[] = [];
  const crashed: VideoCaptureResult = { saved: true, requestedStop: false, segment: { firstFrameUnixMs: 1_000_400, bytes: 9, finished: false } };
  const running: VideoCaptureResult = { saved: true, requestedStop: true, segment: { firstFrameUnixMs: 1_000_400, durationMs: 5_000, bytes: 9, finished: true } };
  const { starter, started } = scriptedStarter([crashed, running]);
  const track = startVideoTrack({
    request, sessionStartedAtUnixMs: 1_000_000, nextSegment: slots(root), starter, restartDelayMs: 1,
    onSegment: (segment) => { segments.push(segment); },
    onState: (state) => states.push(state),
    onWarning: (message) => warnings.push(message),
  });
  const deadline = Date.now() + 5_000;
  while (started.length < 2 && Date.now() < deadline) await Bun.sleep(5);
  expect(started).toHaveLength(2);
  track.stop();
  await track.done;
  expect(warnings).toEqual(['The screen recorder stopped unexpectedly. Starting video again.']);
  expect(segments.map((segment) => [segment.id, segment.firstFrameMs, segment.finished])).toEqual([
    ['video.000001', 400, false], ['video.000001', 400, false],
    ['video.000002', 400, false], ['video.000002', 400, true],
  ]);
  expect(segments.at(-1)).toMatchObject({ fps: 2, quality: 'medium', durationMs: 5_000, relativePath: 'video/000002.mp4' });
  expect(states).toEqual(['starting', 'recording', 'starting', 'recording', 'stopped']);
});

test('a video track gives up after a few restarts and never retries a permission problem', async () => {
  const root = temporary();
  const failed: VideoCaptureResult = { saved: false, reason: 'failed', message: 'Encoder broke.', requestedStop: false };
  const flaky = scriptedStarter([failed, failed, failed]);
  const warnings: string[] = [];
  const states: VideoState[] = [];
  await startVideoTrack({ request, sessionStartedAtUnixMs: 0, nextSegment: slots(root), starter: flaky.starter,
    maxRestarts: 2, restartDelayMs: 1, onSegment: () => {}, onWarning: (message) => warnings.push(message),
    onState: (state) => states.push(state) }).done;
  expect(flaky.started).toHaveLength(3);
  expect(warnings.at(-1)).toBe('Encoder broke. Video stays off for the rest of this recording; audio continues.');
  expect(states.at(-1)).toBe('unavailable');

  const denied = scriptedStarter([{ saved: false, reason: 'permission', message: 'Turn on Screen Recording.', requestedStop: false }]);
  const deniedWarnings: string[] = [];
  await startVideoTrack({ request, sessionStartedAtUnixMs: 0, nextSegment: slots(root), starter: denied.starter,
    onSegment: () => {}, onWarning: (message) => deniedWarnings.push(message) }).done;
  expect(denied.started).toHaveLength(1);
  expect(deniedWarnings).toEqual(['Turn on Screen Recording.']);
});

test('a video track with no call window records audio alone and looks again, never filming the display', async () => {
  const root = temporary();
  const noWindow: VideoCaptureResult = { saved: false, reason: 'no-window', message: 'No call window is open, so nothing is filmed; the audio is recording.', requestedStop: false };
  const later: VideoCaptureResult = { saved: true, requestedStop: true, segment: { firstFrameUnixMs: 1_000_400, durationMs: 5_000, bytes: 9, finished: true } };
  const { starter, started } = scriptedStarter([noWindow, noWindow, noWindow, noWindow, later]);
  const states: VideoState[] = [];
  const warnings: string[] = [];
  const requests: VideoCaptureRequest[] = [];
  const track = startVideoTrack({
    request, sessionStartedAtUnixMs: 1_000_000, nextSegment: slots(root), windowRetryMs: 5, maxRestarts: 1,
    starter: (options) => { requests.push(options.request); return starter(options); },
    onSegment: () => {}, onState: (state) => { if (states.at(-1) !== state) states.push(state); }, onWarning: (message) => warnings.push(message),
  });
  const deadline = Date.now() + 5_000;
  while (started.length < 5 && Date.now() < deadline) await Bun.sleep(5);
  track.stop();
  await track.done;
  // Looking again is not a restart: four misses never use up the one restart allowed.
  expect(started).toHaveLength(5);
  expect(requests.every((value) => value.target.kind === 'window')).toBe(true);
  expect(warnings).toEqual(['No call window is open, so nothing is filmed; the audio is recording. Seashell looks for the call window again every 30 seconds.']);
  expect(states).toEqual(['starting', 'waiting', 'recording', 'stopped']);
});

test('a video track that cannot list its movie still records, and warns', async () => {
  const root = temporary();
  const { starter } = scriptedStarter([{ saved: true, requestedStop: true, segment: { firstFrameUnixMs: 10, finished: true } }]);
  const warnings: string[] = [];
  const track = startVideoTrack({ request, sessionStartedAtUnixMs: 0, nextSegment: slots(root), starter,
    onSegment: () => { throw new Error('disk full'); }, onWarning: (message) => warnings.push(message) });
  track.stop();
  await track.done;
  expect(warnings[0]).toBe('Video is saved, but the capture could not list it: disk full');
});

test('permission is read from the stable runtime copy of the helper', async () => {
  const root = temporary();
  const helper = join(root, 'seashell-screen-capture');
  writeFileSync(helper, '#!/bin/sh\necho \'{"authorization":"authorized","executable":"x"}\'\n');
  chmodSync(helper, 0o755);
  const hostDirectory = join(root, 'Runtime');
  const status = await screenCapturePermission({ helperPath: helper, runtimeHost: { hostDirectory } });
  expect(status.authorization).toBe('authorized');
  expect(status.executable).toBe(join(hostDirectory, 'Seashell Screen Capture'));
  expect(existsSync(join(hostDirectory, 'Seashell Screen Capture'))).toBe(true);
  writeFileSync(helper, '#!/bin/sh\necho \'{"authorization":"denied"}\'\nexit 77\n');
  rmSync(hostDirectory, { recursive: true });
  const denied = await screenCapturePermission({ helperPath: helper, request: true, runtimeHost: { hostDirectory } });
  expect(denied.authorization).toBe('denied');
  expect(denied.detail).toContain('Screen & System Audio Recording');
  expect(readFileSync(join(hostDirectory, 'Seashell Screen Capture'), 'utf8')).toContain('denied');
});
