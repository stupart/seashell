import { expect, test } from 'bun:test';
import {
  hasConfirmedMeetingEnd,
  MeetingAutomationController,
  resolveMeetingCandidate,
  type MeetingSignalSnapshot,
} from '../src/meeting-automation.ts';
import type { MeetProbe } from '../src/meet-speakers.ts';

const noMicrophone: MeetingSignalSnapshot = {
  schemaVersion: 1, capturedAtUnixMs: 0, supported: false, inputProcesses: [],
};
const partial = (meeting = '/abc-defg-hij', browser: 'chrome' | 'safari' = 'chrome'): MeetProbe => ({
  state: 'unavailable', browser, source: 'google-meet-accessibility', accessibilityTrusted: true,
  detail: 'Joined call confirmed; another browser window is unreadable, so speaker names are unavailable.',
  snapshot: { meeting, joined: true, participants: [] },
});

test('one positively observed call can start muted and continue through unrelated read gaps', () => {
  const probe = partial();
  const candidate = resolveMeetingCandidate(noMicrophone, undefined, {}, probe)!;
  expect(candidate.id).toBe('meet:chrome:/abc-defg-hij');
  expect(candidate.requiresConsent).toBe(false);
  const controller = new MeetingAutomationController({ confirmationPolls: 2, endGraceSeconds: 5 });
  expect(controller.step(candidate, 0).kind).toBe('none');
  expect(controller.step(candidate, 3000).kind).toBe('start');
  expect(hasConfirmedMeetingEnd(candidate, probe)).toBe(false);
  expect(controller.step(candidate, 60_000, hasConfirmedMeetingEnd(candidate, probe)).kind).toBe('none');
  expect(controller.state.phase).toBe('recording');
  expect(controller.state.missingSinceUnixMs).toBeUndefined();
});

for (const changed of ['room', 'browser'] as const) test(`a partial different ${changed} does not prove the prior call ended`, () => {
  const first = resolveMeetingCandidate(noMicrophone, undefined, {}, partial())!;
  const observed = changed === 'room' ? partial('/klm-nopq-rst') : partial('/abc-defg-hij', 'safari');
  const next = resolveMeetingCandidate(noMicrophone, undefined, {}, observed)!;
  const controller = new MeetingAutomationController({ confirmationPolls: 1, endGraceSeconds: 5 });
  expect(controller.step(first, 0).kind).toBe('start');
  expect(hasConfirmedMeetingEnd(first, observed)).toBe(false);
  expect(controller.step(next, 1000, hasConfirmedMeetingEnd(first, observed)).kind).toBe('none');
  expect(controller.state.phase).toBe('ending');
  expect(controller.state.candidate?.id).toBe(first.id);
  expect(controller.step(next, 5999, hasConfirmedMeetingEnd(first, observed)).kind).toBe('none');
  expect(controller.step(next, 6000, hasConfirmedMeetingEnd(first, observed))).toMatchObject({
    kind: 'finish', candidate: { id: first.id }, reason: 'signal-ended',
  });
  // A fully inspected replacement still provides the immediate boundary.
  expect(hasConfirmedMeetingEnd(first, { ...observed, state: 'connected' })).toBe(true);
});

test('a transient partial replacement does not split a call that becomes visible again', () => {
  const first = resolveMeetingCandidate(noMicrophone, undefined, {}, partial())!;
  const other = partial('/klm-nopq-rst');
  const controller = new MeetingAutomationController({ confirmationPolls: 1, endGraceSeconds: 5 });
  controller.step(first, 0);
  expect(controller.step(resolveMeetingCandidate(noMicrophone, undefined, {}, other), 1000,
    hasConfirmedMeetingEnd(first, other)).kind).toBe('none');
  expect(controller.step(first, 4000, hasConfirmedMeetingEnd(first, partial())).kind).toBe('none');
  expect(controller.state.phase).toBe('recording');
  expect(controller.state.recordingStartedAtUnixMs).toBe(0);
});

test('positive partial evidence still honors ask, off and disabled policies', () => {
  const asked = resolveMeetingCandidate(noMicrophone, undefined, { mode: 'ask' }, partial())!;
  expect(asked.requiresConsent).toBe(true);
  const controller = new MeetingAutomationController({ mode: 'ask', confirmationPolls: 2 });
  expect(controller.step(asked, 0).kind).toBe('none');
  expect(controller.step(asked, 3000).kind).toBe('suggest');
  expect(controller.state.phase).toBe('awaiting-consent');
  expect(resolveMeetingCandidate(noMicrophone, undefined, { mode: 'off' }, partial())).toBeUndefined();
  expect(resolveMeetingCandidate(noMicrophone, undefined, { enabled: false }, partial())).toBeUndefined();
});

test('unreadable, permission-denied and prejoin evidence without a positive call cannot auto-start', () => {
  for (const probe of [
    { state: 'unavailable', detail: 'Unreadable page' },
    { state: 'permission', detail: 'Accessibility permission missing', accessibilityTrusted: false },
    { state: 'idle', detail: 'Join screen', absenceConfirmed: true },
    { state: 'ambiguous', detail: 'Two joined calls' },
  ] satisfies MeetProbe[]) {
    expect(resolveMeetingCandidate(noMicrophone, undefined, {}, probe)).toBeUndefined();
  }
});
