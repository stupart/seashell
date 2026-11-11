import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultConfigPath } from './config.ts';
import { MICROPHONE_HELPER } from './live-microphone.ts';
import { helperPermission, type HelperAuthorization, type HelperPermissionOptions, type HelperPermissionStatus } from './helper-permission.ts';
import { MICROPHONE_RUNTIME_HELPER } from './runtime-host.ts';

export type MicrophoneAuthorization = HelperAuthorization;
export type MicrophonePermissionStatus = HelperPermissionStatus;
export type MicrophonePermissionOptions = HelperPermissionOptions;

const DETAILS = {
  authorized: 'Seashell Microphone can record your side of meetings, including in the background.',
  notDetermined: 'macOS has not asked yet. Run seashell meeting microphone setup and choose Allow.',
  denied: 'Microphone access is off for Seashell Microphone. Turn it on in System Settings → Privacy & Security → Microphone.',
  restricted: 'This Mac restricts microphone access (for example by a device-management profile).',
  unknown: 'macOS reported an unknown microphone permission state.',
  unavailable: 'The Seashell microphone helper is missing. Reinstall or run bash scripts/build-native.sh.',
};

export function microphonePermission(options: MicrophonePermissionOptions = {}): Promise<MicrophonePermissionStatus> {
  return helperPermission(options.helperPath ?? MICROPHONE_HELPER, MICROPHONE_RUNTIME_HELPER, DETAILS, options);
}

/**
 * Enter on "Mic not allowed": macOS's prompt for Seashell Microphone while it
 * has not asked, or its Privacy pane once the answer was no, since macOS never
 * asks twice.
 */
export async function allowMicrophone(options: { signal?: AbortSignal; openSettings?: () => void } = {}): Promise<MicrophonePermissionStatus> {
  const status = await microphonePermission({ request: true, ...(options.signal ? { signal: options.signal } : {}) });
  if (status.authorization === 'denied' || status.authorization === 'restricted') {
    (options.openSettings ?? (() => spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'],
      { stdio: 'ignore', timeout: 5_000 })))();
  }
  return status;
}

export const MICROPHONE_START_NOTICES = {
  notDetermined: 'Seashell is recording a call but cannot hear you yet. Choose Allow when macOS asks about Seashell Microphone, or open Seashell.',
  denied: 'Seashell is recording a call without your side: microphone access is off. Open Seashell and press Enter to allow it.',
} as const;
export const MICROPHONE_UPDATE_NOTICE = 'Seashell needs your OK to use the microphone again after the update. Open Seashell to allow.';

/**
 * Tells you once per recording, as it starts, that macOS has not allowed the
 * microphone, so your side is not being recorded. The recorder keeps checking
 * and starts the moment it is allowed.
 */
export function microphoneStartNotifier(notify: (message: string) => void,
  check: () => Promise<MicrophonePermissionStatus> = () => microphonePermission()): (event: { readonly type: string; readonly sessionId?: string }) => void {
  let checked: string | undefined;
  return (event) => {
    if (event.type !== 'meeting.started' || !event.sessionId || checked === event.sessionId) return;
    checked = event.sessionId;
    void check().then((status) => {
      const notice = status.authorization === 'notDetermined' ? MICROPHONE_START_NOTICES.notDetermined
        : status.authorization === 'denied' ? MICROPHONE_START_NOTICES.denied : undefined;
      if (notice) notify(notice);
    }).catch(() => {});
  };
}

interface MicrophoneCopyNotes {
  /** The Runtime copy macOS last allowed. */
  readonly allowedCopy?: string;
  /** The copy already told about. */
  readonly noticedCopy?: string;
}

/**
 * At the login agent's start: a new Runtime copy of Seashell Microphone (an
 * update changed its protocol) that macOS has not decided on yet would ask in
 * the middle of the next call. Say so once now, at a calm moment, if an
 * earlier copy had been allowed. Checking prepares the new copy; it never asks.
 */
export async function microphoneUpdateNotice(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly check?: () => Promise<MicrophonePermissionStatus>;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const status = await (options.check ?? (() => microphonePermission()))();
  if (!status.executable) return undefined;
  let copy: string;
  try { const info = statSync(status.executable); copy = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`; }
  catch { return undefined; }
  const path = join(dirname(defaultConfigPath(env)), 'microphone-copy.json');
  let notes: MicrophoneCopyNotes = {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    notes = {
      ...(typeof value.allowedCopy === 'string' ? { allowedCopy: value.allowedCopy } : {}),
      ...(typeof value.noticedCopy === 'string' ? { noticedCopy: value.noticedCopy } : {}),
    };
  } catch { /* Nothing noted yet. */ }
  const save = (next: MicrophoneCopyNotes) => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } catch { /* A notice is not worth failing the recorder for. */ }
  };
  if (status.authorization === 'authorized') {
    if (notes.allowedCopy !== copy) save({ ...notes, allowedCopy: copy });
    return undefined;
  }
  if (status.authorization !== 'notDetermined' || !notes.allowedCopy || notes.allowedCopy === copy || notes.noticedCopy === copy) return undefined;
  save({ ...notes, noticedCopy: copy });
  return MICROPHONE_UPDATE_NOTICE;
}
