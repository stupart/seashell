import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutomaticMeetingWatch } from '../src/automatic-meeting-watch.ts';
import { beginManagedProcessSession } from '../src/process-lifecycle.ts';
import { acquireMeetingWatchLock } from '../src/watch-lock.ts';

test('watcher startup failure restores nested managed signal hooks and releases only its test lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-watch-signal-start-'));
  const lockPath = join(root, 'watch.lock');
  const end = beginManagedProcessSession();
  const listeners = process.listenerCount('SIGTERM');
  try {
    await expect(runAutomaticMeetingWatch({ libraryDir: root, lockPath, once: true, config: {},
      onEvent: event => { if (event.type === 'watch.ready') throw new Error('fixture startup failure'); },
      dependencies: { readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: 0, supported: true, inputProcesses: [] }) },
    })).rejects.toThrow('fixture startup failure');
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
    const next = acquireMeetingWatchLock({ path: lockPath });
    expect(next).toBeDefined();
    next?.release();
  } finally { end(); rmSync(root, { recursive: true, force: true }); }
});

test('SIGTERM waits for capture flush, draft cleanup and canonical finalization before watcher exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-watch-signal-stop-'));
  const module = (name: string) => JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).href);
  const script = `
    import { join } from 'node:path';
    import { runAutomaticMeetingWatch } from ${module('automatic-meeting-watch')};
    import { CaptureSessionStore } from ${module('capture-session')};
    import { createTranscriptRecord } from ${module('transcript-record')};
    import { beginManagedProcessSession } from ${module('process-lifecycle')};
    const root = ${JSON.stringify(root)};
    const abort = new AbortController();
    process.once('SIGTERM', () => abort.abort());
    let endInference;
    const operations = [];
    await runAutomaticMeetingWatch({ libraryDir: root, lockPath: join(root,'watch.lock'), signal: abort.signal,
      config: { meeting: { automation: { enabled: true, mode: 'automatic', confirmationPolls: 1 } } },
      onEvent: event => { if (event.type === 'meeting.started') setTimeout(()=>process.kill(process.pid,'SIGTERM'),10); },
      dependencies: {
        readSignals: () => ({ schemaVersion:1,capturedAtUnixMs:Date.now(),supported:true,
          inputProcesses:[{pid:42,bundleId:'us.zoom.xos',name:'Zoom'}] }),
        startCapture: () => {
          const store = new CaptureSessionStore({libraryDir:root,sessionId:'shutdown-fixture',startedAtUnixMs:Date.now()});
          return {store,sessionId:store.manifest.sessionId,manifestPath:store.manifestPath,
            async stop() { await Bun.sleep(80);operations.push('capture-flushed');return store.setStatus('captured','fixture'); }};
        },
        startLiveTranscript: () => {
          endInference = beginManagedProcessSession();
          return {status:{stage:'waiting',detail:'Fixture',queueDepth:0},enqueue(){},
            async close() { await Bun.sleep(30);operations.push('draft-closed');endInference(); }};
        },
        finalizeCapture: async () => {
          const endFinalization = beginManagedProcessSession();
          try { await Bun.sleep(40);operations.push('canonical-finalized');
            return createTranscriptRecord({transcript:[],speakers:[]},{id:'shutdown-fixture'});
          } finally { endFinalization(); }
        },
      },
    });
    operations.push('watcher-exited');
    console.log(JSON.stringify(operations));
  `;
  const child = spawn(process.execPath, ['--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect({ ...result, stderr }).toEqual({ code: 0, signal: null, stderr: '' });
    expect(JSON.parse(stdout)).toEqual(['capture-flushed', 'draft-closed', 'canonical-finalized', 'watcher-exited']);
    const next = acquireMeetingWatchLock({ path: join(root, 'watch.lock') });
    expect(next).toBeDefined(); next?.release();
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
