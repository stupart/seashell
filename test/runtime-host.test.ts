import { afterEach, expect, test } from 'bun:test';
import type { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedHelperProtocol, inspectMeetingRuntimeHost, meetingRuntimeHostPath, prepareMeetingRuntimeHost, prepareMicrophoneRuntimeHelper, type RuntimeHostOptions } from '../src/runtime-host.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seashell-runtime-host-'));
  roots.push(root);
  const source = join(root, 'packaged-bun');
  writeFileSync(source, 'signed runtime version one', { mode: 0o700 });
  const calls: string[][] = [];
  const runner = ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: '', stderr: args[0] === '--display' ? 'Identifier=bun\nAuthority=Developer ID Application: Bun\nTeamIdentifier=EXAMPLE123\n' : '' };
  }) as unknown as typeof spawnSync;
  const options: RuntimeHostOptions = { hostDirectory: join(root, 'private', 'Runtime'), runtimeSource: source, runner, platform: 'darwin' };
  return { root, source, calls, options };
}

test('read-only status does not create or repair a missing host', () => {
  const h = fixture();
  expect(inspectMeetingRuntimeHost(h.options)).toMatchObject({ ready: false, path: meetingRuntimeHostPath(h.options) });
  expect(existsSync(h.options.hostDirectory!)).toBe(false);
  expect(h.calls).toHaveLength(0);
});

test('explicit setup copies signed Bun privately and updates with atomic replacement', () => {
  const h = fixture();
  const path = prepareMeetingRuntimeHost(h.options);
  expect(path).toBe(join(h.options.hostDirectory!, 'Seashell Background'));
  expect(readFileSync(path, 'utf8')).toBe('signed runtime version one');
  expect(statSync(path).mode & 0o777).toBe(0o700);
  expect(statSync(h.options.hostDirectory!).mode & 0o777).toBe(0o700);
  const inode = statSync(path).ino;
  prepareMeetingRuntimeHost(h.options);
  expect(statSync(path).ino).toBe(inode);
  writeFileSync(h.source, 'signed runtime version two');
  prepareMeetingRuntimeHost(h.options);
  expect(statSync(path).ino).not.toBe(inode);
  expect(readFileSync(path, 'utf8')).toBe('signed runtime version two');
  expect(readdirSync(h.options.hostDirectory!)).toEqual(['Seashell Background']);
  expect(inspectMeetingRuntimeHost(h.options).ready).toBe(true);
  expect(h.calls.some(call => call.includes('--sign'))).toBe(false);
});

test('versioned and symlinked package sources retain a fixed host path', () => {
  const h = fixture();
  const opt = join(h.root, 'opt-bun');
  symlinkSync(h.source, opt);
  const path = prepareMeetingRuntimeHost({ ...h.options, runtimeSource: opt });
  rmSync(opt);
  const next = join(h.root, 'next-package-bun');
  writeFileSync(next, 'next package runtime', { mode: 0o700 });
  symlinkSync(next, opt);
  expect(prepareMeetingRuntimeHost({ ...h.options, runtimeSource: opt })).toBe(path);
  expect(readFileSync(path, 'utf8')).toBe('next package runtime');
});

test('bad or ad-hoc signatures cannot install or replace the last working host', () => {
  const h = fixture();
  const path = prepareMeetingRuntimeHost(h.options);
  writeFileSync(h.source, 'untrusted replacement');
  const invalid = (() => ({ status: 1, stderr: 'invalid signature' })) as unknown as typeof spawnSync;
  expect(() => prepareMeetingRuntimeHost({ ...h.options, runner: invalid })).toThrow('invalid or missing');
  expect(readFileSync(path, 'utf8')).toBe('signed runtime version one');
  const adhoc = (() => ({ status: 0, stdout: '', stderr: 'Identifier=bun\nSignature=adhoc\nTeamIdentifier=not set\n' })) as unknown as typeof spawnSync;
  expect(() => prepareMeetingRuntimeHost({ ...h.options, runner: adhoc })).toThrow('developer-signed');
  expect(readFileSync(path, 'utf8')).toBe('signed runtime version one');
  expect(readdirSync(h.options.hostDirectory!)).toEqual(['Seashell Background']);
});

test('a failed copied signature check leaves the existing executable intact', () => {
  const h = fixture();
  const path = prepareMeetingRuntimeHost(h.options);
  writeFileSync(h.source, 'next signed runtime');
  const runner = ((command: string, args: string[], options: unknown) => {
    if (args.at(-1)?.endsWith('.tmp')) return { status: 1, stderr: 'copy is invalid' };
    return (h.options.runner as Function)(command, args, options);
  }) as unknown as typeof spawnSync;
  expect(() => prepareMeetingRuntimeHost({ ...h.options, runner })).toThrow('invalid or missing');
  expect(readFileSync(path, 'utf8')).toBe('signed runtime version one');
  expect(readdirSync(h.options.hostDirectory!)).toEqual(['Seashell Background']);
});

test('symlink and hardlink destinations are rejected without touching their target', () => {
  const h = fixture();
  mkdirSync(h.options.hostDirectory!, { recursive: true, mode: 0o700 });
  const path = meetingRuntimeHostPath(h.options);
  symlinkSync(h.source, path);
  expect(inspectMeetingRuntimeHost(h.options).ready).toBe(false);
  expect(() => prepareMeetingRuntimeHost(h.options)).toThrow('symbolic link');
  rmSync(path);
  linkSync(h.source, path);
  expect(inspectMeetingRuntimeHost(h.options).ready).toBe(false);
  expect(() => prepareMeetingRuntimeHost(h.options)).toThrow('independent file');
  expect(readFileSync(h.source, 'utf8')).toBe('signed runtime version one');
});

test('a symlink host directory is not followed and read-only checks never chmod', () => {
  const h = fixture();
  mkdirSync(join(h.root, 'elsewhere'), { mode: 0o700 });
  mkdirSync(join(h.root, 'private'));
  symlinkSync(join(h.root, 'elsewhere'), h.options.hostDirectory!);
  expect(() => prepareMeetingRuntimeHost(h.options)).toThrow('symbolic link');
  expect(readdirSync(join(h.root, 'elsewhere'))).toEqual([]);
  rmSync(h.options.hostDirectory!);
  prepareMeetingRuntimeHost(h.options);
  chmodSync(meetingRuntimeHostPath(h.options), 0o755);
  expect(inspectMeetingRuntimeHost(h.options).ready).toBe(false);
  expect(statSync(meetingRuntimeHostPath(h.options)).mode & 0o777).toBe(0o755);
});

test('legacy bun is not reused, deleted or changed when installing the named host', () => {
  const h = fixture();
  mkdirSync(h.options.hostDirectory!, { recursive: true, mode: 0o700 });
  const legacy = join(h.options.hostDirectory!, 'bun');
  writeFileSync(legacy, 'existing legacy runtime', { mode: 0o700 });
  const legacyInode = statSync(legacy).ino;
  expect(inspectMeetingRuntimeHost(h.options).ready).toBe(false);
  const installed = prepareMeetingRuntimeHost(h.options);
  expect(installed).toBe(join(h.options.hostDirectory!, 'Seashell Background'));
  expect(readFileSync(installed, 'utf8')).toBe('signed runtime version one');
  expect(readFileSync(legacy, 'utf8')).toBe('existing legacy runtime');
  expect(statSync(legacy).ino).toBe(legacyInode);
  expect(inspectMeetingRuntimeHost(h.options).ready).toBe(true);
  expect(h.calls.every(call => call[0] === '/usr/bin/codesign' && !call.includes('--sign'))).toBe(true);
});

const helperPlist = (version?: number, identifier = 'com.humain.seashell.microphone') =>
  `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string>` +
  `${version === undefined ? '' : `<key>SeashellHelperProtocol</key><string>${version}</string>`}</dict></plist>`;
function helperBinary(directory: string, name: string, plist: string, salt: string): string {
  const path = join(directory, name);
  // Machine code around the embedded plist differs between SDKs; the plist does not.
  writeFileSync(path, Buffer.concat([Buffer.from(`\xcf\xfa\xed\xfe${salt}`, 'latin1'), Buffer.from(plist), Buffer.from(salt)]), { mode: 0o755 });
  return path;
}

test('the allowed microphone helper survives a rebuild of the same protocol', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-mic-host-'));
  try {
    const options = { hostDirectory: join(root, 'Runtime'), platform: 'darwin' as const };
    const first = helperBinary(root, 'first', helperPlist(), 'sdk-27');
    const installed = prepareMicrophoneRuntimeHelper(first, options);
    expect(readFileSync(installed, 'latin1')).toContain('sdk-27');
    expect(embeddedHelperProtocol(installed, 'com.humain.seashell.microphone')).toBe(1);
    // Same protocol, other SDK bytes: keep the copy macOS already allowed.
    prepareMicrophoneRuntimeHelper(helperBinary(root, 'rebuilt', helperPlist(1), 'sdk-26.5'), options);
    expect(readFileSync(installed, 'latin1')).toContain('sdk-27');
    // A new protocol must replace it, even though macOS will ask again.
    prepareMicrophoneRuntimeHelper(helperBinary(root, 'next', helperPlist(2), 'sdk-26.5'), options);
    expect(readFileSync(installed, 'latin1')).toContain('sdk-26.5');
    expect(embeddedHelperProtocol(installed, 'com.humain.seashell.microphone')).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file that is not the microphone helper is replaced, never trusted', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-mic-host-'));
  try {
    const options = { hostDirectory: join(root, 'Runtime'), platform: 'darwin' as const };
    const installed = prepareMicrophoneRuntimeHelper(helperBinary(root, 'other', helperPlist(1, 'com.example.other'), 'other'), options);
    expect(embeddedHelperProtocol(installed, 'com.humain.seashell.microphone')).toBeUndefined();
    prepareMicrophoneRuntimeHelper(helperBinary(root, 'real', helperPlist(1), 'real'), options);
    expect(readFileSync(installed, 'latin1')).toContain('real');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
