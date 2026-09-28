import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMeetAccessibilityProbe, probeMeetAccessibility, probeMeetSpeakers, meetSpeakerForSegment, type MeetSample } from '../src/meet-speakers.ts';

const snapshot = { meeting: '/abc-defg-hij', joined: true, participants: [
  { id: 'alice', name: 'Alice', self: false, speaking: true },
] };
const connected = { state: 'connected', detail: 'Meet connected', browser: 'chrome', snapshot };


test('native boundary accepts validated accessibility provenance, rejects contradictory call and permission states', () => {
  expect(parseMeetAccessibilityProbe(connected)).toMatchObject({ ...connected, source: 'google-meet-accessibility' });
  for (const raw of [null, {}, { ...connected, snapshot: { ...snapshot, meeting: '/other' } },
    { ...connected, browser: undefined }, { ...connected, state: 'idle' },
    { ...connected, state: 'permission' }, { ...connected, state: 'ambiguous' },
    { ...connected, accessibilityTrusted: false },
    { state: 'permission', detail: 'Denied', accessibilityTrusted: true },
    { state: 'permission', detail: 'Denied', absenceConfirmed: true },
    { ...connected, accessibilityTrusted: 'yes' }, { ...connected, absenceConfirmed: 'yes' },
    { ...connected, detail: '\u001b' }]) {
    const probe = parseMeetAccessibilityProbe(raw);
    expect(probe.state).toBe('unavailable');
    expect(probe.snapshot).toBeUndefined();
    expect(probe.detail).toContain('Meeting detection and speaker names are unavailable');
    expect(probe.detail).not.toContain('recording');
  }
  expect(parseMeetAccessibilityProbe({ state: 'idle', detail: 'No browser', absenceConfirmed: true }))
    .toMatchObject({ state: 'idle', absenceConfirmed: true });
});

test('failed injected browser checks do not claim audio is recording', async () => {
  const result = await probeMeetSpeakers('chrome', undefined, async () => { throw new Error('reader failed'); });
  expect(result.state).toBe('unavailable');
  expect(result.detail).toContain('Chrome meeting detection and speaker names are unavailable');
  expect(result.detail).not.toContain('recording');
});

test.skipIf(process.platform !== 'darwin')('native timeout, process failure and malformed output do not claim recording or infer permission denial', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-ax-errors-'));
  const helperPath = join(root, 'probe');
  try {
    for (const script of [
      '#!/bin/sh\nexec /bin/sleep 10\n',
      '#!/bin/sh\nprintf "permission denied" >&2\nexit 1\n',
      '#!/bin/sh\nprintf "invalid json"\n',
    ]) {
      writeFileSync(helperPath, script, { mode: 0o700 });
      const result = await probeMeetAccessibility('auto', undefined, { helperPath });
      expect(result).toEqual({ state: 'unavailable', detail: 'Meeting detection and speaker names could not be checked. Check [V] Speakers.' });
      expect(result.detail).not.toContain('recording');
      expect(result.accessibilityTrusted).toBeUndefined();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native speaker provenance survives attribution and never bridges legacy evidence', () => {
  const sample: MeetSample = { at: 0, meeting: snapshot.meeting, browser: 'chrome', source: 'google-meet-accessibility',
    speaker: { id: 'MEET_aaaaaaaaaaaaaaaaaaaa', label: 'Alice' } };
  expect(meetSpeakerForSegment([sample, { ...sample, at: .5 }, { ...sample, at: 1 }], { start: .1, end: .9 }))
    .toMatchObject({ label: 'Alice', source: 'google-meet-accessibility' });
  expect(meetSpeakerForSegment([sample, { ...sample, at: 1, source: undefined }], { start: .1, end: .9 })).toBeUndefined();
});

test.skipIf(process.platform !== 'darwin')('native subprocess probes never request permission; explicit setup does; cancellation kills blocked reader', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-ax-'));
  const helperPath = join(root, 'probe');
  const argsPath = join(root, 'args');
  // Fixed test paths are shell-quoted; no external data is executed.
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  try {
    writeFileSync(helperPath, '#!/bin/sh\nprintf "%s\\n" "$@" > ' + quote(argsPath) + '\nprintf "%s" ' + quote(JSON.stringify(connected)) + '\n');
    chmodSync(helperPath, 0o700);
    expect((await probeMeetAccessibility('auto', undefined, { helperPath })).state).toBe('connected');
    expect(await Bun.file(argsPath).text()).toBe('--browser\nauto\n');
    await probeMeetAccessibility('chrome', undefined, { helperPath, requestPermission: true });
    expect(await Bun.file(argsPath).text()).toBe('--browser\nchrome\n--request-permission\n');
    writeFileSync(helperPath, '#!/bin/sh\nexec /bin/sleep 10\n');
    const controller = new AbortController();
    const pending = probeMeetAccessibility('auto', controller.signal, { helperPath });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('cancelled');
    // Missing helpers must not fall back to browser scripting or trigger permission UI.
    expect((await probeMeetAccessibility('auto', undefined, { helperPath: join(root, 'absent') })).state).toBe('unavailable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
