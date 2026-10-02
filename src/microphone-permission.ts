import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { MICROPHONE_HELPER } from './live-microphone.ts';
import { prepareMicrophoneRuntimeHelper, type RuntimeHostOptions } from './runtime-host.ts';

export type MicrophoneAuthorization = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown' | 'unavailable';

export interface MicrophonePermissionStatus {
  readonly authorization: MicrophoneAuthorization;
  readonly detail: string;
  readonly executable?: string;
}

export interface MicrophonePermissionOptions {
  /** Explicit setup only: lets macOS show its Microphone prompt. */
  readonly request?: boolean;
  readonly helperPath?: string;
  readonly runtimeHost?: RuntimeHostOptions;
  readonly signal?: AbortSignal;
}

const DETAILS: Record<MicrophoneAuthorization, string> = {
  authorized: 'Seashell Microphone can record your side of meetings, including in the background.',
  notDetermined: 'macOS has not asked yet. Run seashell meeting microphone setup and choose Allow.',
  denied: 'Microphone access is off for Seashell Microphone. Turn it on in System Settings → Privacy & Security → Microphone.',
  restricted: 'This Mac restricts microphone access (for example by a device-management profile).',
  unknown: 'macOS reported an unknown microphone permission state.',
  unavailable: 'The Seashell microphone helper is missing. Reinstall or run bash scripts/build-native.sh.',
};

/** The helper is responsible for itself, so this is the permission that the
 * background watcher will actually use, regardless of which terminal asks. */
export async function microphonePermission(options: MicrophonePermissionOptions = {}): Promise<MicrophonePermissionStatus> {
  const bundled = options.helperPath ?? MICROPHONE_HELPER;
  if (process.platform !== 'darwin' || !existsSync(bundled)) {
    return { authorization: 'unavailable', detail: DETAILS.unavailable };
  }
  let helper = bundled;
  try { helper = prepareMicrophoneRuntimeHelper(bundled, options.runtimeHost); } catch { /* Use the packaged copy. */ }
  const { stdout, failure } = await new Promise<{ stdout: string; failure?: string }>((resolve) => {
    execFile(helper, [options.request ? '--request-permission' : '--status'], {
      encoding: 'utf8',
      // Waiting for a person to answer the macOS prompt can take a while.
      timeout: options.request ? 300_000 : 10_000,
      maxBuffer: 64 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    }, (error, output) => resolve({
      stdout: String(output ?? ''),
      // --request-permission exits 77 when access is off; its JSON still describes why.
      ...(error && (error as { code?: unknown }).code !== 77 ? { failure: error.message } : {}),
    }));
  });
  try {
    const value = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
    const authorization: MicrophoneAuthorization =
      ['authorized', 'denied', 'restricted', 'notDetermined'].includes(value.authorization) ? value.authorization : 'unknown';
    return { authorization, detail: DETAILS[authorization], executable: helper };
  } catch {
    return { authorization: 'unknown', detail: `Could not read the microphone permission (${failure ?? 'no response'}).`, executable: helper };
  }
}
