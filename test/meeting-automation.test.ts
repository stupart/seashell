import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MeetingSignalMonitor,
  MeetingAutomationController,
  parseMeetingSignalSnapshot,
  resolveMeetingCandidate,
  preserveMeetingCandidateDuringObservationGap,
  type MeetingCandidate,
} from '../src/meeting-automation.ts';
import type { MeetingCalendarEvent } from '../src/meeting-artifact.ts';

const calendar: MeetingCalendarEvent = {
  provider: 'macos-calendar',
  eventId: 'event-1',
  title: 'Blueprint review',
  startAt: '2026-08-15T15:00:00.000Z',
  endAt: '2026-08-15T16:00:00.000Z',
  attendees: [{ name: 'Tyler' }, { name: 'Ada' }],
};

const zoom: MeetingCandidate = {
  id: 'audio:zoom',
  appName: 'Zoom',
  bundleId: 'us.zoom.xos',
  pid: 42,
  kind: 'dedicated',
  title: 'Zoom meeting',
  evidence: ['audio-input-process'],
  requiresConsent: false,
};

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('meeting signal parsing and candidate resolution', () => {
  test('a silent helper cannot keep returning a cached active meeting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-signal-stale-'));
    temporaryRoots.push(root);
    const helper = join(root, 'signal-helper');
    writeFileSync(helper, `
console.log(JSON.stringify({schemaVersion:1,capturedAtUnixMs:Date.now(),supported:true,
  inputProcesses:[{pid:42,bundleId:'us.zoom.xos',name:'Zoom'}]}));
setInterval(() => {}, 1000);
`, { mode: 0o600 });
    const monitor = new MeetingSignalMonitor(process.execPath, 250, [helper]);
    const errors: string[] = [];
    monitor.onError((error) => errors.push(error.message));
    try {
      expect((await monitor.waitForSnapshot()).inputProcesses).toHaveLength(1);
      await Bun.sleep(1_300);
      expect(() => monitor.latest()).toThrow('heartbeat');
      expect(errors.some((message) => message.includes('heartbeat'))).toBe(true);
    } finally { monitor.stop(); }
  });

  test('restart discards a partial JSON line from the previous helper', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-signal-restart-'));
    temporaryRoots.push(root);
    const helper = join(root, 'signal-helper');
    writeFileSync(helper, `
import {existsSync,writeFileSync} from 'fs';
const marker = ${JSON.stringify(join(root, 'started'))};
if (!existsSync(marker)) {
  writeFileSync(marker, ''); process.stdout.write('{"schemaVersion":');
} else {
  console.log(JSON.stringify({schemaVersion:1,capturedAtUnixMs:2000,supported:true,inputProcesses:[]}));
  setInterval(() => {}, 1000);
}
`, { mode: 0o600 });
    const monitor = new MeetingSignalMonitor(process.execPath, 250, [helper]);
    let timer: ReturnType<typeof setTimeout>;
    const restarted = new Promise<number>((resolve, reject) => {
      monitor.subscribe((snapshot) => resolve(snapshot.capturedAtUnixMs));
      timer = setTimeout(() => reject(new Error('helper never recovered')), 3_000);
    });
    monitor.start();
    try { expect(await restarted).toBe(2_000); }
    finally { clearTimeout(timer!); monitor.stop(); }
  });

  test('stopping a starting detector promptly rejects pending readers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-signal-stop-'));
    temporaryRoots.push(root);
    const helper = join(root, 'signal-helper');
    writeFileSync(helper, 'setInterval(() => {}, 1000);\n', { mode: 0o600 });
    const monitor = new MeetingSignalMonitor(process.execPath, 250, [helper]);
    const pending = monitor.waitForSnapshot(1_000).catch((error: Error) => error.message);
    const startedAt = Date.now();
    monitor.stop();
    expect(await pending).toContain('stopped');
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test('one persistent helper streams multiple snapshots without being respawned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-signal-monitor-'));
    temporaryRoots.push(root);
    const helper = join(root, 'signal-helper');
    writeFileSync(helper, `
console.log(JSON.stringify({schemaVersion:1,capturedAtUnixMs:1000,supported:true,inputProcesses:[]}));
await Bun.sleep(50);
console.log(JSON.stringify({schemaVersion:1,capturedAtUnixMs:2000,supported:true,inputProcesses:[]}));
setInterval(() => {}, 1000);
`, { mode: 0o600 });
    const monitor = new MeetingSignalMonitor(process.execPath, 250, [helper]);
    const seen: number[] = [];
    const unsubscribe = monitor.subscribe((snapshot) => seen.push(snapshot.capturedAtUnixMs));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeSecond = () => {};
    const secondSnapshot = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('second streamed snapshot timed out')), 1_000);
      removeSecond = monitor.subscribe((snapshot) => {
        if (snapshot.capturedAtUnixMs !== 2_000) return;
        clearTimeout(timeout);
        removeSecond();
        resolve();
      });
    });
    try {
      // Observe both rejections immediately so a startup failure cannot leave
      // the second timeout unhandled or skip detector cleanup.
      const [first] = await Promise.all([monitor.waitForSnapshot(1_000), secondSnapshot]);
      expect(first.capturedAtUnixMs).toBe(1_000);
      expect(seen).toEqual([1_000, 2_000]);
      expect(monitor.latest().capturedAtUnixMs).toBe(2_000);
    } finally {
      clearTimeout(timeout);
      removeSecond();
      unsubscribe();
      monitor.stop();
    }
  });

  test('requires a real audio-input owner; calendar alone never starts recording', () => {
    const snapshot = parseMeetingSignalSnapshot({
      schemaVersion: 1,
      capturedAtUnixMs: 1_000,
      supported: true,
      inputProcesses: [],
    });
    expect(resolveMeetingCandidate(snapshot, calendar)).toBeUndefined();
  });

  test('calendar-backed browser audio is automatic and carries the roster', () => {
    const snapshot = parseMeetingSignalSnapshot({
      schemaVersion: 1,
      capturedAtUnixMs: 1_000,
      supported: true,
      frontmostBundleId: 'com.google.Chrome',
      inputProcesses: [{
        pid: 7,
        bundleId: 'com.google.Chrome.helper.renderer',
        name: 'Google Chrome Helper',
      }],
    });
    expect(resolveMeetingCandidate(snapshot, calendar)).toEqual({
      id: 'audio:chrome',
      appName: 'Google Chrome',
      bundleId: 'com.google.Chrome.helper.renderer',
      pid: 7,
      kind: 'browser',
      title: 'Blueprint review',
      calendar,
      evidence: ['audio-input-process', 'calendar', 'frontmost'],
      requiresConsent: false,
    });
  });

  test('browser audio without calendar asks by default', () => {
    const snapshot = parseMeetingSignalSnapshot({
      schemaVersion: 1,
      capturedAtUnixMs: 1_000,
      supported: true,
      inputProcesses: [{ pid: 8, bundleId: 'com.apple.Safari', name: 'Safari' }],
    });
    expect(resolveMeetingCandidate(snapshot)?.requiresConsent).toBe(true);
  });
});

describe('automatic meeting controller', () => {
  test('confirms, records, tolerates a dropout, then finishes', () => {
    const controller = new MeetingAutomationController({
      confirmationPolls: 2,
      endGraceSeconds: 10,
      cooldownSeconds: 5,
    });
    expect(controller.step(zoom, 0)).toEqual({ kind: 'none' });
    expect(controller.state.phase).toBe('confirming');
    expect(controller.step(zoom, 3_000)).toEqual({ kind: 'start', candidate: zoom });
    expect(controller.step(undefined, 4_000)).toEqual({ kind: 'none' });
    expect(controller.state.phase).toBe('ending');
    expect(controller.step(zoom, 8_000)).toEqual({ kind: 'none' });
    expect(controller.state.phase).toBe('recording');
    expect(controller.step(undefined, 9_000)).toEqual({ kind: 'none' });
    expect(controller.step(undefined, 19_000)).toEqual({
      kind: 'finish',
      candidate: zoom,
      reason: 'signal-ended',
    });
    // No cooldown: the watcher resumes a returning call into the same entry.
    expect(controller.state.phase).toBe('watching');
    expect(controller.step(zoom, 20_000).kind).toBe('none');
    expect(controller.step(zoom, 23_000).kind).toBe('start');
  });

  test('parks consent without blocking polling and can be approved', () => {
    const browser = { ...zoom, id: 'audio:chrome', kind: 'browser' as const, requiresConsent: true };
    const controller = new MeetingAutomationController({ confirmationPolls: 1 });
    expect(controller.step(browser, 100)).toEqual({ kind: 'suggest', candidate: browser });
    expect(controller.step(browser, 200)).toEqual({ kind: 'none' });
    expect(controller.approve(300)).toEqual(browser);
    expect(controller.state.phase).toBe('recording');
  });

  test('maximum duration always ends a stuck signal', () => {
    const controller = new MeetingAutomationController({ confirmationPolls: 1, maxDurationMinutes: 1 });
    expect(controller.step(zoom, 0).kind).toBe('start');
    expect(controller.step(zoom, 60_000)).toEqual({
      kind: 'finish',
      candidate: zoom,
      reason: 'maximum-duration',
    });
  });
});

// Page state, unlike microphone ownership, identifies muted and back-to-back calls.
import { hasConfirmedMeetingEnd } from '../src/meeting-automation.ts';
import type { MeetProbe } from '../src/meet-speakers.ts';
const joined = (meeting = '/abc-defg-hij', browser: 'chrome' | 'safari' = 'chrome'): MeetProbe => ({
  state: 'connected', detail: 'Joined', browser,
  snapshot: { meeting, joined: true, participants: [] },
});
const silent = { schemaVersion: 1 as const, capturedAtUnixMs: 0, supported: true, inputProcesses: [] };

test('joined Meet records while muted and distinguishes calls and browsers', () => {
  const first = resolveMeetingCandidate(silent, undefined, {}, joined())!;
  expect(first.requiresConsent).toBe(false);
  expect(first.evidence).toContain('joined-meet');
  expect(resolveMeetingCandidate(silent, undefined, { mode: 'ask' }, joined())?.requiresConsent).toBe(true);
  expect(resolveMeetingCandidate(silent, undefined, { mode: 'off' }, joined())).toBeUndefined();
  expect(resolveMeetingCandidate(silent, calendar, {}, joined())?.calendar).toBeUndefined();
  expect(hasConfirmedMeetingEnd(first, joined())).toBe(false);
  expect(hasConfirmedMeetingEnd(first, joined('/klm-nopq-rst'))).toBe(true);
  expect(hasConfirmedMeetingEnd(first, joined('/abc-defg-hij', 'safari'))).toBe(true);
  expect(hasConfirmedMeetingEnd(first, { state: 'idle', detail: 'Left' })).toBe(true);
  expect(hasConfirmedMeetingEnd(first, { state: 'permission', detail: 'Blocked' })).toBe(false);
  expect(hasConfirmedMeetingEnd(first, { state: 'idle', detail: 'Hidden', source: 'google-meet-accessibility' })).toBe(false);
  expect(hasConfirmedMeetingEnd(first, { state: 'idle', detail: 'Hidden', source: 'google-meet-accessibility', absenceConfirmed: false })).toBe(false);
  expect(hasConfirmedMeetingEnd(first, { state: 'idle', detail: 'Left', source: 'google-meet-accessibility', absenceConfirmed: true })).toBe(true);
});

test('connected Meet reader never automatically captures a prejoin microphone preview', () => {
  const snapshot = { ...silent, inputProcesses: [{ pid: 1, bundleId: 'com.google.Chrome', name: 'Chrome' }] };
  const candidate = resolveMeetingCandidate(snapshot, calendar, {}, { state: 'idle', detail: 'Not joined' });
  expect(candidate?.requiresConsent).toBe(true);
});

test('confirmed departure finishes immediately and permits an immediate rejoin', () => {
  const call = resolveMeetingCandidate(silent, undefined, {}, joined())!;
  const controller = new MeetingAutomationController({ confirmationPolls: 1 });
  expect(controller.step(call, 0).kind).toBe('start');
  expect(controller.step(undefined, 1_000, true).kind).toBe('finish');
  expect(controller.step(call, 2_000).kind).toBe('start');
});

test('cooldown suppresses a declined call but not a different meeting', () => {
  const controller = new MeetingAutomationController({ confirmationPolls: 1 });
  const first = resolveMeetingCandidate(silent, undefined, { mode: 'ask' }, joined())!;
  const next = resolveMeetingCandidate(silent, undefined, {}, joined('/klm-nopq-rst'))!;
  expect(controller.step(first, 0).kind).toBe('suggest');
  controller.decline(0);
  expect(controller.step(first, 1_000).kind).toBe('none');
  expect(controller.step(next, 2_000).kind).toBe('start');
});

test('pending consent for a departed meeting cannot start that old meeting', () => {
  const controller = new MeetingAutomationController({ confirmationPolls: 1 });
  const first = resolveMeetingCandidate(silent, undefined, { mode: 'ask' }, joined())!;
  const next = resolveMeetingCandidate(silent, undefined, {}, joined('/klm-nopq-rst'))!;
  controller.step(first, 0);
  controller.step(next, 1_000);
  expect(controller.approve()).toBeUndefined();
  expect(controller.step(next, 2_000).kind).toBe('start');
});

test('unreadable Meet preserves only an already recording call with matching browser audio', () => {
  const snapshot = { ...silent, inputProcesses: [{ pid: 7, bundleId: 'com.google.Chrome', name: 'Chrome' }] };
  const call = resolveMeetingCandidate(snapshot, undefined, {}, joined())!;
  const gap: MeetProbe = { state: 'unavailable', detail: 'Meet tab is not readable' };
  const audio = resolveMeetingCandidate(snapshot, undefined, {}, gap);
  const controller = new MeetingAutomationController({ confirmationPolls: 1, endGraceSeconds: 1, maxDurationMinutes: 1 });
  expect(preserveMeetingCandidateDuringObservationGap(audio, controller.state, snapshot, gap)).toBe(audio);
  controller.step(call, 0);
  for (const now of [1_000, 10_000, 59_000]) {
    const candidate = preserveMeetingCandidateDuringObservationGap(audio, controller.state, snapshot, gap);
    expect(candidate?.id).toBe(call.id);
    expect(controller.step(candidate, now).kind).toBe('none');
    expect(controller.state.phase).toBe('recording');
  }
  // Sustained input cannot bypass the maximum duration bound.
  expect(controller.step(preserveMeetingCandidateDuringObservationGap(audio, controller.state, snapshot, gap), 60_000).kind).toBe('finish');
});

test('observation-gap continuity never overrides ambiguity, another room, or absent browser audio', () => {
  const snapshot = { ...silent, inputProcesses: [{ pid: 7, bundleId: 'com.google.Chrome', name: 'Chrome' }] };
  const controller = new MeetingAutomationController({ confirmationPolls: 1 });
  controller.step(resolveMeetingCandidate(snapshot, undefined, {}, joined()), 0);
  for (const probe of [
    { state: 'ambiguous', detail: 'Multiple calls' },
    { state: 'idle', detail: 'Left' },
    joined('/klm-nopq-rst'),
  ] as MeetProbe[]) {
    const candidate = resolveMeetingCandidate(snapshot, undefined, {}, probe);
    expect(preserveMeetingCandidateDuringObservationGap(candidate, controller.state, snapshot, probe)).toBe(candidate);
  }
  for (const probe of [
    { state: 'permission', detail: 'Revoked' },
    { state: 'idle', detail: 'Hidden tab', source: 'google-meet-accessibility', absenceConfirmed: false },
  ] as MeetProbe[]) {
    const candidate = resolveMeetingCandidate(snapshot, undefined, {}, probe);
    expect(preserveMeetingCandidateDuringObservationGap(candidate, controller.state, snapshot, probe)?.id).toBe(controller.state.candidate?.id);
  }
  const gap: MeetProbe = { state: 'unavailable', detail: 'Hidden' };
  for (const missing of [silent, { ...snapshot, supported: false },
    { ...snapshot, inputProcesses: [{ pid: 8, bundleId: 'com.apple.Safari', name: 'Safari' }] }]) {
    const candidate = resolveMeetingCandidate(missing, undefined, {}, gap);
    expect(preserveMeetingCandidateDuringObservationGap(candidate, controller.state, missing, gap)).toBe(candidate);
  }
});

// Regression: Oct 1 2026 Safari Meet calls split into 11 entries. Safari's
// microphone belongs to com.apple.WebKit.GPU, never com.apple.Safari.
test('Safari Meet survives unreadable Accessibility while WebKit owns the microphone', () => {
  const webkit = { ...silent, inputProcesses: [{ pid: 1594, bundleId: 'com.apple.WebKit.GPU', name: 'Safari Graphics and Media' }] };
  const call = resolveMeetingCandidate(webkit, undefined, {}, joined('/abc-defg-hij', 'safari'))!;
  expect(call.pid).toBe(1594);
  const controller = new MeetingAutomationController({ confirmationPolls: 1, endGraceSeconds: 20 });
  expect(controller.step(call, 0).kind).toBe('start');
  for (const gap of [
    { state: 'unavailable', detail: 'A browser window does not expose its page through Accessibility.' },
    { state: 'unavailable', detail: 'Browser Accessibility inspection was incomplete.' },
    { state: 'idle', detail: 'No visible Google Meet call found.', source: 'google-meet-accessibility', absenceConfirmed: false },
  ] as MeetProbe[]) {
    for (let now = 3_000; now <= 60_000; now += 3_000) {
      const candidate = preserveMeetingCandidateDuringObservationGap(
        resolveMeetingCandidate(webkit, undefined, {}, gap), controller.state, webkit, gap);
      expect(candidate?.id).toBe(call.id);
      expect(controller.step(candidate, now, hasConfirmedMeetingEnd(call, gap)).kind).toBe('none');
    }
  }
  expect(controller.state.phase).toBe('recording');
});

test('a just-ended call is held for resume only by its own browser audio', () => {
  const webkit = { ...silent, inputProcesses: [{ pid: 1594, bundleId: 'com.apple.WebKit.GPU', name: 'Safari Graphics and Media' }] };
  const chrome = { ...silent, inputProcesses: [{ pid: 7, bundleId: 'com.google.Chrome.helper', name: 'Chrome Helper' }] };
  const held = resolveMeetingCandidate(webkit, undefined, {}, joined('/abc-defg-hij', 'safari'))!;
  const watching = new MeetingAutomationController().state;
  const gap: MeetProbe = { state: 'unavailable', detail: 'Hidden' };
  const audio = resolveMeetingCandidate(webkit, undefined, {}, gap);
  expect(audio?.id).toBe('audio:safari');
  expect(preserveMeetingCandidateDuringObservationGap(audio, watching, webkit, gap, held)?.id).toBe(held.id);
  expect(preserveMeetingCandidateDuringObservationGap(audio, watching, webkit, gap)).toBe(audio);
  const other = resolveMeetingCandidate(chrome, undefined, {}, gap);
  expect(preserveMeetingCandidateDuringObservationGap(other, watching, chrome, gap, held)).toBe(other);
  const left: MeetProbe = { state: 'idle', detail: 'Left', source: 'google-meet-accessibility', absenceConfirmed: true };
  expect(preserveMeetingCandidateDuringObservationGap(undefined, watching, webkit, left, held)).toBeUndefined();
});
