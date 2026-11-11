import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { defaultConfigPath } from './config.ts';

/**
 * When the guided setup last heard each source itself, through the same
 * helper the background recorder runs. Kept beside Seashell's settings, so a
 * check that passed still counts after a restart. The recorder also keeps
 * what its own recordings learned about computer audio here.
 */
export interface AudioChecks {
  /** ISO time the setup heard your microphone. */
  readonly microphone?: string;
  /** ISO time the setup heard your Mac's sound. */
  readonly computer?: string;
  /** ISO time a recording last heard the Mac's sound with the permission it
   * inherited from the background recorder, rather than Seashell System Audio's own. */
  readonly computerInherited?: string;
  /** Whose permission that was: the program running Seashell, as installed then. */
  readonly computerInheritedBy?: string;
  /** Recordings in a row that heard only silence through Seashell System Audio
   * at the start, and then through the inherited permission too. */
  readonly computerSilentStarts?: number;
}
export type AudioCheckSource = 'microphone' | 'computer';

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
      ...(validTime(value.computerInherited) ? { computerInherited: value.computerInherited } : {}),
      ...(typeof value.computerInheritedBy === 'string' && value.computerInheritedBy.length <= 4_096
        ? { computerInheritedBy: value.computerInheritedBy } : {}),
      ...(Number.isSafeInteger(value.computerSilentStarts) && Number(value.computerSilentStarts) > 0
        ? { computerSilentStarts: Number(value.computerSilentStarts) } : {}),
    };
  } catch { return {}; }
}

function writeAudioChecks(checks: AudioChecks, env: NodeJS.ProcessEnv): void {
  const path = audioChecksPath(env);
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

/** Remember that the setup heard this source just now. A new computer check starts the silent starts again. */
export function rememberAudioCheck(source: AudioCheckSource, at = new Date(), env: NodeJS.ProcessEnv = process.env): void {
  const { computerSilentStarts, ...checks } = readAudioChecks(env);
  writeAudioChecks({ ...checks, ...(source === 'computer' || !computerSilentStarts ? {} : { computerSilentStarts }),
    [source]: at.toISOString() }, env);
}

/** Forget a check, when macOS later refused the helper it confirmed. */
export function forgetAudioCheck(source: AudioCheckSource, env: NodeJS.ProcessEnv = process.env): void {
  const checks = readAudioChecks(env);
  if (!checks[source]) return;
  const rest = Object.fromEntries(Object.entries(checks)
    .filter(([key]) => key !== source && !(source === 'computer' && key === 'computerSilentStarts')));
  writeAudioChecks(rest, env);
}

/** A recording heard the Mac's sound with the permission it inherited from `by`: falling back to it there is known to work. */
export function rememberInheritedComputerAudio(by: string, at = new Date(), env: NodeJS.ProcessEnv = process.env): void {
  writeAudioChecks({ ...readAudioChecks(env), computerInherited: at.toISOString(), computerInheritedBy: by }, env);
}

/** One more recording in a row whose start heard only silence through both identities. Returns how many. */
export function countSilentOwnStart(env: NodeJS.ProcessEnv = process.env): number {
  const checks = readAudioChecks(env);
  const count = (checks.computerSilentStarts ?? 0) + 1;
  writeAudioChecks({ ...checks, computerSilentStarts: count }, env);
  return count;
}

/** Seashell System Audio heard sound: the silent starts before it were quiet ones. */
export function resetSilentOwnStarts(env: NodeJS.ProcessEnv = process.env): void {
  const { computerSilentStarts, ...checks } = readAudioChecks(env);
  if (computerSilentStarts) writeAudioChecks(checks, env);
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
