import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AutomaticMeetingWatchService, runAutomaticMeetingWatch, type AutomaticMeetingWatchDependencies,
  type AutomaticMeetingWatchEvent } from '../src/automatic-meeting-watch.ts';
import { readBackgroundWatchStatus } from '../src/background-watch-status.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { consumeMeetingCommand, writeMeetingCommand } from '../src/meeting-command.ts';
import type { MeetingSignalSnapshot } from '../src/meeting-automation.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

// Tonight's call, in miniature: a Safari call on a Mac so busy that its probes
// time out, its detector restarts and every poll takes far longer than usual.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `seashell-${name}-`));
  roots.push(root);
  return root;
}

const SAFARI = { pid: 1594, bundleId: 'com.apple.WebKit.GPU', name: 'Safari Graphics and Media' };

interface BusyState {
  now: number;
  input: typeof SAFARI[];
  starts: number;
  stops: number;
  finalized: string[];
  events: AutomaticMeetingWatchEvent[];
}

/** A watcher over a fake clock whose capture and final pass are counted, not run. */
function busyWatch(root: string, overrides: (state: BusyState, snapshot: () => MeetingSignalSnapshot) => AutomaticMeetingWatchDependencies = () => ({})) {
  const state: BusyState = { now: 0, input: [SAFARI], starts: 0, stops: 0, finalized: [], events: [] };
  const snapshot = (): MeetingSignalSnapshot => ({ schemaVersion: 1, capturedAtUnixMs: state.now, supported: true, inputProcesses: state.input });
  const service = new AutomaticMeetingWatchService({
    config: { libraryDir: root, meeting: { automation: { confirmationPolls: 1, endGraceSeconds: 20, resumeWindowSeconds: 180,
      browserWithoutCalendar: 'automatic' } } },
    onEvent: (event) => state.events.push(event),
    dependencies: {
      now: () => new Date(state.now),
      readSignals: snapshot,
      consumeCommand: () => undefined,
      startCapture: (options) => {
        state.starts += 1;
        const id = options.sessionId ?? 'busy-call';
        const store = new CaptureSessionStore({ libraryDir: root, sessionId: id, startedAtUnixMs: options.startedAt!.getTime(),
          createdAt: options.startedAt!.toISOString() });
        return { store, sessionId: id, manifestPath: store.manifestPath,
          async stop() { state.stops += 1; return store.setStatus('captured', 'test'); } };
      },
      finalizeCapture: async (path) => {
        const id = path.split('/').at(-2)!;
        state.finalized.push(id);
        return createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'Saved.' }], speakers: [] }, { id, now: new Date(0) });
      },
      ...overrides(state, snapshot),
    },
  });
  return { state, snapshot, service };
}

test('a stop sent while every poll takes 40 s is read before the next probe and stops the recording', async () => {
  const root = scratch('slow-stop');
  const commandPath = join(root, 'meeting-command.json');
  let slow = false;
  const { state, service } = busyWatch(root, (state, snapshot) => ({
    // Each snapshot takes 40 s once the Mac is overloaded.
    readSignals: async () => { if (slow) { await Bun.sleep(1); state.now += 40_000; } return snapshot(); },
    consumeCommand: (_path, at, context) => consumeMeetingCommand(commandPath, at, context),
  }));
  try {
    expect((await service.pollOnce()).kind).toBe('start');
    slow = true;
    state.now = 3_000;
    const held = service.pollOnce();
    // Typed two seconds into a poll that will not finish for another 38.
    writeMeetingCommand('stop', commandPath, 5_000, { sessionId: 'busy-call' });
    await held;
    expect(state.stops).toBe(0);
    state.now += 3_000;
    await service.pollOnce();
    expect(state.stops).toBe(1);
    expect(state.events.map((event) => event.type)).toContain('meeting.stopped');
    expect(readBackgroundWatchStatus(root, { nowUnixMs: state.now })?.phase).toBe('watching');
  } finally { await service.shutdown(); }
});

test('a poll held up by a slow probe keeps the recorder status fresh, so it never reads as not running', async () => {
  const root = scratch('slow-status');
  let now = 0;
  let release: () => void = () => {};
  const stop = new AbortController();
  const run = runAutomaticMeetingWatch({
    config: { libraryDir: root, meeting: { automation: { confirmationPolls: 2 } } },
    lockPath: join(root, 'meeting-watch.lock'), signal: stop.signal, statusHeartbeatMs: 10,
    dependencies: {
      now: () => new Date(now),
      // The detector is restarting and its first snapshot will not come.
      readSignals: () => new Promise<MeetingSignalSnapshot>((resolve) => {
        release = () => resolve({ schemaVersion: 1, capturedAtUnixMs: now, supported: true, inputProcesses: [] });
      }),
      consumeCommand: () => undefined,
      consumeNotes: () => [],
    },
  });
  try {
    await Bun.sleep(40);
    now = 40_000;
    await Bun.sleep(40);
    expect(readBackgroundWatchStatus(root, { nowUnixMs: 40_000 })?.phase).toBe('watching');
  } finally { stop.abort(); release(); await run; }
  expect(readBackgroundWatchStatus(root, { nowUnixMs: 40_000 })?.phase).toBe('stopped');
});

test('a recording still reads as recording until its capture has closed, so "stopped" is never said early', async () => {
  const root = scratch('closing');
  const commands: Array<'start' | 'stop' | undefined> = [];
  let close: () => void = () => {};
  const { state, service } = busyWatch(root, (state) => ({
    consumeCommand: () => commands.shift(),
    startCapture: (options) => {
      state.starts += 1;
      const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'call-1', startedAtUnixMs: options.startedAt!.getTime() });
      return { store, sessionId: 'call-1', manifestPath: store.manifestPath,
        async stop() { await new Promise<void>((resolve) => { close = resolve; }); return store.setStatus('captured', 'test'); } };
    },
  }));
  try {
    await service.pollOnce();
    commands.push('stop');
    state.now += 3_000;
    const stopping = service.pollOnce();
    await Bun.sleep(5);
    service.heartbeat();
    expect(readBackgroundWatchStatus(root, { nowUnixMs: state.now })).toMatchObject({ phase: 'recording', sessionId: 'call-1' });
    close();
    await stopping;
    expect(readBackgroundWatchStatus(root, { nowUnixMs: state.now })?.phase).toBe('watching');
  } finally { close(); await service.shutdown(); }
});
