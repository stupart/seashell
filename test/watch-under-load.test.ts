import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { AutomaticMeetingWatchService, runAutomaticMeetingWatch, type AutomaticMeetingWatchDependencies,
  type AutomaticMeetingWatchEvent } from '../src/automatic-meeting-watch.ts';
import { readBackgroundWatchStatus } from '../src/background-watch-status.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { consumeMeetingCommand, writeMeetingCommand } from '../src/meeting-command.ts';
import { MeetingSignalTimeout, type MeetingSignalSnapshot } from '../src/meeting-automation.ts';
import { startBackgroundLiveTranscript } from '../src/background-live-transcript.ts';
import { readBackgroundMeetingStatus } from '../src/background-meeting-status.ts';
import { LIVE_TEXT_PAUSED } from '../src/live-text-guard.ts';
import { listTranscriptRecords } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import type { SeashellConfig } from '../src/config.ts';
import type { MeetProbe } from '../src/meet-speakers.ts';

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
function busyWatch(root: string, overrides: (state: BusyState, snapshot: () => MeetingSignalSnapshot) => AutomaticMeetingWatchDependencies = () => ({}),
  meeting: Omit<NonNullable<SeashellConfig['meeting']>, 'automation'> = {}) {
  const state: BusyState = { now: 0, input: [SAFARI], starts: 0, stops: 0, finalized: [], events: [] };
  const snapshot = (): MeetingSignalSnapshot => ({ schemaVersion: 1, capturedAtUnixMs: state.now, supported: true, inputProcesses: state.input });
  const service = new AutomaticMeetingWatchService({
    config: { libraryDir: root, meeting: { ...meeting, automation: { confirmationPolls: 1, endGraceSeconds: 20, resumeWindowSeconds: 180,
      browserWithoutCalendar: 'automatic' } } },
    onEvent: (event) => state.events.push(event),
    dependencies: {
      now: () => new Date(state.now),
      readSignals: snapshot,
      consumeCommand: () => undefined,
      startCapture: (options) => {
        state.starts += 1;
        const id = options.sessionId ?? `call-${state.starts}`;
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
    writeMeetingCommand('stop', commandPath, 5_000, { sessionId: 'call-1' });
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

/** The same every run: a Park–Miller sequence, so a failure replays exactly. */
function sequence(seed: number) {
  let value = seed;
  return () => { value = value * 48_271 % 2_147_483_647; return value / 2_147_483_647; };
}

/** What a poll on tonight's Mac saw: mostly the call, often nothing that can be trusted. */
function overloadedReadings(state: BusyState, snapshot: () => MeetingSignalSnapshot, seed = 7) {
  const next = sequence(seed);
  let outage = 0;
  return {
    readSignals: (): MeetingSignalSnapshot => {
      // Now and then the detector is gone for a minute: its heartbeat timed out and it is restarting.
      if (outage === 0 && next() < 0.02) outage = 20;
      if (outage > 0) { outage -= 1; throw new Error('Meeting signal detector heartbeat timed out'); }
      const roll = next();
      if (roll < 0.15) throw new Error('Meeting signal detector heartbeat timed out');
      // Core Audio answered for some processes only.
      if (roll < 0.3) return { ...snapshot(), complete: false, inputProcesses: [] };
      if (roll < 0.35) return { ...snapshot(), supported: false, inputProcesses: [] };
      return snapshot();
    },
    readMeet: async (): Promise<MeetProbe> => {
      return next() < 0.5
        ? { state: 'unavailable', source: 'google-meet-accessibility', detail: 'Browser Accessibility inspection was incomplete.' }
        : { state: 'unavailable', detail: 'Meeting detection and speaker names could not be checked. Check [V] Speakers.' };
    },
    readCalendar: async () => { throw new Error('Calendar did not respond. Meetings are still noticed without it. Check Calendar in Settings.'); },
  };
}

test('two hours of detector timeouts, half-read process lists and unreadable Meet pages record one call, never stopped and resumed', async () => {
  const root = scratch('no-churn');
  const { state, service } = busyWatch(root, overloadedReadings, {
    speakerBrowser: 'auto', calendar: { enabled: true, policy: 'all' },
  });
  try {
    for (state.now = 0; state.now < 2 * 60 * 60_000; state.now += 3_000) await service.pollOnce();
    expect(state.events.filter((event) => event.type.startsWith('meeting.')).map((event) => event.type)).toEqual(['meeting.started']);
    expect(service.phase).not.toBe('watching');
    expect([state.starts, state.stops, state.finalized.length]).toEqual([1, 0, 0]);
    expect(state.events.some((event) => event.type === 'watch.warning' && event.message.includes('heartbeat'))).toBe(true);
    // The call ends. The Mac is still overloaded, but the readings it can trust say Safari let go of the microphone.
    state.input = [];
    const ended = state.now;
    let finishedAt: number | undefined;
    for (; state.now <= ended + 120_000 && finishedAt === undefined; state.now += 3_000) {
      if ((await service.pollOnce()).kind === 'finish') finishedAt = state.now;
    }
    expect(finishedAt! - ended).toBeGreaterThanOrEqual(20_000);
    expect(state.events.filter((event) => event.type.startsWith('meeting.')).map((event) => event.type))
      .toEqual(['meeting.started', 'meeting.capture-finished']);
  } finally { await service.shutdown(); }
  expect(state.finalized).toEqual(['call-1']);
});

test('no final pass runs while a call records: a paused meeting waits, then each runs once', async () => {
  const root = scratch('no-final-mid-call');
  const commands: Array<'start' | 'stop' | undefined> = [];
  const { state, service } = busyWatch(root, () => ({ consumeCommand: () => commands.shift() }));
  const settle = () => Bun.sleep(10);
  try {
    expect((await service.pollOnce()).kind).toBe('start');
    // Safari lets go of the microphone for the grace: the meeting pauses, held for resume.
    state.input = [];
    for (state.now = 3_000; state.now <= 24_000; state.now += 3_000) await service.pollOnce();
    expect(state.events.map((event) => event.type)).toContain('meeting.capture-finished');
    // Three seconds later, as tonight at 00:28, the person records by hand.
    commands.push('start');
    state.now += 3_000;
    expect((await service.pollOnce()).kind).toBe('start');
    // Long past the paused meeting's resume window, while the new recording runs.
    for (state.now += 3_000; state.now <= 600_000; state.now += 3_000) await service.pollOnce();
    await settle();
    expect(state.finalized).toEqual([]);
    commands.push('stop');
    await service.pollOnce();
    await settle();
    expect(state.finalized).toEqual(['call-1', 'call-2']);
  } finally { await service.shutdown(); }
  expect(state.finalized).toEqual(['call-1', 'call-2']);
});

test('a call that pauses and resumes is transcribed once, after it has really ended', async () => {
  const root = scratch('final-once');
  const { state, service } = busyWatch(root);
  try {
    await service.pollOnce();
    for (let pause = 0; pause < 3; pause += 1) {
      state.input = [];
      for (let poll = 0; poll < 8; poll += 1) { state.now += 3_000; await service.pollOnce(); }
      state.input = [SAFARI];
      state.now += 3_000;
      expect((await service.pollOnce()).kind).toBe('start');
      await Bun.sleep(10);
      expect(state.finalized).toEqual([]);
    }
    state.input = [];
    for (let poll = 0; poll < 80; poll += 1) { state.now += 3_000; await service.pollOnce(); }
    await Bun.sleep(10);
    expect(state.finalized).toEqual(['call-1']);
  } finally { await service.shutdown(); }
  expect(state.finalized).toEqual(['call-1']);
  expect(state.starts).toBe(4);
});

test('an overloaded Mac pauses live text mid-call and keeps the audio recording; a calm minute brings it back', async () => {
  const root = scratch('pause-live-text');
  let load = 0.3;
  let timeouts = 0;
  const engines: string[] = [];
  const { state, snapshot, service } = busyWatch(root, () => ({
    readLoad: () => load,
    readSignals: () => {
      if (timeouts > 0) { timeouts -= 1; throw new MeetingSignalTimeout('Meeting signal detector heartbeat timed out'); }
      return snapshot();
    },
    startLiveTranscript: (options) => startBackgroundLiveTranscript({ ...options, dependencies: {
      createTranscriber: () => { engines.push('engine'); return { transcribe: async () => 'Hello.', stop: async () => {} }; },
    } }),
  }));
  const draft = () => readBackgroundMeetingStatus(listTranscriptRecords(root)[0]!.directory)?.draftStatus;
  const poll = async () => { await service.pollOnce(); state.now += 3_000; };
  try {
    await poll();
    expect(draft()?.stage).toBe('waiting');
    load = 70 / 18;
    await poll();
    expect(draft()).toEqual({ stage: 'paused', detail: LIVE_TEXT_PAUSED, queueDepth: 0 });
    expect(state.events.some((event) => event.type === 'watch.warning' && event.message === LIVE_TEXT_PAUSED)).toBe(true);
    load = 0.5;
    for (let calmPoll = 0; calmPoll < 20; calmPoll += 1) await poll();
    expect(draft()?.stage).toBe('paused');
    await poll();
    expect(draft()?.stage).toBe('waiting');
    // Probes timing out twice in a minute pause it too.
    timeouts = 2;
    await poll();
    await poll();
    expect(draft()?.stage).toBe('paused');
    expect(service.phase).toBe('recording');
    expect([state.starts, state.stops]).toEqual([1, 0]);
  } finally { await service.shutdown(); }
});

test('a Meet check that timed out is not run again three seconds later', async () => {
  const root = scratch('meet-backoff');
  let checks = 0;
  const { state, service } = busyWatch(root, () => ({
    readLoad: () => 0,
    readMeet: async (): Promise<MeetProbe> => {
      checks += 1;
      return { state: 'unavailable', detail: 'Meeting detection and speaker names could not be checked. Check [V] Speakers.', timedOut: true };
    },
  }), { speakerBrowser: 'auto' });
  try {
    for (state.now = 0; state.now < 120_000; state.now += 3_000) await service.pollOnce();
    // Checked at 0, then 10, 20, 40 and 60 s apart: not 40 times in two minutes.
    expect(checks).toBe(4);
    expect(service.phase).toBe('recording');
  } finally { await service.shutdown(); }
});

test('the microphone is let go of while the call app has let go of its own, and opened again when the call comes back', async () => {
  const root = scratch('release-mic');
  const microphone: string[] = [];
  let detectorDown = false;
  const { state, snapshot, service } = busyWatch(root, (state) => ({
    readSignals: () => {
      if (detectorDown) throw new MeetingSignalTimeout('Meeting signal detector heartbeat timed out');
      return snapshot();
    },
    startCapture: (options) => {
      state.starts += 1;
      const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'call-1', startedAtUnixMs: options.startedAt!.getTime() });
      return { store, sessionId: 'call-1', manifestPath: store.manifestPath,
        releaseMicrophone: () => { microphone.push('released'); },
        reopenMicrophone: () => { microphone.push('reopened'); },
        async stop() { state.stops += 1; return store.setStatus('captured', 'test'); } };
    },
  }));
  const poll = async () => { state.now += 3_000; return (await service.pollOnce()).kind; };
  try {
    await service.pollOnce();
    // Safari lets go of the microphone. One reading could be a device switch; two are the call ending.
    state.input = [];
    await poll();
    expect(microphone.filter((step) => step === 'released')).toEqual([]);
    await poll();
    expect(microphone.at(-1)).toBe('released');
    // The call comes back inside the grace: the same recording, microphone open again.
    state.input = [SAFARI];
    await poll();
    expect(microphone.at(-1)).toBe('reopened');
    // A detector timeout during the grace tells nothing: it neither lets go nor counts as a reading.
    state.input = [];
    await poll();
    detectorDown = true;
    await poll();
    await poll();
    expect(microphone.filter((step) => step === 'released')).toHaveLength(1);
    detectorDown = false;
    await poll();
    expect(microphone.filter((step) => step === 'released')).toHaveLength(2);
    expect(microphone.at(-1)).toBe('released');
    expect([state.starts, state.stops]).toEqual([1, 0]);
    let finished = false;
    for (let polls = 0; polls < 8 && !finished; polls += 1) finished = await poll() === 'finish';
    expect(finished).toBe(true);
  } finally { await service.shutdown(); }
});

test('the recorder publishes its phase outside Documents: three fields, 0644, atomic, every few seconds and on every change', async () => {
  const root = scratch('recording-state');
  const path = join(root, 'Caches', 'seashell', 'background-watch.json');
  const previous = process.env.SEASHELL_RECORDING_STATE_PATH;
  process.env.SEASHELL_RECORDING_STATE_PATH = path;
  let now = 0;
  let release: () => void = () => {};
  const stop = new AbortController();
  const published = () => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  try {
    const run = runAutomaticMeetingWatch({
      config: { libraryDir: join(root, 'library'), meeting: { automation: { confirmationPolls: 2 } } },
      lockPath: join(root, 'meeting-watch.lock'), signal: stop.signal, statusHeartbeatMs: 10,
      dependencies: {
        now: () => new Date(now),
        readSignals: () => new Promise<MeetingSignalSnapshot>((resolve) => {
          release = () => resolve({ schemaVersion: 1, capturedAtUnixMs: now, supported: true, inputProcesses: [] });
        }),
        consumeCommand: () => undefined,
        consumeNotes: () => [],
      },
    });
    await Bun.sleep(40);
    now = 40_000;
    await Bun.sleep(40);
    // Rewritten while the poll waits on a slow detector, with the recorder's own time.
    expect(Object.keys(published()).toSorted()).toEqual(['mirroredAtUnixMs', 'phase', 'updatedAtUnixMs']);
    expect(published()).toMatchObject({ phase: 'watching', updatedAtUnixMs: 40_000 });
    expect(Math.abs(Number(published().mirroredAtUnixMs) - Date.now())).toBeLessThan(5_000);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    stop.abort(); release(); await run;
    expect(published().phase).toBe('stopped');
    expect(readdirSync(dirname(path))).toEqual(['background-watch.json']);
  } finally {
    stop.abort(); release();
    if (previous === undefined) delete process.env.SEASHELL_RECORDING_STATE_PATH;
    else process.env.SEASHELL_RECORDING_STATE_PATH = previous;
  }
});

test('a recorder that cannot write its library status still publishes that it is recording', async () => {
  const root = scratch('recording-state-alone');
  const path = join(root, 'recording-state.json');
  const previous = process.env.SEASHELL_RECORDING_STATE_PATH;
  process.env.SEASHELL_RECORDING_STATE_PATH = path;
  // The library's own status file cannot be replaced, as when Documents access is gone.
  mkdirSync(join(root, '.background-watch.json', 'blocked'), { recursive: true });
  const { state, service } = busyWatch(root);
  try {
    expect((await service.pollOnce()).kind).toBe('start');
    expect(JSON.parse(readFileSync(path, 'utf8')).phase).toBe('recording');
    expect(state.events.some((event) => event.type === 'watch.warning' && event.message.includes('background recorder status'))).toBe(true);
  } finally {
    await service.shutdown();
    if (previous === undefined) delete process.env.SEASHELL_RECORDING_STATE_PATH;
    else process.env.SEASHELL_RECORDING_STATE_PATH = previous;
  }
  expect(JSON.parse(readFileSync(path, 'utf8')).phase).toBe('stopped');
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
