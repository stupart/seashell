import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export type MeetingConsentDecision = 'approve' | 'decline';

interface MeetingConsentCommand {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly decision: MeetingConsentDecision;
  readonly createdAtUnixMs: number;
}

export function meetingConsentPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Sea Shell', 'meeting-consent.json');
}

export function writeMeetingConsent(
  decision: MeetingConsentDecision,
  path = meetingConsentPath(),
  nowUnixMs = Date.now(),
): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const command: MeetingConsentCommand = {
    schemaVersion: 1,
    id: randomUUID(),
    decision,
    createdAtUnixMs: nowUnixMs,
  };
  try {
    writeFileSync(temporary, `${JSON.stringify(command)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
}

/** Consume a short-lived command exactly once so approval cannot leak to a later call. */
export function consumeMeetingConsent(
  path = meetingConsentPath(),
  nowUnixMs = Date.now(),
  maximumAgeMs = 120_000,
): MeetingConsentDecision | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } finally {
    rmSync(path, { force: true });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const command = value as Partial<MeetingConsentCommand>;
  if (command.schemaVersion !== 1 || typeof command.id !== 'string' ||
      (command.decision !== 'approve' && command.decision !== 'decline') ||
      !Number.isSafeInteger(command.createdAtUnixMs)) return undefined;
  if (nowUnixMs < Number(command.createdAtUnixMs) ||
      nowUnixMs - Number(command.createdAtUnixMs) > maximumAgeMs) return undefined;
  return command.decision;
}
