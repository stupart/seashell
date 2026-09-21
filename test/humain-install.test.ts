import { test, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installedHumainCli, requireHumainNode } from '../src/humain-install.ts';
import { resolveHumainExecutable } from '../src/humain-client.ts';
import { parseCliArgs } from '../src/cli-args.ts';
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

test('managed Humain discovery is explicit, path-safe, and preserves developer overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-engine-install-')); roots.push(root);
  const env = { ...process.env, HUMAIN_CLI: '', SEASHELL_HUMAIN_DIR: root, PATH: '' };
  expect(installedHumainCli(env)).toBeUndefined();
  const active = join(root, 'active.json');
  writeFileSync(active, JSON.stringify({ schemaVersion: 1, sha256: '../../outside' }));
  expect(() => installedHumainCli(env)).toThrow('manifest');
  const digest = 'a'.repeat(64);
  writeFileSync(active, JSON.stringify({ schemaVersion: 1, sha256: digest }));
  expect(() => installedHumainCli(env)).toThrow('incomplete');
  const dist = join(root, 'versions', digest, 'node_modules', '@humain', 'engine', 'dist');
  mkdirSync(dist, { recursive: true }); writeFileSync(join(dist, 'cli.js'), '');
  expect(resolveHumainExecutable(env).prefix).toEqual([join(dist, 'cli.js')]);
  const override = join(root, 'override.js'); writeFileSync(override, '');
  expect(resolveHumainExecutable({ ...env, HUMAIN_CLI: override }).prefix).toEqual([override]);
});

test('Node readiness and install commands fail with actionable errors', () => {
  expect(() => requireHumainNode({ PATH: '' })).toThrow('brew install node');
  expect(parseCliArgs(['ai', 'install', '/tmp/engine.tgz', '--json'])).toEqual({
    kind: 'ai', action: 'install', tarball: '/tmp/engine.tgz', json: true,
  });
  expect(parseCliArgs(['ai', 'status'])).toEqual({ kind: 'ai', action: 'status', json: false });
  expect(() => parseCliArgs(['ai', 'install'])).toThrow('Usage');
  expect(() => parseCliArgs(['ai', 'status', 'extra'])).toThrow('Usage');
  const command = parseCliArgs(['meeting', 'setup', '--backend', 'local-openai', '--model', 'local-model']);
  expect(command.kind).toBe('meeting');
});
