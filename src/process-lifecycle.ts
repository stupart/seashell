import type { ChildProcess } from 'child_process';
import { rmSync } from 'fs';

const activeChildren = new Set<ChildProcess>();
const activeTempDirectories = new Set<string>();
let activeSessions = 0;
let externalSignalOwners = 0;
let signalHandlersInstalled = false;

function childClosed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

export async function terminateManagedChild(
  child: ChildProcess,
  graceMilliseconds = 1_500,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = childClosed(child);
  try { child.kill('SIGTERM'); } catch { return; }
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, graceMilliseconds)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
  }
}

export function cleanupManagedResources(): void {
  for (const child of activeChildren) {
    try {
      if (!child.killed) child.kill('SIGTERM');
    } catch {}
  }
  activeChildren.clear();
  for (const directory of activeTempDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
  activeTempDirectories.clear();
}

export async function cleanupManagedResourcesAsync(): Promise<void> {
  const children = [...activeChildren];
  activeChildren.clear();
  await Promise.all(children.map(async (child) => await terminateManagedChild(child)));
  for (const directory of activeTempDirectories) {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
  activeTempDirectories.clear();
}

async function terminateForSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<never> {
  await cleanupManagedResourcesAsync();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

const onSigint = () => { void terminateForSignal('SIGINT'); };
const onSigterm = () => { void terminateForSignal('SIGTERM'); };

function synchronizeSignalHandlers(): void {
  const needed = activeSessions > 0 && externalSignalOwners === 0;
  if (needed && !signalHandlersInstalled) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    signalHandlersInstalled = true;
  } else if (!needed && signalHandlersInstalled) {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    signalHandlersInstalled = false;
  }
}

/** The caller already handles process signals and awaits its own shutdown.
 * Keep resource tracking active, but do not let a nested inference/batch session
 * exit the process before that owner has flushed capture and closed its workers.
 * Release only after the owner's asynchronous cleanup has completed. */
export function claimManagedProcessSignalOwnership(): () => void {
  externalSignalOwners += 1;
  synchronizeSignalHandlers();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    externalSignalOwners -= 1;
    synchronizeSignalHandlers();
  };
}

/**
 * Install signal cleanup only while the opt-in batch pipeline is active.
 * Nested sessions (the orchestrator plus Whisper adapter) share one registry.
 */
export function beginManagedProcessSession(): () => void {
  activeSessions += 1;
  synchronizeSignalHandlers();

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeSessions = Math.max(0, activeSessions - 1);
    synchronizeSignalHandlers();
  };
}

export function trackChildProcess(child: ChildProcess): () => void {
  activeChildren.add(child);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    activeChildren.delete(child);
  };
  child.once('close', remove);
  return remove;
}

export function trackTempDirectory(directory: string): () => void {
  activeTempDirectories.add(directory);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    activeTempDirectories.delete(directory);
  };
}
