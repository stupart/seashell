import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const bootstrap = new URL('../bootstrap.sh', import.meta.url).pathname;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seashell-bootstrap-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const repository = join(root, 'source repo');
  const installed = join(root, 'installed repo');
  mkdirSync(bin);
  mkdirSync(repository);
  // No real Xcode installer or network is reached by these scenarios.
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\nprintf Darwin\n', { mode: 0o755 });
  writeFileSync(join(bin, 'xcrun'), '#!/bin/sh\nexit "${CLT_EXIT:-0}"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'xcode-select'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(repository, 'install.sh'), '#!/bin/bash\nset -eu\nprintf installed > "$(dirname "$0")/marker"\n', { mode: 0o755 });
  writeFileSync(join(repository, '.gitignore'), 'marker\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    expect(spawnSync('git', args, { cwd: repository }).status).toBe(0);
  }
  const run = (extra = {}) => spawnSync('bash', [bootstrap], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SEASHELL_REPOSITORY_URL: repository,
      SEASHELL_INSTALL_DIR: installed, ...extra },
  });
  return { installed, run };
}

test('one bootstrap command clones paths with spaces and safely reinstalls', () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  expect(readFileSync(join(f.installed, 'marker'), 'utf8')).toBe('installed');
  expect(f.run().status).toBe(0);
  writeFileSync(join(f.installed, 'install.sh'), 'local changes');
  expect(f.run().status).not.toBe(0);
  expect(readFileSync(join(f.installed, 'install.sh'), 'utf8')).toBe('local changes');
});

test('the macOS git stub does not mask missing Command Line Tools', () => {
  const f = fixture();
  const result = f.run({ CLT_EXIT: '1' });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('Command Line Tools');
  expect(existsSync(f.installed)).toBe(false);
});
