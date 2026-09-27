import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBackgroundWatchStatus, writeBackgroundWatchStatus } from '../src/background-watch-status.ts';
import { consumeMeetingConsent, writeMeetingConsent } from '../src/meeting-consent.ts';

test('watcher status separates waiting for approval from recording, and never trusts dead/stale evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-watch-status-'));
  try {
    expect(readBackgroundWatchStatus(root)).toBeUndefined();
    const waiting = { phase: 'awaiting-consent' as const, candidate: { id: 'audio:safari', title: 'Safari meeting', appName: 'Safari' }, consentId: 'call-one' };
    writeBackgroundWatchStatus(root, waiting, 1000);
    expect(readBackgroundWatchStatus(root, { nowUnixMs: 1000 })?.phase).toBe('awaiting-consent');
    expect(statSync(join(root, '.background-watch.json')).mode & 0o777).toBe(0o600);
    expect(readBackgroundWatchStatus(root, { nowUnixMs: 31_001 })?.phase).toBe('unavailable');
    expect(readBackgroundWatchStatus(root, { nowUnixMs: 1000, isAlive: () => false })?.consentId).toBeUndefined();
    writeBackgroundWatchStatus(root, { phase: 'recording', sessionId: 'call-one' }, 2000);
    expect(readBackgroundWatchStatus(root, { nowUnixMs: 2000 })?.phase).toBe('recording');
    const v = JSON.parse(readFileSync(join(root, '.background-watch.json'), 'utf8'));
    v.candidate = { id: 'bad\u001b', title: 'Call', appName: 'Browser' };
    writeFileSync(join(root, '.background-watch.json'), JSON.stringify(v));
    expect(readBackgroundWatchStatus(root, { nowUnixMs: 2000 })).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a TUI approval cannot leak into a later suggestion from the same browser', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-scoped-consent-'));
  const path = join(root, 'consent.json');
  try {
    writeMeetingConsent('approve', path, 1000, 'first-suggestion');
    expect(consumeMeetingConsent(path, 1100, 120000, 'second-suggestion')).toBeUndefined();
    writeMeetingConsent('approve', path, 1000, 'second-suggestion');
    expect(consumeMeetingConsent(path, 1100, 120000, 'second-suggestion')).toBe('approve');
    writeMeetingConsent('approve', path, 1000);
    expect(consumeMeetingConsent(path, 1100, 120000, 'second-suggestion')).toBe('approve');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
