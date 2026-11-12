import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import type { MicrophonePermissionStatus } from '../src/microphone-permission.ts';
import {
  MICROPHONE_START_NOTICES, MICROPHONE_UPDATE_NOTICE, microphoneAllowedBefore, microphoneStartNotifier, microphoneUpdateNotice,
} from '../src/microphone-permission.ts';
import { readFeatureStatuses } from '../src/feature-status.ts';
import { ALLOW_MIC, recordingSummary } from '../src/RecordingStatus.tsx';
import type { CaptureHealthSnapshot } from '../src/capture-health.ts';

test('launched with the microphone undecided, Enter asks for it', async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/tui-microphone-permission.tsx', import.meta.url))],
    { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Microphone permission UI fixture: ${error}`);
    expect(out.trim().split('\n').at(-1)).toBe(JSON.stringify({ passed: true }));
  } finally { clearTimeout(timeout); child.kill(); }
}, 25_000);

test('a recording whose microphone macOS has not allowed says "Mic not allowed · Enter to allow"', () => {
  const now = Date.now();
  const health: CaptureHealthSnapshot = { schemaVersion: 1, updatedAtUnixMs: now,
    microphone: { state: 'unavailable', updatedAtUnixMs: now, code: 'microphone_permission', message: 'Microphone access is off for Seashell Microphone.',
      warnings: [{ kind: 'unavailable', message: 'Microphone access is off.', firstAtUnixMs: now, lastAtUnixMs: now }] },
    systemAudio: { state: 'receiving', updatedAtUnixMs: now, lastPcmAtUnixMs: now, lastSignalAtUnixMs: now, warnings: [] } };
  const summary = recordingSummary({ mode: 'recording', health, elapsedSeconds: 30, nowUnixMs: now });
  expect(summary.alert).toEqual({ text: 'Mic not allowed', fix: ALLOW_MIC, color: 'red' });
  expect(summary.problems[0]).toBe('Microphone: not allowed · Enter to allow');
});

test('the login agent says once per recording, as it starts, that the microphone is not allowed', async () => {
  const said: string[] = [];
  const answers: Record<string, MicrophonePermissionStatus['authorization']> = { a: 'notDetermined', b: 'authorized', c: 'denied' };
  let session = 'a';
  let checks = 0;
  const notice = microphoneStartNotifier((message) => said.push(message),
    async () => { checks++; return { authorization: answers[session]!, detail: 'Fixture.' }; });
  for (const [type, id] of [['meeting.started', 'a'], ['meeting.resumed', 'a'], ['meeting.started', 'a'], ['meeting.started', 'b'], ['meeting.started', 'c']] as const) {
    session = id;
    notice({ type, sessionId: id });
    await Bun.sleep(0);
  }
  expect(checks).toBe(3);
  expect(said).toEqual([MICROPHONE_START_NOTICES.notDetermined, MICROPHONE_START_NOTICES.denied]);
});

test('after an update replaced Seashell Microphone, the login agent asks once at its start, never on a first install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-mic-update-'));
  const env = { SEASHELL_CONFIG: join(root, 'config.json') };
  const copy = join(root, 'Seashell Microphone');
  let authorization: MicrophonePermissionStatus['authorization'] = 'notDetermined';
  const check = async (): Promise<MicrophonePermissionStatus> => ({ authorization, detail: 'Fixture.', executable: copy });
  const install = (bytes: string) => { rmSync(copy, { force: true }); writeFileSync(copy, bytes); };
  try {
    // A first install that was never allowed: nothing was allowed before, so not "again".
    install('copy one');
    expect(await microphoneUpdateNotice({ env, check })).toBeUndefined();
    expect(microphoneAllowedBefore(env)).toBe(false);
    authorization = 'authorized';
    expect(await microphoneUpdateNotice({ env, check })).toBeUndefined();
    // Allowed once: a copy macOS has not decided on is one needing your OK again.
    expect(microphoneAllowedBefore(env)).toBe(true);
    // An update replaces the copy, and macOS has not decided on it.
    install('copy two, a new protocol');
    authorization = 'notDetermined';
    expect(await microphoneUpdateNotice({ env, check })).toBe(MICROPHONE_UPDATE_NOTICE);
    // Once per copy, however often the agent restarts.
    expect(await microphoneUpdateNotice({ env, check })).toBeUndefined();
    // Denied is answered: macOS will not ask mid-call, and the recording notice covers it.
    install('copy three');
    authorization = 'denied';
    expect(await microphoneUpdateNotice({ env, check })).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a microphone allowed before an update "needs your OK again"; one never allowed is "not allowed yet"', async () => {
  const microphone = async () => ({ authorization: 'notDetermined' as const, detail: 'Fixture.' });
  const read = async (allowedBefore: boolean) => (await readFeatureStatuses({ config: {}, libraryDir: mkdtempSync(join(tmpdir(), 'seashell-mic-status-')),
    dependencies: { microphone, microphoneAllowedBefore: () => allowedBefore, launchAtLogin: () => ({ enabled: true, loaded: true, label: 'f', plistPath: '/f', command: [] }),
      aiEngineInstalled: () => false, transcriptionReady: () => true, systemAudioHelperReady: () => true, speakerSeparationReady: () => true } } as never))
    .find((status) => status.id === 'microphone')!;
  expect(await read(true)).toMatchObject({ state: 'broken', summary: 'Needs your OK again after the update', action: 'allow-microphone' });
  expect(await read(false)).toMatchObject({ state: 'broken', summary: 'Not allowed yet', action: 'allow-microphone' });
  // Said in the app, so no command.
  expect(`${(await read(true)).detail} ${(await read(true)).fix}`).not.toContain('seashell');
});
