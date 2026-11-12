import { expect, test } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { meetingRuntimeHostPath, microphoneRuntimeHelperPath } from '../src/runtime-host.ts';
import { recordingStatePath } from '../src/background-watch-status.ts';

test('tests never touch the installed runtime helpers', () => {
  const installed = join(homedir(), 'Library', 'Application Support', 'Sea Shell', 'Runtime');
  expect(process.env.SEASHELL_RUNTIME_DIR).toBeTruthy();
  expect(microphoneRuntimeHelperPath().startsWith(installed)).toBe(false);
  expect(meetingRuntimeHostPath().startsWith(installed)).toBe(false);
  expect(microphoneRuntimeHelperPath()).toBe(join(process.env.SEASHELL_RUNTIME_DIR!, 'Seashell Microphone'));
});

test('tests never reach the login Keychain', () => {
  // Automation approval keys would otherwise be read from, or added to, the real one.
  expect(process.env.SEASHELL_APPROVAL_KEYCHAIN).toBe('off');
});

test('tests never publish a recording state other tools on this Mac act on', () => {
  const published = join(homedir(), 'Library', 'Caches', 'seashell', 'background-watch.json');
  expect(recordingStatePath({})).toBe(published);
  expect(recordingStatePath()).not.toBe(published);
  expect(recordingStatePath()).toBe(process.env.SEASHELL_RECORDING_STATE_PATH!);
});
