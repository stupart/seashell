import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { meetingRuntimeHostPath } from './runtime-host.ts';

interface RegistrationOptions {
  plistPath?: string;
  hostPath?: string;
  runner?: typeof spawnSync;
}

/** Inspect the existing registration without changing it or interrupting capture.
 * Granting the new host access alone cannot migrate a running legacy watcher. */
export function meetingHostRegistrationWarning(options: RegistrationOptions = {}): string | undefined {
  const plistPath = options.plistPath ?? join(homedir(), 'Library', 'LaunchAgents', 'com.humain.seashell.meeting-watch.plist');
  if (!existsSync(plistPath)) return;
  const result = (options.runner ?? spawnSync)('/usr/bin/plutil',
    ['-extract', 'ProgramArguments.0', 'raw', '-o', '-', plistPath],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 8192 });
  if (result.status === 0 && result.stdout?.trim() === (options.hostPath ?? meetingRuntimeHostPath())) return;
  return 'The registered background watcher needs the stable permission host. After any recording finishes, run seashell meeting autostart enable, then check the connection again.';
}
