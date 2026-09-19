import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seashell-download-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), `#!/bin/bash
set -eu
printf '%s\\n' "$@" > "$DOWNLOAD_ARGS"
while [ "$1" != --output ]; do shift; done
printf '%s' "$DOWNLOAD_BODY" > "$2"
exit "\${DOWNLOAD_EXIT:-0}"
`, { mode: 0o755 });
  const destination = join(root, 'models', 'model with spaces.bin');
  const digest = createHash('sha256').update('valid model').digest('hex');
  const run = (body = 'valid model', exit = '0') => spawnSync('bash', [
    new URL('../scripts/download-model.sh', import.meta.url).pathname,
    destination, 'https://example.invalid/model', digest,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOWNLOAD_ARGS: join(root, 'args'),
      DOWNLOAD_BODY: body, DOWNLOAD_EXIT: exit },
  });
  return { root, destination, run };
}

test('model install commits verified bytes and does not redownload a valid model', () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  expect(readFileSync(f.destination, 'utf8')).toBe('valid model');
  expect(readFileSync(join(f.root, 'args'), 'utf8')).toContain('--fail\n');
  rmSync(join(f.root, 'args'));
  expect(f.run('bad', '22').status).toBe(0);
  expect(existsSync(join(f.root, 'args'))).toBe(false);
});

test('HTTP failures and interrupted downloads never become installed models', () => {
  for (const exit of ['22', '18']) {
    const f = fixture();
    expect(f.run('partial bytes', exit).status).not.toBe(0);
    expect(existsSync(f.destination)).toBe(false);
    expect(readdirSync(join(f.root, 'models'))).toEqual([]);
    expect(f.run().status).toBe(0);
  }
});

test('wrong checksums are rejected and an old corrupt model can be repaired', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'models'));
  writeFileSync(f.destination, 'old partial download');
  expect(f.run('<html>proxy error</html>').status).not.toBe(0);
  expect(readFileSync(f.destination, 'utf8')).toBe('old partial download');
  expect(readdirSync(join(f.root, 'models'))).toEqual(['model with spaces.bin']);
  expect(f.run().status).toBe(0);
  expect(readFileSync(f.destination, 'utf8')).toBe('valid model');
});
