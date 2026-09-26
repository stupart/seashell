import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface BackgroundAccessibilityProbe {
  state: 'permission' | 'idle' | 'unavailable';
  detail: string;
  accessibilityTrusted?: boolean;
}
interface BackgroundPermissionOptions {
  helperPath: string;
  bunPath?: string;
  requestPermission?: boolean;
  signal?: AbortSignal;
}
interface PermissionRuntime {
  platform?: string;
  uid?: number;
  tempRoot?: string;
  /** Test seam: no launchd registration or macOS permission prompts in unit tests. */
  launchctl?: (args: string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<void>;
  waitMs?: number;
}

function xml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

// Static script + separate argv prevents paths, labels or user data becoming code.
// launchd owns Bun, which owns the helper: the same TCC responsibility chain as
// background meeting watch. Running the helper directly from a trusted terminal
// would incorrectly report that the background watcher also has permission.
const RUNNER = `import { execFile } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
const [helper, mode, receipt] = process.argv.slice(2);
execFile(helper, [mode], { timeout: 2500, maxBuffer: 8192, encoding: 'utf8' }, (error, stdout) => {
  let result = { state: 'unavailable', detail: 'Could not check background Accessibility.' };
  if (!error) {
    try {
      const value = JSON.parse(stdout);
      if (value.state === 'idle' && value.accessibilityTrusted === true)
        result = { state: 'idle', detail: 'Background Accessibility is enabled.', accessibilityTrusted: true };
      else if (value.state === 'permission' && value.accessibilityTrusted === false)
        result = { state: 'permission', detail: 'Enable Accessibility for the Seashell background host shown by macOS, then check again.', accessibilityTrusted: false };
    } catch {}
  }
  try {
    writeFileSync(receipt + '.tmp', JSON.stringify(result), { mode: 0o600, flag: 'wx' });
    renameSync(receipt + '.tmp', receipt);
  } catch { process.exitCode = 1; }
});
`;

async function launchctl(args: string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('/bin/launchctl', args, { timeout: options.timeoutMs, maxBuffer: 8192, signal: options.signal },
      (error) => error ? reject(error) : resolve());
  });
}

function parseReceipt(path: string): BackgroundAccessibilityProbe | undefined {
  if (!existsSync(path)) return;
  if (statSync(path).size > 8192) throw new Error('Oversized permission receipt');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value?.state === 'idle' && value.accessibilityTrusted === true) return {
    state: 'idle', accessibilityTrusted: true, detail: 'Background Accessibility is enabled.',
  };
  if (value?.state === 'permission' && value.accessibilityTrusted === false) return {
    state: 'permission', accessibilityTrusted: false,
    detail: 'Enable Accessibility for the Seashell background host shown by macOS, then check again. A terminal permission alone does not enable background meeting detection.',
  };
  if (value?.state === 'unavailable') return { state: 'unavailable', detail: 'Could not check background Accessibility.' };
  throw new Error('Invalid permission receipt');
}

/** A temporary, one-shot background check. Only explicit requestPermission asks
 * macOS to show its permission prompt. It never changes recording/launch-at-login
 * settings, edits TCC, or touches the existing meeting watcher LaunchAgent. */
export async function probeBackgroundMeetingAccessibility(
  options: BackgroundPermissionOptions,
  runtime: PermissionRuntime = {},
): Promise<BackgroundAccessibilityProbe> {
  const unavailable = (detail: string): BackgroundAccessibilityProbe => ({ state: 'unavailable', detail });
  if ((runtime.platform ?? process.platform) !== 'darwin') return unavailable('Background Accessibility requires macOS.');
  if (options.signal?.aborted) return unavailable('Background Accessibility check cancelled.');
  const bun = options.bunPath ?? process.execPath;
  const uid = runtime.uid ?? process.getuid?.();
  if (!isAbsolute(bun) || !isAbsolute(options.helperPath) || uid === undefined || !Number.isInteger(uid) || uid < 0) {
    return unavailable('Could not locate the Seashell background host.');
  }
  const run = runtime.launchctl ?? launchctl;
  const domain = `gui/${uid}`;
  const label = `com.humain.seashell.accessibility-check.${randomUUID()}`;
  let directory: string | undefined;
  let attemptedBootstrap = false;
  const deadline = performance.now() + Math.min(runtime.waitMs ?? 3800, 3800);
  try {
    directory = mkdtempSync(join(runtime.tempRoot ?? tmpdir(), 'seashell-accessibility-'));
    chmodSync(directory, 0o700);
    const script = join(directory, 'probe.mjs');
    const receipt = join(directory, 'result.json');
    const plist = join(directory, 'agent.plist');
    const mode = options.requestPermission === true ? '--request-permission' : '--check-permission';
    writeFileSync(script, RUNNER, { mode: 0o600, flag: 'wx' });
    const args = [bun, script, options.helperPath, mode, receipt];
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>AbandonProcessGroup</key><false/>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`, { mode: 0o600, flag: 'wx' });
    attemptedBootstrap = true;
    await run(['bootstrap', domain, plist], { timeoutMs: 1000, signal: options.signal });
    while (performance.now() < deadline) {
      if (options.signal?.aborted) return unavailable('Background Accessibility check cancelled.');
      const result = parseReceipt(receipt);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return unavailable('Background Accessibility check timed out. Try the connection check again.');
  } catch {
    return unavailable(options.signal?.aborted ? 'Background Accessibility check cancelled.' : 'Could not run the background Accessibility check.');
  } finally {
    if (attemptedBootstrap) {
      // Do not pass the cancelled signal: cleanup must still remove our own job.
      try { await run(['bootout', `${domain}/${label}`], { timeoutMs: 1000 }); } catch {}
    }
    if (directory) {
      try { rmSync(directory, { recursive: true, force: true }); } catch {}
    }
  }
}
