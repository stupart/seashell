import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { browserBundleIds, type MeetingCandidate } from '../src/meeting-automation.ts';
import {
  consumeVideoRequest,
  meetingVideoRequest,
  startRecordingWithVideo,
  videoRequestPath,
  videoTargetFor,
  writeVideoRequest,
} from '../src/video-recording.ts';

let root: string;
const previousCommandPath = process.env.SEASHELL_MEETING_COMMAND_PATH;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'seashell-video-request-'));
  process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
});
afterEach(() => {
  if (previousCommandPath === undefined) delete process.env.SEASHELL_MEETING_COMMAND_PATH;
  else process.env.SEASHELL_MEETING_COMMAND_PATH = previousCommandPath;
  rmSync(root, { recursive: true, force: true });
});

function candidate(overrides: Partial<MeetingCandidate>): MeetingCandidate {
  return { id: 'audio:zoom', appName: 'Zoom', bundleId: 'us.zoom.xos', pid: 4242, kind: 'dedicated', title: 'Zoom meeting',
    evidence: ['audio-input-process'], requiresConsent: false, ...overrides };
}

const browsers = browserBundleIds();

test('a call records its own app window by default, at 2 fps and medium quality', () => {
  expect(meetingVideoRequest({}, candidate({}))).toEqual({
    target: { kind: 'window', pid: 4242, bundleIds: ['us.zoom.xos', 'us.zoom.ZoomPhone'], appName: 'Zoom', browserBundleIds: browsers },
    fps: 2, quality: 'medium',
  });
  // Chrome's audio comes from a helper process; the window belongs to Chrome, and only a tab that looks like the call is filmed.
  expect(meetingVideoRequest({ meeting: { video: { fps: 5, quality: 'high' } } },
    candidate({ appName: 'Google Meet', bundleId: 'com.google.Chrome.helper', pid: 0, kind: 'browser',
      calendar: { provider: 'mac', eventId: 'e', title: ' Weekly sync ', startAt: '2026-11-11T09:00:00Z', endAt: '2026-11-11T09:30:00Z', attendees: [] } }))).toEqual({
    target: { kind: 'window', bundleIds: ['com.google.Chrome.helper', 'com.google.Chrome'], appName: 'Google Chrome',
      browserBundleIds: browsers, callTitle: 'Weekly sync' },
    fps: 5, quality: 'high',
  });
  expect(browsers).toEqual(expect.arrayContaining(['com.google.Chrome', 'com.apple.Safari', 'org.mozilla.firefox']));
  expect(browsers).not.toContain('us.zoom.xos');
});

test('video stays off when it is turned off, overall or for that app', () => {
  expect(meetingVideoRequest({ meeting: { video: { enabled: false } } }, candidate({}))).toBeUndefined();
  expect(meetingVideoRequest({ meeting: { video: { apps: { zoom: false } } } }, candidate({}))).toBeUndefined();
  expect(meetingVideoRequest({ meeting: { video: { apps: { teams: false } } } }, candidate({}))).toBeDefined();
});

test('a recording started by hand films only when asked, whatever the video setting', () => {
  const manual = candidate({ id: 'manual:1', appName: 'Seashell', bundleId: '', pid: 0, kind: 'manual' });
  expect(meetingVideoRequest({}, manual, () => undefined)).toBeUndefined();
  expect(meetingVideoRequest({ meeting: { video: { enabled: false, fps: 4 } } }, manual, () => ({ display: 2 })))
    .toEqual({ target: { kind: 'display', display: 2 }, fps: 4, quality: 'medium' });
});

test('naming a window finds a known app by id or name, and any other app by its name', () => {
  expect(videoTargetFor({ window: 'zoom' })).toEqual({ kind: 'window', appName: 'Zoom', bundleIds: ['us.zoom.xos', 'us.zoom.ZoomPhone'] });
  expect(videoTargetFor({ window: 'Google Chrome' })).toMatchObject({ appName: 'Google Chrome', bundleIds: ['com.google.Chrome'] });
  expect(videoTargetFor({ window: 'Keynote' })).toEqual({ kind: 'window', appName: 'Keynote' });
  // Nothing named: the call's window, a browser's only while it shows the call; never a whole display.
  const auto = videoTargetFor({});
  expect(auto).toMatchObject({ kind: 'window', callWindowOnly: true, browserBundleIds: browsers });
  expect(auto.kind === 'window' && auto.bundleIds).toContain('com.microsoft.teams2');
});

test('a video request is read once, and a stale one is dropped', () => {
  const path = videoRequestPath();
  expect(path).toBe(join(root, 'meeting-video-request.json'));
  writeVideoRequest({ window: 'Zoom' }, path, 10_000);
  expect(consumeVideoRequest(path, 12_000)).toEqual({ window: 'Zoom' });
  expect(existsSync(path)).toBe(false);
  expect(consumeVideoRequest(path, 12_000)).toBeUndefined();
  writeVideoRequest({ display: 1 }, path, 10_000);
  expect(consumeVideoRequest(path, 10_000 + 31_000)).toBeUndefined();
  expect(existsSync(path)).toBe(false);
});

test('Space with video leaves the video request, then the start command, for the recorder', () => {
  startRecordingWithVideo({ display: 2 });
  expect(JSON.parse(readFileSync(join(root, 'meeting-command.json'), 'utf8'))).toMatchObject({ command: 'start' });
  const manual = candidate({ id: 'manual:2', bundleId: '', pid: 0, kind: 'manual' });
  expect(meetingVideoRequest({}, manual)).toEqual({ target: { kind: 'display', display: 2 }, fps: 2, quality: 'medium' });
  expect(meetingVideoRequest({}, manual)).toBeUndefined();
});
