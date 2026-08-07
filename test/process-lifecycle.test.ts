import { expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanupManagedResources,
  trackChildProcess,
  trackTempDirectory,
} from '../src/process-lifecycle.ts';

test('interrupted work terminates children and removes tracked temporary data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'seashell-interruption-test-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  });
  const stopTrackingChild = trackChildProcess(child);
  const stopTrackingDirectory = trackTempDirectory(directory);

  cleanupManagedResources();
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  stopTrackingChild();
  stopTrackingDirectory();

  expect(child.killed).toBe(true);
  expect(existsSync(directory)).toBe(false);
});
