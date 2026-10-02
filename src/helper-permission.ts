import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { prepareRuntimeHelper, type RuntimeHostOptions, type StableRuntimeHelper } from './runtime-host.ts';

export type HelperAuthorization = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'writeOnly' | 'unknown' | 'unavailable';

export interface HelperPermissionStatus {
  readonly authorization: HelperAuthorization;
  readonly detail: string;
  readonly executable?: string;
  /** Calendar only: how many calendars macOS shares once access is allowed. */
  readonly calendars?: number;
}

export interface HelperPermissionOptions {
  /** Explicit setup only: lets macOS show its permission prompt. */
  readonly request?: boolean;
  readonly helperPath?: string;
  readonly runtimeHost?: RuntimeHostOptions;
  readonly signal?: AbortSignal;
}

/**
 * Ask a self-responsible native helper (via --status or --request-permission)
 * which permission macOS gives it. That is the permission the background
 * watcher actually uses, regardless of which terminal asks.
 */
export async function helperPermission(bundled: string, helper: StableRuntimeHelper,
  details: Partial<Record<HelperAuthorization, string>> & Record<'authorized' | 'notDetermined' | 'denied' | 'unavailable', string>,
  options: HelperPermissionOptions = {}): Promise<HelperPermissionStatus> {
  const detail = (authorization: HelperAuthorization) => details[authorization] ?? `${helper.name} reported "${authorization}".`;
  if (process.platform !== 'darwin' || !existsSync(bundled)) return { authorization: 'unavailable', detail: detail('unavailable') };
  let executable = bundled;
  try { executable = prepareRuntimeHelper(bundled, helper, options.runtimeHost); } catch { /* Use the packaged copy. */ }
  const { stdout, failure } = await new Promise<{ stdout: string; failure?: string }>((resolve) => {
    execFile(executable, [options.request ? '--request-permission' : '--status'], {
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
    const authorization: HelperAuthorization = ['authorized', 'denied', 'restricted', 'notDetermined', 'writeOnly']
      .includes(value.authorization) ? value.authorization : 'unknown';
    return { authorization, detail: detail(authorization), executable,
      ...(Number.isSafeInteger(value.calendars) ? { calendars: value.calendars } : {}) };
  } catch {
    return { authorization: 'unknown', detail: `Could not read ${helper.name}'s permission (${failure ?? 'no response'}).`, executable };
  }
}
