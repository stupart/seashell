import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeFirstInstall } from '../src/first-install.ts';
import type { LaunchAtLoginStatus } from '../src/launch-at-login.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const launchStatus: LaunchAtLoginStatus = {
  enabled: true,
  loaded: true,
  label: 'com.humain.seashell.meeting-watch',
  plistPath: '/tmp/agent.plist',
  command: ['/tmp/seashell', 'meeting', 'watch', '--json'],
};

test('first install seeds local automatic defaults and enables login launch', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-first-install-'));
  roots.push(root);
  const configPath = join(root, 'support', 'config.json');
  let enableCalls = 0;
  const result = initializeFirstInstall({
    configPath,
    enableLaunch: () => {
      enableCalls += 1;
      return launchStatus;
    },
  });

  expect(result.initialized).toBe(true);
  expect(result.launchAtLogin).toBe('enabled');
  expect(enableCalls).toBe(1);
  expect(result.config.meeting).toMatchObject({
    calendar: { enabled: true, policy: 'ask' },
    automation: {
      enabled: true,
      mode: 'automatic',
      browserWithoutCalendar: 'ask',
      launchAtLogin: true,
    },
  });
  expect(result.config.meeting?.backend).toBeUndefined();
  expect(result.config.transcription).toBeUndefined();
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
});

test('reinstall preserves the config byte-for-byte and does not re-enable autostart', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-first-install-preserve-'));
  roots.push(root);
  const configPath = join(root, 'config.json');
  const original = JSON.stringify({
    saveByDefault: false,
    meeting: { automation: { enabled: false, launchAtLogin: false } },
  }, null, 2);
  writeFileSync(configPath, original, { mode: 0o600 });
  let enableCalls = 0;
  const result = initializeFirstInstall({
    configPath,
    enableLaunch: () => {
      enableCalls += 1;
      return launchStatus;
    },
  });

  expect(result.initialized).toBe(false);
  expect(result.launchAtLogin).toBe('preserved');
  expect(enableCalls).toBe(0);
  expect(readFileSync(configPath, 'utf8')).toBe(original);
});

test('first install supports an explicit no-autostart policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-first-install-manual-'));
  roots.push(root);
  const result = initializeFirstInstall({
    configPath: join(root, 'config.json'),
    enableAutostart: false,
  });
  expect(result.launchAtLogin).toBe('disabled');
  expect(result.config.meeting?.automation?.launchAtLogin).toBe(false);
});
