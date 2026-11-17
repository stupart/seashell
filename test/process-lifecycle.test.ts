import { expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AUDIO_HELPER_STOP_GRACE_MS,
  cleanupManagedResources,
  stopAudioHelper,
  terminateManagedChild,
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

test('managed child termination escalates when SIGTERM is ignored', async () => {
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)",
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
  const started = Date.now();
  await terminateManagedChild(child, 50);
  expect(child.signalCode).toBe('SIGKILL');
  expect(Date.now() - started).toBeLessThan(1_000);
});

async function isolatedLifecycle(script: string) {
  const module = JSON.stringify(new URL('../src/process-lifecycle.ts', import.meta.url).href);
  const child = spawn(process.execPath, ['--eval', `
    import { spawn } from 'node:child_process';
    import { beginManagedProcessSession, claimManagedProcessSignalOwnership,
      cleanupManagedResourcesAsync, trackChildProcess } from ${module};
    ${script}
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

test('an owning recorder finishes asynchronous capture and inference cleanup before signal exit', async () => {
  const result = await isolatedLifecycle(`
    const releaseOwnership = claimManagedProcessSignalOwnership();
    const endInference = beginManagedProcessSession();
    const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    trackChildProcess(worker);
    process.once('SIGTERM', () => {
      void (async () => {
        await Bun.sleep(80);
        console.log('capture-flushed');
        await cleanupManagedResourcesAsync();
        console.log('worker-closed=' + (worker.exitCode !== null || worker.signalCode !== null));
        endInference();
        releaseOwnership();
        console.log('watcher-cleanup-finished');
        process.exit(0);
      })();
    });
    process.kill(process.pid, 'SIGTERM');
    await Bun.sleep(1000);
  `);
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
  expect(result.stdout.trim().split('\n')).toEqual(['capture-flushed', 'worker-closed=true', 'watcher-cleanup-finished']);
});

test('default managed sessions keep their existing signal cleanup behavior', async () => {
  const result = await isolatedLifecycle(`
    beginManagedProcessSession();
    process.kill(process.pid, 'SIGTERM');
    await Bun.sleep(200);
    console.log('should-not-run');
  `);
  expect(result).toMatchObject({ code: 143, signal: null, stdout: '', stderr: '' });
});

test('nested ownership removes already-installed hooks and restores them only after the last release', async () => {
  const result = await isolatedLifecycle(`
    const before = process.listenerCount('SIGTERM');
    const end = beginManagedProcessSession();
    const installed = process.listenerCount('SIGTERM') - before;
    const releaseOne = claimManagedProcessSignalOwnership();
    const removed = process.listenerCount('SIGTERM') - before;
    const releaseTwo = claimManagedProcessSignalOwnership();
    releaseOne(); releaseOne();
    const nested = process.listenerCount('SIGTERM') - before;
    releaseTwo();
    const restored = process.listenerCount('SIGTERM') - before;
    end(); end();
    console.log(JSON.stringify({installed,removed,nested,restored,ended:process.listenerCount('SIGTERM')-before}));
  `);
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
  expect(JSON.parse(result.stdout)).toEqual({ installed: 1, removed: 0, nested: 0, restored: 1, ended: 0 });
});

test('a helper still writing its last output after the grace is not killed; one that never stops is, at the limit', async () => {
  // Stops in order: keeps writing for 600 ms after SIGTERM, then exits by itself.
  const finishingChild = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {
      const writing = setInterval(() => process.stdout.write('pcm'), 50);
      setTimeout(() => { clearInterval(writing); process.stdout.write('stop'); process.exit(0); }, 600);
    });
    process.stdout.write('ready'); setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  let lastOutputAt = 0;
  await new Promise<void>((resolve) => finishingChild.stdout!.once('data', () => resolve()));
  finishingChild.stdout!.on('data', () => { lastOutputAt = Date.now(); });
  await terminateManagedChild(finishingChild, 100, { finishing: () => Date.now() - lastOutputAt < 200, finishingLimitMs: 5_000 });
  expect(finishingChild.signalCode).toBeNull();
  expect(finishingChild.exitCode).toBe(0);

  // Ignores SIGTERM and keeps writing forever: the limit still ends it.
  const stuck = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {}); setInterval(() => process.stdout.write('pcm'), 20); process.stdout.write('ready');
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  let stuckOutputAt = 0;
  await new Promise<void>((resolve) => stuck.stdout!.once('data', () => resolve()));
  stuck.stdout!.on('data', () => { stuckOutputAt = Date.now(); });
  const started = Date.now();
  await terminateManagedChild(stuck, 100, { finishing: () => Date.now() - stuckOutputAt < 200, finishingLimitMs: 400 });
  expect(stuck.signalCode).toBe('SIGKILL');
  expect(Date.now() - started).toBeLessThan(2_000);
});

test('an audio helper gets five seconds to take its device down before any SIGKILL', async () => {
  expect(AUDIO_HELPER_STOP_GRACE_MS).toBe(5_000);
  // Takes 2 s to stop, silently: the old 1.5 s grace killed it partway through.
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 2_000));
    process.stdout.write('ready'); setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
  await stopAudioHelper(child, () => false);
  expect(child.signalCode).toBeNull();
  expect(child.exitCode).toBe(0);
}, 10_000);
