import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

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
}

export function meetingCommandPath(): string {
  // Tests and the journey renderer point this elsewhere so they never reach a real recorder.
  return process.env.SEASHELL_MEETING_COMMAND_PATH ||
    join(homedir(), 'Library', 'Application Support', 'Sea Shell', 'meeting-command.json');
}

export function writeMeetingCommand(command: MeetingCommand, path = meetingCommandPath(), nowUnixMs = Date.now()): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const value: MeetingCommandFile = { schemaVersion: 1, id: randomUUID(), command, createdAtUnixMs: nowUnixMs };
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
}

/** Read once and delete. A stale command is dropped: a late "start" must not record a later moment. */
export function consumeMeetingCommand(
  path = meetingCommandPath(),
  nowUnixMs = Date.now(),
  maximumAgeMs = 30_000,
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
  const age = nowUnixMs - Number(file.createdAtUnixMs);
  return age >= 0 && age <= maximumAgeMs ? file.command : undefined;
}
