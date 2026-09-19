import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorChecks } from '../src/cli-runtime.ts';
import { readMeetingSignalSnapshot } from '../src/meeting-automation.ts';

function withStuckHelper(run: (helper: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'seashell-stuck-diagnostic-'));
  const helper = join(root, 'helper');
  writeFileSync(helper, `#!/bin/sh
[ "$1" = --warm ] && exit 0
trap '' TERM
echo ready > '${join(root, 'ready')}'
# exec inherits the ignored signal. Self-exit bounds a failing reproduction.
exec /bin/sleep 2
`, { mode: 0o700 });
  try {
    // First execution can spend time in macOS executable validation. Ensure the
    // timeout exercises an initialized helper with its signal handler active.
    expect(spawnSync(helper, ['--warm'], { timeout: 5000, killSignal: 'SIGKILL' }).status).toBe(0);
    run(helper, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('doctor bounds a native audio probe that ignores SIGTERM', () => {
  withStuckHelper((helper, root) => {
    const started = performance.now();
    const checks = doctorChecks({ systemAudioHelper: helper,
      meetingSignalsHelper: join(root, 'missing'), systemAudioProbeTimeoutMs: 250 });
    expect(existsSync(join(root, 'ready'))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(checks.find((check) => check.name === 'system-audio-probe')?.ok).toBe(false);
    expect(checks.find((check) => check.name === 'system-audio-probe')?.help).toContain('timed out');
  });
});

test('meeting signal inspection bounds an unresponsive native helper', () => {
  withStuckHelper((helper, root) => {
    const started = performance.now();
    expect(() => readMeetingSignalSnapshot(helper, 250)).toThrow('Could not inspect meeting signals');
    expect(existsSync(join(root, 'ready'))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
