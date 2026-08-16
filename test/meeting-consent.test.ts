import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { consumeMeetingConsent, writeMeetingConsent } from '../src/meeting-consent.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('meeting consent is private, short-lived, and consumed exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-consent-'));
  roots.push(root);
  const path = join(root, 'consent.json');
  writeMeetingConsent('approve', path, 1_000);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(consumeMeetingConsent(path, 2_000)).toBe('approve');
  expect(existsSync(path)).toBe(false);
  expect(consumeMeetingConsent(path, 2_000)).toBeUndefined();
});

test('stale consent cannot approve a later meeting', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-consent-'));
  roots.push(root);
  const path = join(root, 'consent.json');
  writeMeetingConsent('approve', path, 1_000);
  expect(consumeMeetingConsent(path, 122_000, 120_000)).toBeUndefined();
  expect(existsSync(path)).toBe(false);
});
