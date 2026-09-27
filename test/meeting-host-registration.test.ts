import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meetingHostRegistrationWarning } from '../src/meeting-host-registration.ts';

test('connection checks distinguish old and stable background permission owners without changing registration', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-host-registration-'));
  const plistPath = join(root, 'watch.plist');
  const hostPath = join(root, 'Sea Shell', 'Runtime', 'bun');
  try {
    expect(meetingHostRegistrationWarning({ plistPath, hostPath })).toBeUndefined();
    for (const [command, needsMigration] of [['/opt/homebrew/opt/seashell/libexec/seashell', true], [hostPath, false]] as const) {
      writeFileSync(plistPath, `<?xml version="1.0"?><plist version="1.0"><dict><key>ProgramArguments</key><array><string>${command}</string><string>run</string></array></dict></plist>`);
      expect(Boolean(meetingHostRegistrationWarning({ plistPath, hostPath }))).toBe(needsMigration);
    }
    writeFileSync(plistPath, 'corrupt registration');
    expect(meetingHostRegistrationWarning({ plistPath, hostPath })).toContain('After any recording finishes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
