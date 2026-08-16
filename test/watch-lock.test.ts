import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireMeetingWatchLock } from '../src/watch-lock.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('watch lock excludes live owners, recovers stale owners, and releases only itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-watch-lock-'));
  roots.push(root);
  const path = join(root, 'watch.lock');
  const first = acquireMeetingWatchLock({ path, pid: 10, pidAlive: (pid) => pid === 10 });
  expect(first).toBeDefined();
  expect(acquireMeetingWatchLock({ path, pid: 11, pidAlive: (pid) => pid === 10 })).toBeUndefined();
  first?.release();

  writeFileSync(path, JSON.stringify({ pid: 99, token: 'stale' }));
  const recovered = acquireMeetingWatchLock({ path, pid: 12, pidAlive: () => false });
  expect(recovered).toBeDefined();
  recovered?.release();
});
