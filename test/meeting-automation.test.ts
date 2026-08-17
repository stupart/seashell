import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MeetingSignalMonitor,
  MeetingAutomationController,
  parseMeetingSignalSnapshot,
  resolveMeetingCandidate,
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
  test('one persistent helper streams multiple snapshots without being respawned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-signal-monitor-'));
    temporaryRoots.push(root);
    const helper = join(root, 'signal-helper');
    writeFileSync(helper, `#!/bin/sh
printf '%s\\n' '{"schemaVersion":1,"capturedAtUnixMs":1000,"supported":true,"inputProcesses":[]}'
sleep 0.05
printf '%s\\n' '{"schemaVersion":1,"capturedAtUnixMs":2000,"supported":true,"inputProcesses":[]}'
sleep 0.05
`, { mode: 0o700 });
    chmodSync(helper, 0o700);
    const monitor = new MeetingSignalMonitor(helper, 250);
    const seen: number[] = [];
    const unsubscribe = monitor.subscribe((snapshot) => seen.push(snapshot.capturedAtUnixMs));
    const secondSnapshot = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('second streamed snapshot timed out')), 1_000);
      const remove = monitor.subscribe((snapshot) => {
        if (snapshot.capturedAtUnixMs !== 2_000) return;
        clearTimeout(timeout);
        remove();
        resolve();
      });
    });
    expect((await monitor.waitForSnapshot(1_000)).capturedAtUnixMs).toBe(1_000);
    await secondSnapshot;
    expect(seen).toEqual([1_000, 2_000]);
    expect(monitor.latest().capturedAtUnixMs).toBe(2_000);
    unsubscribe();
    monitor.stop();
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
    expect(controller.state.phase).toBe('cooldown');
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
