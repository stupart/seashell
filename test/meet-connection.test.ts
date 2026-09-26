import { expect, test } from 'bun:test';
import { checkMeetConnection, requestMeetAccessibilityPermission, type MeetProbe, type MeetAccessibilityOptions } from '../src/meet-speakers.ts';
import type { BackgroundAccessibilityProbe } from '../src/meeting-accessibility-permission.ts';

test('connection setup checks both permission owners without prompts during checks or after cancellation', async () => {
  let foreground: MeetProbe = { state: 'idle', detail: 'Join a call', accessibilityTrusted: true };
  let background: BackgroundAccessibilityProbe = { state: 'permission', detail: 'Background host needs access', accessibilityTrusted: false };
  let abortDuringForeground: AbortController | undefined;
  const calls: string[] = [];
  const runtime = {
    async read(_mode: unknown, _signal?: AbortSignal, options?: MeetAccessibilityOptions): Promise<MeetProbe> {
      calls.push(options?.requestPermission ? 'request-foreground' : 'check-foreground');
      abortDuringForeground?.abort();
      return foreground;
    },
    async background(options: { requestPermission?: boolean }): Promise<BackgroundAccessibilityProbe> {
      calls.push(options.requestPermission ? 'request-background' : 'check-background');
      return background;
    },
    async openSettings() { calls.push('open-settings'); },
  };
  expect((await checkMeetConnection('auto', undefined, runtime)).state).toBe('permission');
  expect(calls.splice(0)).toEqual(['check-foreground', 'check-background']);
  expect((await requestMeetAccessibilityPermission(undefined, runtime)).detail).toContain('Background');
  expect(calls.splice(0)).toEqual(['request-foreground', 'request-background', 'open-settings']);

  background = { state: 'idle', detail: 'Enabled', accessibilityTrusted: true };
  foreground = { state: 'permission', detail: 'Terminal needs access', accessibilityTrusted: false };
  expect((await requestMeetAccessibilityPermission(undefined, runtime)).state).toBe('permission');
  expect(calls.splice(0)).toEqual(['request-foreground', 'request-background', 'open-settings']);
  expect((await checkMeetConnection('auto', undefined, runtime)).state).toBe('permission');
  expect(calls.splice(0)).toEqual(['check-foreground']);

  // Permission setup is independent of whether the current page is supported.
  foreground = { state: 'unavailable', detail: 'Unsupported layout', accessibilityTrusted: true };
  await requestMeetAccessibilityPermission(undefined, runtime);
  expect(calls.splice(0)).toEqual(['request-foreground', 'request-background']);
  foreground = { state: 'idle', detail: 'No current call', accessibilityTrusted: true };
  expect((await requestMeetAccessibilityPermission(undefined, runtime)).detail).toContain('this window and background');
  expect(calls.splice(0)).toEqual(['request-foreground', 'request-background']);

  foreground = { state: 'unavailable', detail: 'Missing helper' };
  await requestMeetAccessibilityPermission(undefined, runtime);
  await checkMeetConnection('auto', undefined, runtime);
  expect(calls.splice(0)).toEqual(['request-foreground', 'check-foreground']);

  foreground = { state: 'idle', detail: 'No current call', accessibilityTrusted: true };
  const controller = new AbortController();
  abortDuringForeground = controller;
  await requestMeetAccessibilityPermission(controller.signal, runtime);
  expect(calls.splice(0)).toEqual(['request-foreground']);
});
