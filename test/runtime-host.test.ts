import { afterEach, expect, test } from 'bun:test';
import type { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectMeetingRuntimeHost, meetingRuntimeHostPath, prepareMeetingRuntimeHost, type RuntimeHostOptions } from '../src/runtime-host.ts';

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
  expect(path).toBe(join(h.options.hostDirectory!, 'bun'));
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
  expect(readdirSync(h.options.hostDirectory!)).toEqual(['bun']);
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
  expect(readdirSync(h.options.hostDirectory!)).toEqual(['bun']);
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
  expect(readdirSync(h.options.hostDirectory!)).toEqual(['bun']);
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
