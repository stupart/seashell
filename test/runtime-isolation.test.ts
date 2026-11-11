import { expect, test } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { meetingRuntimeHostPath, microphoneRuntimeHelperPath } from '../src/runtime-host.ts';

test('tests never touch the installed runtime helpers', () => {
  const installed = join(homedir(), 'Library', 'Application Support', 'Sea Shell', 'Runtime');
  expect(process.env.SEASHELL_RUNTIME_DIR).toBeTruthy();
  expect(microphoneRuntimeHelperPath().startsWith(installed)).toBe(false);
  expect(meetingRuntimeHostPath().startsWith(installed)).toBe(false);
  expect(microphoneRuntimeHelperPath()).toBe(join(process.env.SEASHELL_RUNTIME_DIR!, 'Seashell Microphone'));
});
