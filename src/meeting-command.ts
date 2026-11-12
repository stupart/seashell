import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { readBackgroundWatchStatus, type BackgroundWatchStatus } from './background-watch-status.ts';

/**
 * Record or stop by hand. The background recorder owns capture, so the app and
 * the CLI leave a one-shot command for it, the same way meeting consent works.
 */
export type MeetingCommand = 'start' | 'stop';

interface MeetingCommandFile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly command: MeetingCommand;
  readonly createdAtUnixMs: number;
  /** The recording a stop was meant for, when the sender knew it. */
  readonly sessionId?: string;
}

/** A start older than this is dropped: a late start must not record a later moment. */
export const MEETING_START_MAX_AGE_MS = 30_000;

export function meetingCommandPath(): string {
  // Tests and the journey renderer point this elsewhere so they never reach a real recorder.
  return process.env.SEASHELL_MEETING_COMMAND_PATH ||
    join(homedir(), 'Library', 'Application Support', 'Sea Shell', 'meeting-command.json');
}

export function writeMeetingCommand(command: MeetingCommand, path = meetingCommandPath(), nowUnixMs = Date.now(),
  options: { readonly sessionId?: string } = {}): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const value: MeetingCommandFile = { schemaVersion: 1, id: randomUUID(), command, createdAtUnixMs: nowUnixMs,
    ...(command === 'stop' && options.sessionId ? { sessionId: options.sessionId } : {}) };
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
}

/**
 * Read once and delete. A stop never expires while a recording is active: a
 * Mac busy enough to make the recorder slow is exactly when a stop must not be
 * lost. One meant for a recording that has since ended stops nothing, so it can
 * never end a later one. A start older than 30 s is dropped: a late start must
 * not record a later moment.
 */
export function consumeMeetingCommand(
  path = meetingCommandPath(),
  nowUnixMs = Date.now(),
  context: { readonly recordingSessionId?: string } = {},
): MeetingCommand | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    value = undefined;
  } finally {
    rmSync(path, { force: true });
  }
  const file = value as Partial<MeetingCommandFile> | undefined;
  if (!file || file.schemaVersion !== 1 || (file.command !== 'start' && file.command !== 'stop') ||
      !Number.isSafeInteger(file.createdAtUnixMs)) return undefined;
  if (file.command === 'stop') {
    const recording = context.recordingSessionId;
    return recording && (file.sessionId === undefined || file.sessionId === recording) ? 'stop' : undefined;
  }
  const age = nowUnixMs - Number(file.createdAtUnixMs);
  return age >= 0 && age <= MEETING_START_MAX_AGE_MS ? 'start' : undefined;
}

/**
 * What the recorder's status file says about whether it can take a command.
 * A recorder that is alive but has not written for a while is busy, not gone:
 * it still reads its commands, just later.
 */
export function recorderAnswering(status: BackgroundWatchStatus | undefined):
  | { readonly running: false }
  | { readonly running: true; readonly busy: boolean; readonly phase: BackgroundWatchStatus['phase']; readonly status: BackgroundWatchStatus } {
  if (!status || status.phase === 'stopped') return { running: false };
  if (status.phase !== 'unavailable') return { running: true, busy: false, phase: status.phase, status };
  return status.lastPhase && status.lastPhase !== 'stopped'
    ? { running: true, busy: true, phase: status.lastPhase, status } : { running: false };
}

export type RecorderAnswer =
  | { readonly kind: 'not-running' }
  | { readonly kind: 'nothing-recording' }
  | { readonly kind: 'already-recording'; readonly title?: string }
  /** The recorder did it: a start is recording, a stop has stopped. */
  | { readonly kind: 'done'; readonly recording: boolean; readonly title?: string }
  /** No answer in time. A stop is kept until the recorder reads it; a start may expire. */
  | { readonly kind: 'busy'; readonly recording: boolean; readonly title?: string };

export interface RecorderRequestOptions {
  readonly libraryDir: string;
  /** Leaves the command. Defaults to writeMeetingCommand; `--video` writes its own request first. */
  readonly send?: (command: MeetingCommand, sessionId?: string) => void;
  readonly readStatus?: (libraryDir: string) => BackgroundWatchStatus | undefined;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  /** How long to wait for the recorder to answer. Stopping waits longer: it closes the capture first. */
  readonly waitMs?: number;
  /** Called once the command is left and the wait begins, so "Stopping…" shows at once. */
  readonly onWaiting?: (command: MeetingCommand) => void;
}

/**
 * Ask the background recorder to start or stop, then wait and report what it
 * actually did. Never says it is not running while its status is fresh, and
 * never calls a recording stopped before the recorder says so.
 */
export async function requestRecorder(command: MeetingCommand, options: RecorderRequestOptions): Promise<RecorderAnswer> {
  const read = options.readStatus ?? ((libraryDir: string) => readBackgroundWatchStatus(libraryDir));
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const now = options.now ?? Date.now;
  const before = recorderAnswering(read(options.libraryDir));
  if (!before.running) return { kind: 'not-running' };
  const title = before.status.candidate?.title;
  if (command === 'stop' && before.phase !== 'recording') return { kind: 'nothing-recording' };
  if (command === 'start' && before.phase === 'recording') return { kind: 'already-recording', ...(title ? { title } : {}) };
  (options.send ?? ((value: MeetingCommand, sessionId?: string) => {
    writeMeetingCommand(value, undefined, now(), { ...(sessionId ? { sessionId } : {}) });
  }))(command, before.status.sessionId);
  options.onWaiting?.(command);
  // The recorder reads commands first thing on each check, every few seconds;
  // a stop then waits for the capture to close.
  const deadline = now() + (options.waitMs ?? (command === 'stop' ? 30_000 : 12_000));
  let latest = before;
  while (now() < deadline) {
    await sleep(500);
    const answer = recorderAnswering(read(options.libraryDir));
    if (!answer.running) continue;
    latest = answer;
    // A busy status is only what it last said; it confirms nothing.
    if (!answer.busy && (command === 'start') === (answer.phase === 'recording')) {
      const current = answer.status.candidate?.title;
      return { kind: 'done', recording: command === 'start', ...(current ? { title: current } : {}) };
    }
  }
  const current = latest.running ? latest.status.candidate?.title : undefined;
  return { kind: 'busy', recording: latest.running && latest.phase === 'recording', ...(current ? { title: current } : {}) };
}
