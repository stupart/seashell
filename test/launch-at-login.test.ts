import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { spawnSync } from 'child_process';
import { meetingRuntimeHostPath, type RuntimeHostOptions } from '../src/runtime-host.ts';
import {
  disableMeetingLaunchAtLogin,
  enableMeetingLaunchAtLogin,
  meetingLaunchAtLoginStatus,
} from '../src/launch-at-login.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeHost(root: string): RuntimeHostOptions {
  const source = join(root, 'packaged-bun');
  writeFileSync(source, 'signed runtime fixture', { mode: 0o700 });
  return { hostDirectory: join(root, 'Runtime'), runtimeSource: source, platform: 'darwin',
    runner: (() => ({ status: 0, stdout: '', stderr: 'Identifier=bun\nAuthority=Developer ID Application: Bun\nTeamIdentifier=EXAMPLE123\n' })) as unknown as typeof spawnSync,
  };
}

test('packaged watchers keep the stable opt path across Homebrew upgrades', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-packaged-launch-'));
  roots.push(root);
  const stableRoot = join(root, 'opt', 'seashell', 'libexec');
  mkdirSync(stableRoot, { recursive: true });
  mkdirSync(join(stableRoot, 'src'));
  writeFileSync(join(stableRoot, 'src', 'cli.tsx'), '// test entrypoint');
  const host = runtimeHost(root);
  const runner = ((_command: string, args: string[]) => ({ status: args[0] === 'print' ? 1 : 0, stderr: '' })) as unknown as typeof spawnSync;
  const result = enableMeetingLaunchAtLogin({ launchAgentsDir: join(root, 'agents'), logsDir: join(root, 'logs'), runner, runtimeHost: host,
    environment: { PATH: '/usr/bin', SEASHELL_PACKAGE_ROOT: stableRoot, SEASHELL_MANAGED_BY: 'homebrew' },
  });
  const plist = readFileSync(result.plistPath, 'utf8');
  expect(result.command).toEqual([meetingRuntimeHostPath(host), 'run', join(stableRoot, 'src', 'cli.tsx'), 'meeting', 'watch', '--json']);
  expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${stableRoot}</string>`);
  expect(plist).toContain('<key>SEASHELL_PACKAGE_ROOT</key>');
  expect(plist).toContain('<key>SEASHELL_MANAGED_BY</key>');
});

test('launch-at-login writes one exact private user agent and can remove it', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-launch-agent-'));
  roots.push(root);
  const project = join(root, 'project');
  const agents = join(root, 'agents');
  mkdirSync(project);
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'cli.tsx'), '// test entrypoint');
  const calls: string[][] = [];
  let isLoaded = false;
  const runner = ((command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    if (args[0] === 'bootstrap') isLoaded = true;
    if (args[0] === 'bootout') isLoaded = false;
    return { status: args[0] === 'print' ? (isLoaded ? 0 : 1) : 0, stderr: '' };
  }) as unknown as typeof spawnSync;
  const logsDir = join(root, 'logs');
  const host = runtimeHost(root);
  const options = { launchAgentsDir: agents, projectRoot: project, uid: 123, runner, logsDir, runtimeHost: host,
    environment: { PATH: '/custom/node/bin', SEASHELL_CONFIG: '/custom/config.json', HUMAIN_CLI: '/custom/dist/cli.js', API_KEY: 'never-forward-this' },
  };

  const enabled = enableMeetingLaunchAtLogin(options);
  expect(enabled.enabled).toBe(true);
  expect(enabled.loaded).toBe(true);
  const contents = readFileSync(enabled.plistPath, 'utf8');
  expect(contents).toContain(meetingRuntimeHostPath(host));
  expect(contents).toContain(join(project, 'src', 'cli.tsx'));
  expect(contents).toContain('<string>watch</string>');
  expect(contents).not.toContain('API_KEY');
  expect(contents).not.toContain('never-forward-this');
  expect(contents).toContain('/custom/node/bin');
  expect(contents).toContain('/custom/config.json');
  expect(contents).toContain('/custom/dist/cli.js');
  expect(statSync(join(logsDir, 'meeting-watch.jsonl')).mode & 0o777).toBe(0o600);
  expect(statSync(join(logsDir, 'meeting-watch.error.log')).mode & 0o777).toBe(0o600);
  expect(calls.some((call) => call[1] === 'bootstrap')).toBe(true);

  const disabled = disableMeetingLaunchAtLogin(options);
  expect(disabled.enabled).toBe(false);
  expect(disabled.loaded).toBe(false);
  expect(meetingLaunchAtLoginStatus(options).enabled).toBe(false);
});

test('failed migration shutdown preserves the previous registered command', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-launch-migration-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'cli.tsx'), '// fixture');
  const agents = join(root, 'agents');
  mkdirSync(agents);
  const plist = join(agents, 'com.humain.seashell.meeting-watch.plist');
  writeFileSync(plist, 'previous legacy registration');
  const calls: string[][] = [];
  const runner = ((_command: string, args: string[]) => {
    calls.push(args);
    return { status: args[0] === 'print' ? 0 : 1, stderr: 'operation denied' };
  }) as unknown as typeof spawnSync;
  expect(() => enableMeetingLaunchAtLogin({ launchAgentsDir: agents, projectRoot: project,
    logsDir: join(root, 'logs'), runtimeHost: runtimeHost(root), runner, uid: 123,
  })).toThrow('Could not stop the previous meeting watcher');
  expect(readFileSync(plist, 'utf8')).toBe('previous legacy registration');
  expect(calls.some(args => args[0] === 'bootstrap')).toBe(false);
  expect(calls.find(args => args[0] === 'bootout')).toEqual(['bootout', 'gui/123/com.humain.seashell.meeting-watch']);
});

test('status never installs the background host', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-launch-status-'));
  roots.push(root);
  const host = runtimeHost(root);
  const runner = (() => ({ status: 1 })) as unknown as typeof spawnSync;
  const status = meetingLaunchAtLoginStatus({ launchAgentsDir: join(root, 'agents'), runtimeHost: host, runner });
  expect(status.command[0]).toBe(meetingRuntimeHostPath(host));
  expect(existsSync(host.hostDirectory!)).toBe(false);
});

test('failed watcher shutdown is reported and preserves its login registration', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-launch-failure-'));
  roots.push(root);
  const plistPath = join(root, 'com.humain.seashell.meeting-watch.plist');
  writeFileSync(plistPath, 'existing registration');
  const runner = ((_command: string, args: string[]) => ({
    status: args[0] === 'print' ? 0 : 1, stderr: 'operation denied',
  })) as unknown as typeof spawnSync;
  expect(() => disableMeetingLaunchAtLogin({ launchAgentsDir: root, runner }))
    .toThrow('Could not stop');
  expect(existsSync(plistPath)).toBe(true);
});
