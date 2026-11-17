import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';
import {
  existsSync,
  chmodSync,
  closeSync,
  openSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { meetingRuntimeHostPath, prepareMeetingRuntimeHost, type RuntimeHostOptions } from './runtime-host.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SEASHELL_LAUNCH_AGENT_LABEL = 'com.humain.seashell.meeting-watch';

export interface LaunchAtLoginStatus {
  readonly enabled: boolean;
  readonly loaded: boolean;
  readonly label: string;
  readonly plistPath: string;
  readonly command: readonly string[];
}

export interface LaunchAtLoginOptions {
  readonly launchAgentsDir?: string;
  readonly projectRoot?: string;
  readonly uid?: number;
  readonly runner?: typeof spawnSync;
  readonly logsDir?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeHost?: RuntimeHostOptions;
  /** Injectable synchronous delay and monotonic clock for restart tests. */
  readonly wait?: (milliseconds: number) => void;
  readonly now?: () => number;
}

/**
 * How launchd schedules the recorder, and so its audio helpers, which inherit
 * it. Background clamped every thread to Darwin priority 4 with throttled
 * disk: on a busy Mac the helpers could not drain Core Audio's ring for
 * minutes, and a call lost 3 minutes of the other side. Standard is what a
 * process gets with no ProcessType at all. Interactive is the app tier,
 * meant for jobs whose responsiveness the person feels directly; the
 * recorder has no window, and its heavy work runs below it anyway, wrapped
 * by taskpolicy (inference-priority.ts). Disk I/O is no longer throttled
 * either: it writes the audio.
 */
export const RECORDER_PROCESS_TYPE = 'Standard';

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function paths(options: LaunchAtLoginOptions = {}) {
  const environment = options.environment ?? process.env;
  // A package manager's opt path survives replacement of a versioned Cellar.
  const root = resolve(options.projectRoot ?? environment.SEASHELL_PACKAGE_ROOT ?? PROJECT_ROOT);
  const launchAgentsDir = resolve(options.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents'));
  const support = join(homedir(), 'Library', 'Application Support', 'Sea Shell');
  return {
    root,
    launchAgentsDir,
    plistPath: join(launchAgentsDir, `${SEASHELL_LAUNCH_AGENT_LABEL}.plist`),
    entrypoint: join(root, 'src', 'cli.tsx'),
    logsDir: resolve(options.logsDir ?? join(support, 'Logs')),
  };
}

function launchDomain(options: LaunchAtLoginOptions): string {
  return `gui/${options.uid ?? process.getuid?.() ?? 501}`;
}

function command(options: LaunchAtLoginOptions = {}): readonly string[] {
  const resolved = paths(options);
  return Object.freeze([meetingRuntimeHostPath(options.runtimeHost), 'run', resolved.entrypoint, 'meeting', 'watch', '--json']);
}

function plist(options: LaunchAtLoginOptions = {}): string {
  const resolved = paths(options);
  const environment = options.environment ?? process.env;
  const path = [...new Set([
    ...(environment.PATH ?? '').split(':').filter(Boolean),
    join(homedir(), '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SEASHELL_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${command(options).map((argument) => `<string>${xml(argument)}</string>`).join('\n    ')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(resolved.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
    ${['SEASHELL_CONFIG', 'HUMAIN_CLI', 'SEASHELL_PACKAGE_ROOT', 'SEASHELL_MANAGED_BY'].flatMap((key) => environment[key]
      ? [`<key>${key}</key><string>${xml(environment[key]!)}</string>`]
      : []).join('\n    ')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>${RECORDER_PROCESS_TYPE}</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(resolved.logsDir, 'meeting-watch.jsonl'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(resolved.logsDir, 'meeting-watch.error.log'))}</string>
</dict>
</plist>
`;
}

function loaded(options: LaunchAtLoginOptions = {}): boolean {
  const runner = options.runner ?? spawnSync;
  const result = runner('launchctl', [
    'print',
    `${launchDomain(options)}/${SEASHELL_LAUNCH_AGENT_LABEL}`,
  ], { stdio: 'ignore' });
  return result.status === 0;
}

export function meetingLaunchAtLoginStatus(
  options: LaunchAtLoginOptions = {},
): LaunchAtLoginStatus {
  const resolved = paths(options);
  return Object.freeze({
    enabled: existsSync(resolved.plistPath),
    loaded: loaded(options),
    label: SEASHELL_LAUNCH_AGENT_LABEL,
    plistPath: resolved.plistPath,
    command: command(options),
  });
}

export function enableMeetingLaunchAtLogin(
  options: LaunchAtLoginOptions = {},
): LaunchAtLoginStatus {
  const resolved = paths(options);
  if (!existsSync(resolved.entrypoint)) throw new Error(`Sea Shell entrypoint is missing: ${resolved.entrypoint}`);
  prepareMeetingRuntimeHost(options.runtimeHost);
  mkdirSync(resolved.launchAgentsDir, { recursive: true, mode: 0o700 });
  mkdirSync(resolved.logsDir, { recursive: true, mode: 0o700 });
  for (const name of ['meeting-watch.jsonl', 'meeting-watch.error.log']) {
    const log = join(resolved.logsDir, name);
    closeSync(openSync(log, 'a', 0o600));
    chmodSync(log, 0o600);
  }
  const temporary = `${resolved.plistPath}.${process.pid}.tmp`;
  const runner = options.runner ?? spawnSync;
  const domain = launchDomain(options);
  let stoppedPreviousWatcher = false;
  try {
    writeFileSync(temporary, plist(options), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (loaded(options)) {
      const stopped = runner('launchctl', ['bootout', `${domain}/${SEASHELL_LAUNCH_AGENT_LABEL}`], { encoding: 'utf8' });
      if (stopped.error || stopped.status !== 0) {
        throw new Error(`Could not stop the previous meeting watcher: ${stopped.stderr?.trim() || stopped.error?.message || `exit ${stopped.status}`}`);
      }
      stoppedPreviousWatcher = true;
    }
    renameSync(temporary, resolved.plistPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const result = bootstrapAgent(options, resolved.plistPath, stoppedPreviousWatcher);
  if (result.error || result.status !== 0) {
    throw new Error(`Could not enable launch at login: ${launchctlFailure(result)}`);
  }
  return meetingLaunchAtLoginStatus(options);
}

type LaunchctlResult = ReturnType<typeof spawnSync>;

function launchctlFailure(result: LaunchctlResult): string {
  return String(result.stderr ?? '').trim() || result.error?.message || `exit ${result.status}`;
}

/** Bootstrap the agent. Replacing one just booted out, retry launchd's transient I/O error. */
function bootstrapAgent(options: LaunchAtLoginOptions, plistPath: string, replacing: boolean): LaunchctlResult {
  const runner = options.runner ?? spawnSync;
  const bootstrapArguments = ['bootstrap', launchDomain(options), plistPath];
  let result = runner('launchctl', bootstrapArguments, {
    encoding: 'utf8',
  });
  if (replacing && !result.error && result.status === 5) {
    // bootout can succeed before launchd has finished tearing down the job.
    // Only that replacement path warrants retrying its transient I/O error.
    const now = options.now ?? (() => performance.now());
    const wait = options.wait ?? ((milliseconds: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    });
    const deadline = now() + 10_000;
    for (let retries = 0; retries < 40 && !result.error && result.status === 5; retries++) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      wait(Math.min(250, remaining));
      const retryBudget = deadline - now();
      if (retryBudget <= 0) break;
      result = runner('launchctl', bootstrapArguments, {
        encoding: 'utf8', timeout: Math.max(1, Math.ceil(retryBudget)),
      });
    }
  }
  return result;
}

/** The plist this version writes, waiting beside the installed one for the reloader. */
const STAGED_SUFFIX = '.next';
/** Contents launchd would not take: never tried again, so a refusal cannot become a restart loop. */
const REFUSED_SUFFIX = '.next.refused';
/** The installed plist, kept until launchd has taken its replacement. */
const PREVIOUS_SUFFIX = '.previous';
/** Runs replaceMeetingLaunchAgent outside the login agent's job. */
export const LAUNCH_AGENT_RELOADER = join(PROJECT_ROOT, 'src', 'launch-agent-reload.ts');

/** How an installed plist schedules the recorder. */
function recorderScheduling(contents: string): { readonly processType?: string; readonly lowPriorityIO: boolean } {
  const processType = /<key>ProcessType<\/key>\s*<string>([^<]*)<\/string>/u.exec(contents)?.[1];
  return {
    ...(processType === undefined ? {} : { processType }),
    lowPriorityIO: /<key>LowPriorityIO<\/key>\s*<true\/>/u.test(contents),
  };
}

/**
 * Whether the installed login agent still schedules the recorder the way an
 * older version wrote it. launchd reads a plist only when it bootstraps the
 * job, so an upgraded recorder keeps running at Background priority until
 * its agent is reloaded with the plist this version writes.
 */
export function meetingLaunchAgentNeedsRefresh(options: LaunchAtLoginOptions = {}): boolean {
  const { plistPath } = paths(options);
  let installed: string;
  try { installed = readFileSync(plistPath, 'utf8'); } catch { return false; }
  const scheduling = recorderScheduling(installed);
  if (scheduling.processType === RECORDER_PROCESS_TYPE && !scheduling.lowPriorityIO) return false;
  try { return readFileSync(`${plistPath}${REFUSED_SUFFIX}`, 'utf8') !== plist(options); } catch { return true; }
}

export interface LaunchAgentRefreshOptions extends LaunchAtLoginOptions {
  /** Starts the reloader. Tests pass their own; nothing else may touch the real agent. */
  readonly spawnReloader?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** The program that runs the reloader: the runtime running this watcher. */
  readonly runtime?: string;
}

/**
 * Moves an upgraded install's login agent onto this version's plist, with the
 * restart that takes. The login agent calls this as it starts, before it
 * watches for calls, so no recording is open. The new plist is written beside
 * the old one, and a reloader takes it from there in a session of its own:
 * booting the job out ends this watcher and its process group, and the
 * reloader has to outlive both to bootstrap the new job.
 *
 * Undefined when the agent is already current. Otherwise resolves with the
 * reloader's exit status once it exits, which this watcher sees only if the
 * update did not take: launchd ends a watcher whose job is replaced first.
 */
export function refreshMeetingLaunchAgent(options: LaunchAgentRefreshOptions = {}): Promise<number | null> | undefined {
  if (!meetingLaunchAgentNeedsRefresh(options)) return undefined;
  const resolved = paths(options);
  const staged = `${resolved.plistPath}${STAGED_SUFFIX}`;
  writeFileSync(staged, plist(options), { encoding: 'utf8', mode: 0o600 });
  chmodSync(staged, 0o600);
  mkdirSync(resolved.logsDir, { recursive: true, mode: 0o700 });
  // What the reloader says lands where launchd puts the watcher's own errors.
  const log = openSync(join(resolved.logsDir, 'meeting-watch.error.log'), 'a', 0o600);
  let child: ChildProcess;
  try {
    child = (options.spawnReloader ?? spawn)(options.runtime ?? process.execPath,
      ['run', LAUNCH_AGENT_RELOADER, resolved.plistPath, String(options.uid ?? process.getuid?.() ?? 501)],
      { detached: true, stdio: ['ignore', log, log], env: options.environment ?? process.env });
  } finally { closeSync(log); }
  child.unref();
  return new Promise((resolveExit) => {
    child.once('error', () => resolveExit(null));
    child.once('exit', (code) => resolveExit(code));
  });
}

/**
 * How the watcher that started a refresh comes out of it: `stopped` when it
 * is being shut down (the reload took, or someone stopped it), `failed` when
 * the reloader exited, so the old agent keeps running, and `late` when the
 * reloader has not finished within the limit. Only `stopped` ends the watcher.
 */
export async function waitForMeetingLaunchAgentRefresh(refreshing: Promise<number | null>, signal: AbortSignal,
  limitMs = 30_000): Promise<'stopped' | 'failed' | 'late'> {
  if (signal.aborted) return 'stopped';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      refreshing.then(() => 'failed' as const),
      new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), limitMs); }),
      new Promise<'stopped'>((resolve) => { onAbort = () => resolve('stopped'); signal.addEventListener('abort', onAbort, { once: true }); }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The reloader's work: boot the old job out, put the staged plist in its
 * place and bootstrap it. If launchd will not take the new plist, the old one
 * goes back and is bootstrapped again, so an update never leaves the Mac
 * without its recorder, and those contents are not tried again.
 */
export function replaceMeetingLaunchAgent(options: LaunchAtLoginOptions = {}): LaunchAtLoginStatus {
  const resolved = paths(options);
  const staged = `${resolved.plistPath}${STAGED_SUFFIX}`;
  const previous = `${resolved.plistPath}${PREVIOUS_SUFFIX}`;
  const runner = options.runner ?? spawnSync;
  if (!existsSync(staged)) throw new Error(`No updated login settings at ${staged}`);
  let replacing = false;
  if (loaded(options)) {
    const stopped = runner('launchctl', ['bootout', `${launchDomain(options)}/${SEASHELL_LAUNCH_AGENT_LABEL}`], { encoding: 'utf8' });
    if (stopped.error || stopped.status !== 0) {
      rmSync(staged, { force: true });
      throw new Error(`Could not stop the meeting watcher: ${launchctlFailure(stopped)}`);
    }
    replacing = true;
  }
  const hadPrevious = existsSync(resolved.plistPath);
  if (hadPrevious) renameSync(resolved.plistPath, previous);
  const contents = readFileSync(staged, 'utf8');
  renameSync(staged, resolved.plistPath);
  const result = bootstrapAgent(options, resolved.plistPath, replacing);
  if (!result.error && result.status === 0) {
    rmSync(previous, { force: true });
    rmSync(`${resolved.plistPath}${REFUSED_SUFFIX}`, { force: true });
    return meetingLaunchAtLoginStatus(options);
  }
  const failure = launchctlFailure(result);
  writeFileSync(`${resolved.plistPath}${REFUSED_SUFFIX}`, contents, { encoding: 'utf8', mode: 0o600 });
  if (!hadPrevious) throw new Error(`Could not update the meeting watcher's login settings: ${failure}`);
  renameSync(previous, resolved.plistPath);
  const restored = bootstrapAgent(options, resolved.plistPath, true);
  throw new Error(`Could not update the meeting watcher's login settings: ${failure}. ${
    !restored.error && restored.status === 0 ? 'The previous settings are back in place.'
      : `The previous settings could not be started again either: ${launchctlFailure(restored)}`}`);
}

export function disableMeetingLaunchAtLogin(
  options: LaunchAtLoginOptions = {},
): LaunchAtLoginStatus {
  const resolved = paths(options);
  const runner = options.runner ?? spawnSync;
  if (loaded(options)) {
    const result = runner('launchctl', ['bootout', launchDomain(options), resolved.plistPath], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(`Could not stop the meeting watcher: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`);
    }
  }
  if (existsSync(resolved.plistPath)) rmSync(resolved.plistPath);
  return meetingLaunchAtLoginStatus(options);
}

/** The login agent's event log, and the older half kept when it is rotated. */
export function meetingWatchLogFiles(options: LaunchAtLoginOptions = {}): { path: string; rotatedPath: string } {
  const { logsDir } = paths(options);
  return { path: join(logsDir, 'meeting-watch.jsonl'), rotatedPath: join(logsDir, 'meeting-watch.1.jsonl') };
}

export function readMeetingWatchLog(options: LaunchAtLoginOptions = {}): string {
  const { path, rotatedPath } = meetingWatchLogFiles(options);
  return [rotatedPath, path].map((file) => existsSync(file) ? readFileSync(file, 'utf8') : '').join('');
}
