import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { defaultConfigPath } from './config.ts';

/**
 * When the guided setup last heard each source itself, through the same
 * helper the background recorder runs. Kept beside Seashell's settings, so a
 * check that passed still counts after a restart.
 */
export interface AudioChecks {
  /** ISO time the setup heard your microphone. */
  readonly microphone?: string;
  /** ISO time the setup heard your Mac's sound. */
  readonly computer?: string;
}
export type AudioCheckSource = keyof AudioChecks;

export function audioChecksPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultConfigPath(env)), 'audio-checks.json');
}

const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function readAudioChecks(env: NodeJS.ProcessEnv = process.env): AudioChecks {
  try {
    const value = JSON.parse(readFileSync(audioChecksPath(env), 'utf8')) as Record<string, unknown>;
    if (value?.schemaVersion !== 1) return {};
    return {
      ...(validTime(value.microphone) ? { microphone: value.microphone } : {}),
      ...(validTime(value.computer) ? { computer: value.computer } : {}),
    };
  } catch { return {}; }
}

/** Remember that the setup heard this source just now. */
export function rememberAudioCheck(source: AudioCheckSource, at = new Date(), env: NodeJS.ProcessEnv = process.env): void {
  const path = audioChecksPath(env);
  const checks = { ...readAudioChecks(env), [source]: at.toISOString() };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ...checks }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Forget a check, when macOS later refused the helper it confirmed. */
export function forgetAudioCheck(source: AudioCheckSource, env: NodeJS.ProcessEnv = process.env): void {
  const checks = readAudioChecks(env);
  if (!checks[source]) return;
  const path = audioChecksPath(env);
  const rest = Object.fromEntries(Object.entries(checks).filter(([key]) => key !== source));
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ...rest }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * When a check heard the Mac through Seashell System Audio's own identity, made
 * with the helper copy installed now. A replaced copy is a new identity to
 * macOS, which may need asking again, so an older check does not count.
 */
export function computerAudioConfirmed(checks: AudioChecks, helperInstalledAtMs: number | undefined): string | undefined {
  const at = checks.computer;
  if (!at || helperInstalledAtMs === undefined) return undefined;
  return Date.parse(at) >= helperInstalledAtMs ? at : undefined;
}
