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

/** Signal a child spawned with `detached: true` and everything it started: they share its process group. */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch {}
}

export interface TerminateOptions {
  /** The child was spawned with `detached: true`: a SIGKILL takes its whole process group. */
  readonly group?: boolean;
}

export async function terminateManagedChild(
  child: ChildProcess,
  graceMilliseconds = 1_500,
  options: TerminateOptions = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = childClosed(child);
  // A helper that relaunched itself forwards this to its relaunched copy.
  try { child.kill('SIGTERM'); } catch { return; }
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, graceMilliseconds)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    // A SIGKILL cannot be forwarded: only the group reaches a relaunched copy.
    if (options.group) signalProcessGroup(child, 'SIGKILL');
    else try { child.kill('SIGKILL'); } catch {}
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
  }
}

/** How long a helper's pipes may stay open after it exits before the rest of its group is killed. */
export const PIPE_GRACE_MS = 1_000;

/**
 * Call back once, when a child has exited and its output has been read: its
 * 'close'. A capture helper relaunches itself as its own responsible process
 * and proxies to that copy. If the proxy is killed, the copy can live on with
 * the pipes, and 'close' never comes. So after the child exits, give the pipes
 * a moment, then kill the rest of its process group (spawned `detached: true`)
 * and cut the pipes. Nothing waiting on a helper can wait forever.
 */
export function onChildSettled(
  child: ChildProcess,
  settled: (code: number | null, signal: NodeJS.Signals | null) => void,
  options: { readonly group?: boolean; readonly pipeGraceMs?: number } = {},
): void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    settled(code, signal);
  };
  child.once('close', finish);
  child.once('exit', (code, signal) => {
    timer = setTimeout(() => {
      // Its pipes are still open, so something in its group still holds them.
      if (options.group) signalProcessGroup(child, 'SIGKILL');
      timer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, 500);
    }, options.pipeGraceMs ?? PIPE_GRACE_MS);
  });
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
