import type { ChildProcess } from 'child_process';
import { rmSync } from 'fs';

const activeChildren = new Set<ChildProcess>();
const activeTempDirectories = new Set<string>();
let activeSessions = 0;

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

function terminateForSignal(signal: 'SIGINT' | 'SIGTERM'): never {
  cleanupManagedResources();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

const onSigint = () => terminateForSignal('SIGINT');
const onSigterm = () => terminateForSignal('SIGTERM');

/**
 * Install signal cleanup only while the opt-in batch pipeline is active.
 * Nested sessions (the orchestrator plus Whisper adapter) share one registry.
 */
export function beginManagedProcessSession(): () => void {
  activeSessions += 1;
  if (activeSessions === 1) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeSessions = Math.max(0, activeSessions - 1);
    if (activeSessions === 0) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  };
}

export function trackChildProcess(child: ChildProcess): () => void {
  activeChildren.add(child);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    activeChildren.delete(child);
  };
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
