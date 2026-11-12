import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readBackgroundWatchStatus, writeBackgroundWatchStatus, type BackgroundWatchStatus } from '../src/background-watch-status.ts';
import { consumeMeetingCommand, requestRecorder, writeMeetingCommand, type MeetingCommand } from '../src/meeting-command.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'seashell-meeting-command-'));
  roots.push(root);
  return root;
}

test('a stop never expires while its recording runs, but a late start still does', () => {
  const path = join(scratch(), 'meeting-command.json');
  // Ten minutes late: the recorder was too busy to read it, and the call is still recording.
  writeMeetingCommand('stop', path, 0);
  expect(consumeMeetingCommand(path, 600_000, { recordingSessionId: 'call-1' })).toBe('stop');
  writeMeetingCommand('stop', path, 0, { sessionId: 'call-1' });
  expect(consumeMeetingCommand(path, 600_000, { recordingSessionId: 'call-1' })).toBe('stop');
  // Meant for a recording that has ended: it must not stop the next one, or linger for it.
  writeMeetingCommand('stop', path, 0, { sessionId: 'call-1' });
  expect(consumeMeetingCommand(path, 1_000, { recordingSessionId: 'call-2' })).toBeUndefined();
  writeMeetingCommand('stop', path, 0);
  expect(consumeMeetingCommand(path, 1_000)).toBeUndefined();
  expect(consumeMeetingCommand(path, 1_000, { recordingSessionId: 'call-2' })).toBeUndefined();
  writeMeetingCommand('start', path, 0);
  expect(consumeMeetingCommand(path, 30_000)).toBe('start');
  writeMeetingCommand('start', path, 0);
  expect(consumeMeetingCommand(path, 30_001)).toBeUndefined();
});

/** A recorder whose status the test scripts, poll by poll, on a fake clock. */
function recorder(statuses: Array<Partial<BackgroundWatchStatus> | undefined>) {
  let clock = 0;
  const sent: Array<{ command: MeetingCommand; sessionId?: string }> = [];
  const read = () => {
    const next = statuses.length > 1 ? statuses.shift() : statuses[0];
    return next && { schemaVersion: 1 as const, pid: 1, updatedAtUnixMs: clock, phase: 'watching' as const, ...next };
  };
  return { sent, options: { libraryDir: '/nowhere', readStatus: read, now: () => clock,
    sleep: async (milliseconds: number) => { clock += milliseconds; },
    send: (command: MeetingCommand, sessionId?: string) => { sent.push({ command, ...(sessionId ? { sessionId } : {}) }); } } };
}

test('stopping waits for the recorder and says it stopped only once the recorder does', async () => {
  const recording = { phase: 'recording' as const, sessionId: 'call-1', candidate: { id: 'audio:safari', title: 'Planning', appName: 'Safari' } };
  const { sent, options } = recorder([recording, recording, recording, { phase: 'watching' }]);
  expect(await requestRecorder('stop', options)).toEqual({ kind: 'done', recording: false });
  expect(sent).toEqual([{ command: 'stop', sessionId: 'call-1' }]);
});

test('a recorder too busy to answer is busy, never "not running", and its stop stays queued', async () => {
  const recording = { phase: 'recording' as const, sessionId: 'call-1' };
  // Alive but silent: the shape readBackgroundWatchStatus gives a recorder held up by a slow probe.
  const busy = { phase: 'unavailable' as const, lastPhase: 'recording' as const, sessionId: 'call-1' };
  const { sent, options } = recorder([busy, busy]);
  expect(await requestRecorder('stop', options)).toEqual({ kind: 'busy', recording: true });
  expect(sent).toEqual([{ command: 'stop', sessionId: 'call-1' }]);
  // A busy status is only what it last said: "watching" there confirms no stop.
  const late = recorder([recording, { phase: 'unavailable', lastPhase: 'watching' }]);
  expect((await requestRecorder('stop', late.options)).kind).toBe('busy');
  expect((await requestRecorder('stop', recorder([undefined]).options)).kind).toBe('not-running');
  expect((await requestRecorder('stop', recorder([{ phase: 'unavailable' }]).options)).kind).toBe('not-running');
  expect((await requestRecorder('stop', recorder([{ phase: 'stopped' }]).options)).kind).toBe('not-running');
  expect((await requestRecorder('stop', recorder([{ phase: 'watching' }]).options)).kind).toBe('nothing-recording');
});

test('a live recorder whose status is over 30 s old reads as busy, with what it last said', () => {
  const root = scratch();
  writeBackgroundWatchStatus(root, { phase: 'recording', sessionId: 'call-1' }, 1_000);
  expect(readBackgroundWatchStatus(root, { nowUnixMs: 40_000, isAlive: () => true })).toMatchObject({
    phase: 'unavailable', lastPhase: 'recording', sessionId: 'call-1' });
  expect(readBackgroundWatchStatus(root, { nowUnixMs: 40_000, isAlive: () => false })?.lastPhase).toBeUndefined();
  expect(readBackgroundWatchStatus(root, { nowUnixMs: 2_000, isAlive: () => false })?.lastPhase).toBeUndefined();
});

test('a calendar title the reader would refuse is tidied, so a running recorder never reads as gone', () => {
  const root = scratch();
  writeBackgroundWatchStatus(root, { phase: 'recording', sessionId: 'call-1', warning: 'Line one\nline two',
    candidate: { id: 'audio:safari', title: 'Team sync 👩‍💻\n(weekly)', appName: 'Safari' } }, 1_000);
  const status = readBackgroundWatchStatus(root, { nowUnixMs: 1_000 });
  expect(status?.phase).toBe('recording');
  expect(status?.candidate?.title).toBe('Team sync 👩💻 (weekly)');
  expect(status?.warning).toBe('Line one line two');
});
