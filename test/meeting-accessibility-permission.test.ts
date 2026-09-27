import { afterEach, describe, expect, test } from 'bun:test';
import type { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { probeBackgroundMeetingAccessibility } from '../src/meeting-accessibility-permission.ts';
import { meetingRuntimeHostPath, type RuntimeHostOptions } from '../src/runtime-host.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function host() {
  const root = mkdtempSync(join(tmpdir(), 'seashell-permission-host-'));
  roots.push(root);
  const source = join(root, 'source-bun');
  writeFileSync(source, 'signed runtime fixture', { mode: 0o700 });
  const options: RuntimeHostOptions = { hostDirectory: join(root, 'Runtime'), runtimeSource: source, platform: 'darwin',
    runner: (() => ({ status: 0, stdout: '', stderr: 'Identifier=bun\nAuthority=Developer ID Application: Bun\nTeamIdentifier=EXAMPLE123\n' })) as unknown as typeof spawnSync,
  };
  return options;
}

function harness(receipt: unknown = { state: 'permission', accessibilityTrusted: false }) {
  const calls: string[][] = [];
  let plist = '', directory = '';
  return {
    calls,
    get plist() { return plist; },
    get directory() { return directory; },
    runtime: {
      platform: 'darwin', uid: 1234, waitMs: 70,
      launchctl: async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'bootstrap') {
          directory = dirname(args[2]!);
          plist = readFileSync(args[2]!, 'utf8');
          expect(statSync(directory).mode & 0o777).toBe(0o700);
          expect(statSync(args[2]!).mode & 0o777).toBe(0o600);
          expect(statSync(join(directory, 'probe.mjs')).mode & 0o777).toBe(0o600);
          if (receipt !== undefined) writeFileSync(join(directory, 'result.json'), JSON.stringify(receipt));
        }
      },
    },
  };
}

describe('background Accessibility permission', () => {
  test('uses the background Bun chain and checks silently by default', async () => {
    const h = harness();
    const result = await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper', bunPath: '/app/bun' }, h.runtime);
    expect(result).toMatchObject({ state: 'permission', accessibilityTrusted: false });
    expect(h.plist).toContain('<string>/app/bun</string>');
    expect(h.plist).toContain('<string>/app/helper</string>');
    expect(h.plist).toContain('--check-permission');
    expect(h.plist).not.toContain('--request-permission');
    expect(h.plist).toContain('<key>KeepAlive</key><false/>');
    expect(h.calls[1]![0]).toBe('bootout');
    expect(h.calls[1]![1]).toMatch(/^gui\/1234\/com\.humain\.seashell\.accessibility-check\.[\da-f-]+$/u);
    expect(h.calls.flat().join(' ')).not.toContain('com.humain.seashell.meeting-watch');
    expect(existsSync(h.directory)).toBe(false);
  });
  test('only explicit setup requests the OS prompt', async () => {
    const h = harness({ state: 'idle', accessibilityTrusted: true });
    const runtimeHost = host();
    const result = await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper', requestPermission: true, runtimeHost }, h.runtime);
    expect(result).toMatchObject({ state: 'idle', accessibilityTrusted: true });
    expect(h.plist).toContain(`<string>${meetingRuntimeHostPath(runtimeHost)}</string>`);
    expect(existsSync(meetingRuntimeHostPath(runtimeHost))).toBe(true);
    expect(h.plist).toContain('--request-permission');
    expect(h.plist).not.toContain('--check-permission');
  });
  test('escapes paths as XML data rather than code', async () => {
    const h = harness();
    await probeBackgroundMeetingAccessibility({ helperPath: '/app/<helper>&"', bunPath: '/app/Bun with space' }, h.runtime);
    expect(h.plist).toContain('/app/&lt;helper&gt;&amp;&quot;');
    expect(h.plist).toContain('/app/Bun with space');
  });
  test('never treats invalid or inconsistent receipts as permission granted', async () => {
    const h = harness({ state: 'idle', accessibilityTrusted: false });
    const result = await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper', bunPath: '/app/bun' }, h.runtime);
    expect(result.state).toBe('unavailable');
    expect(h.calls.at(-1)![0]).toBe('bootout');
    expect(existsSync(h.directory)).toBe(false);
  });
  test('cleans its exact job even if bootstrap fails after partial registration', async () => {
    const h = harness();
    const original = h.runtime.launchctl;
    h.runtime.launchctl = async args => { await original(args); if (args[0] === 'bootstrap') throw new Error('partial failure'); };
    expect((await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper', bunPath: '/app/bun' }, h.runtime)).state).toBe('unavailable');
    expect(h.calls.at(-1)![0]).toBe('bootout');
    expect(existsSync(h.directory)).toBe(false);
  });
  test('timeout removes its temporary job and files', async () => {
    const h = harness(null);
    const original = h.runtime.launchctl;
    h.runtime.launchctl = async args => {
      if (args[0] === 'bootstrap') {
        h.calls.push(args);
        // Deliberately do not create a result receipt.
      } else await original(args);
    };
    const result = await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper', bunPath: '/app/bun' }, h.runtime);
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('timed out');
    const directory = dirname(h.calls[0]![2]!);
    expect(existsSync(directory)).toBe(false);
    expect(h.calls.at(-1)![0]).toBe('bootout');
  });
  test('cancellation still unloads the temporary job', async () => {
    const h = harness();
    const abort = new AbortController();
    const original = h.runtime.launchctl;
    h.runtime.launchctl = async args => { await original(args); if (args[0] === 'bootstrap') abort.abort(); };
    const result = await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper', bunPath: '/app/bun', signal: abort.signal }, h.runtime);
    expect(result.detail).toContain('cancelled');
    expect(h.calls.at(-1)![0]).toBe('bootout');
    expect(existsSync(h.directory)).toBe(false);
  });
  test('a silent check leaves a missing stable host uninstalled and explains setup', async () => {
    const h = harness();
    const runtimeHost = host();
    const result = await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper', runtimeHost }, h.runtime);
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('seashell meeting speakers setup');
    expect(existsSync(runtimeHost.hostDirectory!)).toBe(false);
    expect(h.calls).toHaveLength(0);
  });
  test('a silent check reuses the same stable host after explicit setup without refreshing it', async () => {
    const runtimeHost = host();
    await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper', runtimeHost, requestPermission: true }, harness().runtime);
    const installed = meetingRuntimeHostPath(runtimeHost);
    const inode = statSync(installed).ino;
    writeFileSync(runtimeHost.runtimeSource!, 'new packaged runtime version');
    const h = harness();
    await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper', runtimeHost }, h.runtime);
    expect(h.plist).toContain(`<string>${installed}</string>`);
    expect(readFileSync(installed, 'utf8')).toBe('signed runtime fixture');
    expect(statSync(installed).ino).toBe(inode);
    expect(h.plist).toContain('--check-permission');
  });
  test('unsupported platforms and pre-cancelled checks never launch', async () => {
    const h = harness();
    const result = await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper' }, { ...h.runtime, platform: 'linux' });
    expect(result.state).toBe('unavailable');
    const abort = new AbortController(); abort.abort();
    await probeBackgroundMeetingAccessibility({ helperPath: '/app/helper', signal: abort.signal }, h.runtime);
    expect(h.calls).toHaveLength(0);
  });
});
