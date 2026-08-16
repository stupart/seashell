import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

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
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function paths(options: LaunchAtLoginOptions = {}) {
  const root = resolve(options.projectRoot ?? PROJECT_ROOT);
  const launchAgentsDir = resolve(options.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents'));
  const support = join(homedir(), 'Library', 'Application Support', 'Sea Shell');
  return {
    root,
    launchAgentsDir,
    plistPath: join(launchAgentsDir, `${SEASHELL_LAUNCH_AGENT_LABEL}.plist`),
    executable: join(root, 'seashell'),
    logsDir: join(support, 'Logs'),
  };
}

function launchDomain(options: LaunchAtLoginOptions): string {
  return `gui/${options.uid ?? process.getuid?.() ?? 501}`;
}

function command(options: LaunchAtLoginOptions = {}): readonly string[] {
  const resolved = paths(options);
  return Object.freeze([resolved.executable, 'meeting', 'watch', '--json']);
}

function plist(options: LaunchAtLoginOptions = {}): string {
  const resolved = paths(options);
  const path = [
    join(homedir(), '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
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
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
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
  if (!existsSync(resolved.executable)) throw new Error(`Sea Shell launcher is missing: ${resolved.executable}`);
  mkdirSync(resolved.launchAgentsDir, { recursive: true, mode: 0o700 });
  mkdirSync(resolved.logsDir, { recursive: true, mode: 0o700 });
  const temporary = `${resolved.plistPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, plist(options), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, resolved.plistPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const runner = options.runner ?? spawnSync;
  const domain = launchDomain(options);
  if (loaded(options)) runner('launchctl', ['bootout', domain, resolved.plistPath], { stdio: 'ignore' });
  const result = runner('launchctl', ['bootstrap', domain, resolved.plistPath], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not enable launch at login: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`);
  }
  return meetingLaunchAtLoginStatus(options);
}

export function disableMeetingLaunchAtLogin(
  options: LaunchAtLoginOptions = {},
): LaunchAtLoginStatus {
  const resolved = paths(options);
  const runner = options.runner ?? spawnSync;
  if (loaded(options)) {
    runner('launchctl', ['bootout', launchDomain(options), resolved.plistPath], { stdio: 'ignore' });
  }
  if (existsSync(resolved.plistPath)) rmSync(resolved.plistPath);
  return meetingLaunchAtLoginStatus(options);
}

export function readMeetingWatchLog(options: LaunchAtLoginOptions = {}): string {
  const path = join(paths(options).logsDir, 'meeting-watch.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
