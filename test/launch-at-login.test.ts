import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { spawnSync } from 'child_process';
import {
  disableMeetingLaunchAtLogin,
  enableMeetingLaunchAtLogin,
  meetingLaunchAtLoginStatus,
} from '../src/launch-at-login.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('launch-at-login writes one exact private user agent and can remove it', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-launch-agent-'));
  roots.push(root);
  const project = join(root, 'project');
  const agents = join(root, 'agents');
  mkdirSync(project);
  writeFileSync(join(project, 'seashell'), '#!/bin/bash\n');
  const calls: string[][] = [];
  let isLoaded = false;
  const runner = ((command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    if (args[0] === 'bootstrap') isLoaded = true;
    if (args[0] === 'bootout') isLoaded = false;
    return { status: args[0] === 'print' ? (isLoaded ? 0 : 1) : 0, stderr: '' };
  }) as unknown as typeof spawnSync;
  const options = { launchAgentsDir: agents, projectRoot: project, uid: 123, runner };

  const enabled = enableMeetingLaunchAtLogin(options);
  expect(enabled.enabled).toBe(true);
  expect(enabled.loaded).toBe(true);
  const contents = readFileSync(enabled.plistPath, 'utf8');
  expect(contents).toContain(join(project, 'seashell'));
  expect(contents).toContain('<string>watch</string>');
  expect(contents).not.toContain('API_KEY');
  expect(calls.some((call) => call[1] === 'bootstrap')).toBe(true);

  const disabled = disableMeetingLaunchAtLogin(options);
  expect(disabled.enabled).toBe(false);
  expect(disabled.loaded).toBe(false);
  expect(meetingLaunchAtLoginStatus(options).enabled).toBe(false);
});
