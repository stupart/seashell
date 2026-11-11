import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AutomaticMeetingWatchService } from '../src/automatic-meeting-watch.ts';
import { readBackgroundWatchStatus } from '../src/background-watch-status.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import type { MeetingCalendarEvent } from '../src/meeting-artifact.ts';
import type { AudioInputProcess } from '../src/meeting-automation.ts';
import type { MeetProbe } from '../src/meet-speakers.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TERMINAL = 'com.apple.Terminal';
const ZOOM = { pid: 42, bundleId: 'us.zoom.xos', name: 'Zoom' };
const CHROME_MIC = { pid: 7, bundleId: 'com.google.Chrome.helper', name: 'Google Chrome Helper' };
const JOINED: MeetProbe = { state: 'connected', detail: 'Joined', browser: 'chrome',
  snapshot: { meeting: '/abc-defg-hij', joined: true, participants: [] } };
const IDLE: MeetProbe = { state: 'idle', detail: 'Not in a call' };

function watch(options: { calendar?: MeetingCalendarEvent[]; resumeWindowSeconds?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seashell-meet-probes-'));
  roots.push(root);
  const state = {
    now: 0,
    frontmost: TERMINAL as string | undefined,
    supported: true,
    input: [] as AudioInputProcess[],
    probe: IDLE,
    probes: 0,
  };
  const service = new AutomaticMeetingWatchService({
    libraryDir: root,
    config: { libraryDir: root, meeting: {
      speakerBrowser: 'auto',
      automation: { confirmationPolls: 2, endGraceSeconds: 6, cooldownSeconds: 6, resumeWindowSeconds: options.resumeWindowSeconds ?? 0 },
      ...(options.calendar ? { calendar: { enabled: true, policy: 'ask' as const, leadMinutes: 5 } } : {}),
    } },
    dependencies: {
      now: () => new Date(state.now),
      readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: state.now, supported: state.supported,
        ...(state.frontmost ? { frontmostBundleId: state.frontmost } : {}), inputProcesses: state.input }),
      readMeet: async () => { state.probes++; return state.probe; },
      readCalendar: async () => options.calendar ?? [],
      consumeCommand: () => undefined,
      consumeConsent: () => undefined,
      startCapture: (capture) => {
        const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'probe-call',
          startedAtUnixMs: capture.startedAt!.getTime(), createdAt: capture.startedAt!.toISOString() });
        return { store, sessionId: 'probe-call', manifestPath: store.manifestPath,
          async stop() { return store.setStatus('captured', 'test'); } };
      },
      finalizeCapture: async () => createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'Made-up words.' }], speakers: [] },
        { id: 'probe-call', now: new Date(0), title: 'Made-up call' }),
    },
  });
  const poll = async (count = 1) => {
    for (let index = 0; index < count; index++) {
      state.now += 3_000;
      await service.pollOnce();
      await Bun.sleep(0);
    }
  };
  return { root, state, service, poll };
}

test('an idle Mac with no browser in front or on the microphone never checks Meet', async () => {
  const { state, service, poll } = watch();
  try {
    await poll(20);
    expect(state.probes).toBe(0);
    expect(service.phase).toBe('watching');
  } finally { await service.shutdown(); }
});

test('a browser in front is checked every poll, so a muted Meet call still starts recording', async () => {
  const { state, service, poll } = watch();
  try {
    state.frontmost = 'com.google.Chrome';
    await poll(3);
    expect(state.probes).toBe(3);
    state.probe = JOINED;
    await poll(2);
    expect(service.phase).toBe('recording');
    // In a call, Meet is checked every poll even with the browser behind other windows.
    state.frontmost = TERMINAL;
    await poll(5);
    expect(state.probes).toBe(10);
    // After the call: checks continue for five minutes after the browser was last in front, then stop.
    state.probe = IDLE;
    await poll(10);
    expect(service.phase).toBe('watching');
    await poll(100);
    const settled = state.probes;
    await poll(10);
    expect(state.probes).toBe(settled);
  } finally { await service.shutdown(); }
});

test('a browser holding the microphone is checked even when it is not in front', async () => {
  const { state, service, poll } = watch();
  try {
    state.input = [CHROME_MIC];
    await poll(4);
    expect(state.probes).toBe(4);
    expect(service.phase).toBe('awaiting-consent');
    // The unanswered question lapses on the next poll, which still checks.
    state.input = [];
    await poll();
    expect(service.phase).toBe('watching');
    await poll(4);
    expect(state.probes).toBe(5);
  } finally { await service.shutdown(); }
});

test('a Zoom call is checked once it is being confirmed and for as long as it records', async () => {
  const { state, service, poll } = watch();
  try {
    state.input = [ZOOM];
    await poll();
    // The first sighting moves the watch out of "watching", so the next poll checks.
    expect(state.probes).toBe(0);
    await poll();
    expect(service.phase).toBe('recording');
    await poll(5);
    expect(state.probes).toBe(6);
  } finally { await service.shutdown(); }
});

test('a call held for resume keeps being checked until its window passes', async () => {
  const { state, service, poll } = watch({ resumeWindowSeconds: 60 });
  try {
    state.input = [ZOOM];
    await poll(2);
    expect(service.phase).toBe('recording');
    state.input = [];
    await poll(3);
    expect(service.phase).not.toBe('recording');
    const ended = state.probes;
    // Cooldown is 6 s; the resume window is 60 s.
    await poll(10);
    expect(service.phase).toBe('watching');
    expect(state.probes - ended).toBe(10);
    await poll(10);
    const expired = state.probes;
    await poll(5);
    expect(state.probes).toBe(expired);
  } finally { await service.shutdown(); }
});

const calendarEvent = (overrides: Partial<MeetingCalendarEvent>): MeetingCalendarEvent => ({
  provider: 'test', eventId: 'event-1', title: 'Made-up sync',
  startAt: new Date(4 * 60_000).toISOString(), endAt: new Date(34 * 60_000).toISOString(), attendees: [], ...overrides,
});

test('a video call on the calendar is checked every 30 s; an in-person meeting is not', async () => {
  const inPerson = watch({ calendar: [calendarEvent({ location: 'Room 4' })] });
  try {
    await inPerson.poll(20);
    expect(inPerson.state.probes).toBe(0);
  } finally { await inPerson.service.shutdown(); }
  const video = watch({ calendar: [calendarEvent({ joinUrl: 'https://meet.google.com/abc-defg-hij' })] });
  try {
    // The calendar is read in the background; checks start once it has answered (6 s), then every 30 s.
    await video.poll(20);
    expect(video.state.probes).toBe(2);
  } finally { await video.service.shutdown(); }
});

test('a video call 15 minutes away or just over is checked with the browser in the background, and not outside that', async () => {
  // Starts at 14:03 into the test: inside the window from the first poll.
  const soon = watch({ calendar: [calendarEvent({ startAt: new Date(14 * 60_000 + 3_000).toISOString(),
    endAt: new Date(44 * 60_000).toISOString(), joinUrl: 'https://zoom.us/j/123456789' })] });
  try {
    await soon.poll(40);
    // Polls every 3 s for 2 minutes: the first check at 6 s, then 36, 66 and 96 s.
    expect(soon.state.probes).toBe(4);
  } finally { await soon.service.shutdown(); }
  // Ended 16 minutes ago and the next is 20 minutes away: nothing to check for.
  const far = watch({ calendar: [
    calendarEvent({ eventId: 'earlier', startAt: new Date(-46 * 60_000).toISOString(), endAt: new Date(-16 * 60_000).toISOString(),
      joinUrl: 'https://meet.google.com/abc-defg-hij' }),
    calendarEvent({ eventId: 'later', startAt: new Date(20 * 60_000 + 30_000).toISOString(), endAt: new Date(50 * 60_000).toISOString(),
      joinUrl: 'https://meet.google.com/abc-defg-hij' }),
  ] });
  try {
    await far.poll(40);
    expect(far.state.probes).toBe(0);
  } finally { await far.service.shutdown(); }
});

test('a browser that was in front is checked every poll for five minutes after, so a call joined before switching away is found', async () => {
  const { state, service, poll } = watch();
  try {
    state.frontmost = 'com.google.Chrome';
    await poll();
    state.frontmost = TERMINAL;
    // Joined just before switching away, with the microphone muted.
    await poll(10);
    expect(state.probes).toBe(11);
    state.probe = JOINED;
    await poll(2);
    expect(service.phase).toBe('recording');
  } finally { await service.shutdown(); }
  const idle = watch();
  try {
    idle.state.frontmost = 'com.apple.Safari';
    await idle.poll();
    idle.state.frontmost = TERMINAL;
    // Five minutes of polls every 3 s, then none: the idle Mac stays cheap.
    await idle.poll(200);
    expect(idle.state.probes).toBe(100);
  } finally { await idle.service.shutdown(); }
});

test('when the signals cannot say what is in front, Meet is checked as before', async () => {
  const { state, service, poll } = watch();
  try {
    state.frontmost = undefined;
    await poll(3);
    state.frontmost = TERMINAL;
    state.supported = false;
    await poll(3);
    expect(state.probes).toBe(6);
  } finally { await service.shutdown(); }
});

test('a Meet warning still shows while checks are paused', async () => {
  const { root, state, service, poll } = watch();
  try {
    state.frontmost = 'com.apple.Safari';
    state.probe = { state: 'permission', detail: 'Accessibility access was removed.', source: 'google-meet-accessibility' };
    await poll();
    state.frontmost = TERMINAL;
    // Checks go on for five minutes after the browser was in front, then pause.
    await poll(100);
    const paused = state.probes;
    await poll(3);
    expect(state.probes).toBe(paused);
    expect(readBackgroundWatchStatus(root, { nowUnixMs: state.now })?.warning).toBe('Accessibility access was removed.');
  } finally { await service.shutdown(); }
});
