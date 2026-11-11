import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { ensureTemplatesDirectory, PROFILE_FILE } from '../src/meeting-templates.ts';
import { readFeatureStatuses, renderFeatureStatusTable, type FeatureStatusDependencies, type MeetingEvidence } from '../src/feature-status.ts';
import type { MeetProbe } from '../src/meet-speakers.ts';
import { meetingWhen } from '../src/tui-state.ts';

const meeting = (overrides: Partial<MeetingEvidence> = {}): MeetingEvidence => ({
  title: 'Weekly sync', createdAt: '2026-01-15T10:00:00.000Z', microphoneChunks: 10, audibleMicrophoneChunks: 0,
  computerChunks: 10, audibleComputerChunks: 9, meetingKey: 'meet:safari:/abc-defg-hij', ...overrides,
});
const healthy: FeatureStatusDependencies = {
  launchAtLogin: () => ({ enabled: true, loaded: true, label: 'fixture', plistPath: '/fixture', command: [] }),
  watchStatus: () => ({ schemaVersion: 1, phase: 'watching', pid: 1, updatedAtUnixMs: 0 }),
  meetConnection: async () => ({ state: 'idle', detail: 'Join a call', accessibilityTrusted: true }),
  microphone: async () => ({ authorization: 'authorized', detail: 'Allowed.' }),
  lastMeeting: () => meeting({ audibleMicrophoneChunks: 8 }),
  speakerSeparationReady: () => false, aiEngineInstalled: () => true,
  transcriptionReady: () => true, systemAudioHelperReady: () => true,
  microphoneRecorderSince: () => Date.parse('2026-01-01T00:00:00Z'),
  systemAudioRecorderSince: () => Date.parse('2026-01-01T00:00:00Z'),
  audioChecks: () => ({}),
  screenRecording: async () => ({ authorization: 'authorized', detail: 'Allowed.' }),
  voices: () => [],
};
const read = (dependencies: FeatureStatusDependencies, meetingConfig: Record<string, unknown> = { speakerBrowser: 'auto' }) =>
  readFeatureStatuses({ config: { meeting: meetingConfig } as never, libraryDir: '/fixture', dependencies: { ...healthy, ...dependencies } });
const byId = async (...args: Parameters<typeof read>) => Object.fromEntries((await read(...args)).map(status => [status.id, status]));

test('a healthy Mac reports every required feature as working, without prompting', async () => {
  const statuses = await read({});
  expect(statuses.filter(status => !status.optional).map(status => [status.id, status.state])).toEqual([
    ['recorder', 'ok'], ['detection', 'ok'], ['microphone', 'ok'], ['computer-audio', 'ok'], ['transcription', 'ok'],
  ]);
  expect(statuses.find(status => status.id === 'meet-names')).toMatchObject({ state: 'attention', summary: 'Chrome only · you used Safari' });
});

test('detection separates missing permission from a call that is only out of sight', async () => {
  const hidden: MeetProbe = { state: 'unavailable', detail: 'Browser windows are on another desktop or in full screen.', accessibilityTrusted: true };
  expect((await byId({ meetConnection: async () => hidden })).detection).toMatchObject({ state: 'ok' });
  expect((await byId({ meetConnection: async () => hidden })).detection!.detail).toContain('another desktop');
  const denied = await byId({ meetConnection: async () => ({ state: 'permission', detail: 'Background access missing.' }) });
  expect(denied.detection).toMatchObject({ state: 'broken', action: 'connect-meet', command: 'seashell meeting speakers setup' });
  expect((await byId({}, {})).detection).toMatchObject({ state: 'attention', summary: 'Google Meet not connected' });
});

test('a few audible moments in a long call do not count as hearing you', async () => {
  // Shaped like the call that lost its microphone: 2 audible chunks of 681 while the others talked for 70 minutes.
  const oneSided = meeting({ microphoneChunks: 681, audibleMicrophoneChunks: 2, computerChunks: 680, audibleComputerChunks: 425,
    coverage: { yourSideAudibleSeconds: 20, otherSideAudibleSeconds: 4250, yourSideAudibleShare: 0.005, yourSideMissing: true } });
  const after = await byId({ lastMeeting: () => oneSided });
  expect(after.microphone).toMatchObject({ state: 'attention', summary: 'Allowed · your side almost silent' });
  // Written in local time the way the meetings list writes it, by the same formatter.
  expect(after.microphone!.detail).toBe('Your side was almost silent in "Weekly sync" (' + meetingWhen('2026-01-15T10:00:00.000Z') +
    '). The others talked for about 71 minutes, but your microphone picked up almost nothing.');
  expect(after.microphone!.fix).toContain('not muted');
  expect(after.microphone!.fix).toContain('Sound → Input');
  // Recorded before this recorder was installed: already explained as fixed.
  const before = await byId({ lastMeeting: () => oneSided, microphoneRecorderSince: () => Date.parse('2026-02-01T00:00:00Z') });
  expect(before.microphone).toMatchObject({ state: 'ok' });
  const heard = await byId({ lastMeeting: () => meeting({ audibleMicrophoneChunks: 8,
    coverage: { yourSideAudibleSeconds: 80, otherSideAudibleSeconds: 90, yourSideMissing: false } }) });
  expect(heard.microphone).toMatchObject({ state: 'ok', summary: 'Heard in last meeting' });
});

test('microphone status uses permission first, then what the last meeting heard', async () => {
  expect((await byId({ microphone: async () => ({ authorization: 'notDetermined', detail: '' }) })).microphone)
    .toMatchObject({ state: 'broken', action: 'allow-microphone' });
  // Silent before the native recorder existed: expected, nothing to do.
  const before = await byId({ lastMeeting: () => meeting(), microphoneRecorderSince: () => Date.parse('2026-02-01T00:00:00Z') });
  expect(before.microphone).toMatchObject({ state: 'ok', summary: 'Allowed · your next meeting confirms it' });
  // Silent after it: a real problem worth fixing.
  const after = await byId({ lastMeeting: () => meeting() });
  expect(after.microphone).toMatchObject({ state: 'attention', summary: 'Allowed · last meeting silent' });
  expect(after.microphone!.fix).toContain('Sound → Input');
});

test('a check the guided setup passed still counts after a restart, until something newer says otherwise', async () => {
  const silent = meeting({ audibleComputerChunks: 0 });
  // The meeting was silent; the setup heard both sources afterwards.
  const later = { microphone: '2026-01-16T09:00:00.000Z', computer: '2026-01-16T09:01:00.000Z' };
  const heard = await byId({ lastMeeting: () => silent, audioChecks: () => later });
  expect(heard['computer-audio']).toMatchObject({ state: 'ok', summary: 'Heard during setup' });
  expect(heard.microphone).toMatchObject({ state: 'ok', summary: 'Heard during setup' });
  expect(heard['computer-audio']!.detail).toContain('The check heard your Mac through Seashell System Audio');
  expect(heard['computer-audio']!.action).toBeUndefined();
  // A meeting after the check is the newer evidence.
  const earlier = { microphone: '2026-01-14T09:00:00.000Z', computer: '2026-01-14T09:01:00.000Z' };
  const after = await byId({ lastMeeting: () => silent, audioChecks: () => earlier });
  expect(after['computer-audio']).toMatchObject({ state: 'attention', summary: 'Silent in last meeting' });
  expect(after['computer-audio']).toMatchObject({ action: 'check-computer-audio' });
  expect(after['computer-audio']!.fix).toBe('Press Enter so Seashell hears computer audio directly.');
  expect(after.microphone).toMatchObject({ state: 'attention', summary: 'Allowed · last meeting silent' });
  // With no meeting yet, a passed check is all the proof there is.
  const fresh = await byId({ lastMeeting: () => undefined, audioChecks: () => ({ computer: later.computer }) });
  expect(fresh['computer-audio']).toMatchObject({ state: 'ok', summary: 'Heard during setup' });
  expect((await byId({ lastMeeting: () => undefined }))['computer-audio']).toMatchObject({ state: 'attention', summary: 'Not confirmed yet' });
  // A helper installed after the check is another identity to macOS: test again.
  const replaced = await byId({ lastMeeting: () => undefined, audioChecks: () => ({ computer: later.computer }),
    systemAudioRecorderSince: () => Date.parse('2026-02-01T00:00:00Z') });
  expect(replaced['computer-audio']).toMatchObject({ state: 'attention', summary: 'Not confirmed yet' });
});

test('meetings heard with the inherited permission still count, and the check to switch stays on offer', async () => {
  const since = () => Date.parse('2026-02-01T00:00:00Z');
  // Recorded before the helper had its own identity: the recorder still uses that permission, so it counts.
  const old = await byId({ lastMeeting: () => meeting(), systemAudioRecorderSince: since });
  expect(old['computer-audio']).toMatchObject({ state: 'ok', summary: 'Heard in last meeting', action: 'check-computer-audio',
    command: 'seashell meeting computer-audio setup' });
  expect(old['computer-audio']!.fix).toBe('Press Enter so Seashell hears computer audio directly.');
  // Confirmed at the Mac: nothing left to check.
  const tested = await byId({ lastMeeting: () => meeting(), systemAudioRecorderSince: since,
    audioChecks: () => ({ computer: '2026-02-02T09:00:00.000Z' }) });
  expect(tested['computer-audio']).toMatchObject({ state: 'ok', summary: 'Heard in last meeting' });
  expect(tested['computer-audio']!.detail).toContain('It records with Seashell System Audio.');
  expect(tested['computer-audio']!.action).toBeUndefined();
  expect((await byId({}))['computer-audio']).toMatchObject({ state: 'ok', summary: 'Heard in last meeting' });
});

test('passed checks are kept beside the settings file and read back', async () => {
  const { readAudioChecks, rememberAudioCheck, audioChecksPath } = await import('../src/audio-checks.ts');
  const root = mkdtempSync(join(tmpdir(), 'seashell-audio-checks-'));
  const env = { SEASHELL_CONFIG: join(root, 'settings', 'config.json') };
  try {
    expect(readAudioChecks(env)).toEqual({});
    rememberAudioCheck('computer', new Date('2026-03-01T10:00:00Z'), env);
    rememberAudioCheck('microphone', new Date('2026-03-01T10:01:00Z'), env);
    expect(audioChecksPath(env)).toBe(join(root, 'settings', 'audio-checks.json'));
    expect(readAudioChecks(env)).toEqual({ computer: '2026-03-01T10:00:00.000Z', microphone: '2026-03-01T10:01:00.000Z' });
    expect(statSync(audioChecksPath(env)).mode & 0o777).toBe(0o600);
    writeFileSync(audioChecksPath(env), '{"schemaVersion":1,"computer":"not a time"}');
    expect(readAudioChecks(env)).toEqual({});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a stopped recorder and missing optional setup each name their one next step', async () => {
  const statuses = await byId({ launchAtLogin: () => ({ enabled: false, loaded: false, label: '', plistPath: '', command: [] }), aiEngineInstalled: () => false });
  expect(statuses.recorder).toMatchObject({ state: 'broken', action: 'enable-recorder', command: 'seashell meeting autostart enable' });
  expect(statuses['ai-notes']).toMatchObject({ state: 'off', summary: 'Not installed' });
  expect(statuses['speaker-separation']).toMatchObject({ state: 'off', command: 'seashell setup --speakers --login' });
  expect(statuses.calendar).toMatchObject({ state: 'off', action: 'allow-calendar', command: 'seashell meeting calendar setup' });
});

test('the terminal table groups optional features and shows a command for anything not working', async () => {
  const table = renderFeatureStatusTable(await read({ microphone: async () => ({ authorization: 'notDetermined', detail: '' }) }));
  expect(table).toContain('✗ Your microphone');
  expect(table).toContain('→ Choose Allow when macOS asks. (seashell meeting microphone setup)');
  expect(table.indexOf('Optional')).toBeGreaterThan(table.indexOf('Transcription'));
  expect(table).not.toContain('Press Enter');
});

test('calendar titles report access and whether this Mac has any calendars to read', async () => {
  const on = { speakerBrowser: 'auto', calendar: { enabled: true, policy: 'ask' } };
  let asked = 0;
  const calendar = (authorization: 'authorized' | 'notDetermined', calendars?: number) => async () => {
    asked++; return { authorization, detail: 'fixture', ...(calendars === undefined ? {} : { calendars }) };
  };
  expect((await byId({ calendar: calendar('authorized', 3) }, { speakerBrowser: 'auto' })).calendar).toMatchObject({ state: 'off' });
  expect(asked).toBe(0);
  expect((await byId({ calendar: calendar('notDetermined') }, on)).calendar).toMatchObject({ state: 'attention', action: 'allow-calendar' });
  expect((await byId({ calendar: calendar('authorized', 0) }, on)).calendar).toMatchObject({ summary: 'On · no calendars on this Mac' });
  expect((await byId({ calendar: calendar('authorized', 2) }, on)).calendar).toMatchObject({ state: 'ok', summary: 'On' });
});

test('Settings shows whether templates are yours and whether the AI knows who you are', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seashell-templates-status-'));
  const libraryDir = join(home, 'Transcripts');
  const previous = process.env.SEASHELL_TEMPLATES_DIR;
  process.env.SEASHELL_TEMPLATES_DIR = join(home, 'Templates');
  try {
    const row = async () => (await readFeatureStatuses({ config: { meeting: { speakerBrowser: 'auto' } } as never, libraryDir, dependencies: healthy }))
      .find((status) => status.id === 'notes-templates')!;
    expect(await row()).toMatchObject({ state: 'off', summary: '6 built in', action: 'open-templates' });
    const directory = ensureTemplatesDirectory(libraryDir);
    expect(await row()).toMatchObject({ state: 'attention', summary: '6 templates · About me empty' });
    writeFileSync(join(directory, PROFILE_FILE), 'I run a studio.');
    expect(await row()).toMatchObject({ state: 'ok', summary: '6 templates · About me set' });
  } finally {
    if (previous === undefined) delete process.env.SEASHELL_TEMPLATES_DIR;
    else process.env.SEASHELL_TEMPLATES_DIR = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('video says whether it is on and whether macOS lets it record, asking only while it is on', async () => {
  let asked = 0;
  const screen = (authorization: 'authorized' | 'notDetermined' | 'unavailable') => async () => { asked++; return { authorization, detail: 'fixture' }; };
  expect((await byId({ screenRecording: screen('authorized') }, { speakerBrowser: 'auto', video: { enabled: false } })).video)
    .toMatchObject({ state: 'off', summary: 'Off · calls record audio only', action: 'turn-on-video' });
  expect(asked).toBe(0);
  // Video is on unless turned off.
  expect((await byId({ screenRecording: screen('authorized') })).video).toMatchObject({ state: 'ok', summary: 'On · Screen Recording allowed' });
  expect((await byId({ screenRecording: screen('notDetermined') })).video)
    .toMatchObject({ state: 'attention', summary: 'On · needs Screen Recording', action: 'allow-screen-recording' });
  expect((await byId({ screenRecording: screen('unavailable') })).video).toMatchObject({ state: 'attention', summary: 'On · video recorder missing' });
});

test('saved voices, prompts, extractors and automations each say how they stand', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seashell-files-status-'));
  const libraryDir = join(home, 'Transcripts');
  mkdirSync(libraryDir, { recursive: true });
  const statuses = async (voices: Array<{ name: string; meetings: number }> = []) => Object.fromEntries((await readFeatureStatuses({
    config: { meeting: { speakerBrowser: 'auto' } } as never, libraryDir, dependencies: { ...healthy, voices: () => voices } }))
    .map((status) => [status.id, status]));
  try {
    let now = await statuses();
    expect(now.voices).toMatchObject({ state: 'off', summary: 'None yet', fix: 'Name a speaker in a meeting to add one.' });
    expect(now.prompts).toMatchObject({ state: 'ok', summary: 'As shipped' });
    expect(now.extractors).toMatchObject({ state: 'off', summary: 'None yet', action: 'open-extractors' });
    expect(now.automations).toMatchObject({ state: 'off', summary: 'None yet', action: 'open-automations' });

    expect((await statuses([{ name: 'Dana', meetings: 3 }])).voices).toMatchObject({ state: 'ok', summary: '1 person' });
    mkdirSync(join(home, 'Prompts'));
    for (const name of ['live', 'chat']) writeFileSync(join(home, 'Prompts', `${name}.md`), 'Be brief.\n');
    writeFileSync(join(home, 'Prompts', 'notes.md'), '<!-- nothing -->\n');
    expect((await statuses()).prompts).toMatchObject({ state: 'ok', summary: '2 edited · 1 empty' });

    mkdirSync(join(home, 'Extractors'));
    writeFileSync(join(home, 'Extractors', 'pains.md'), '---\nname: Pains\nwhen: always\nfields:\n  Pains: What hurts\n---\n');
    expect((await statuses()).extractors).toMatchObject({ state: 'ok', summary: '1 · 1 run by themselves' });
    writeFileSync(join(home, 'Extractors', 'broken.md'), '---\nname: Broken\n---\n');
    expect((await statuses()).extractors).toMatchObject({ state: 'broken', summary: '1 file does not load' });

    mkdirSync(join(home, 'Automations'));
    writeFileSync(join(home, 'Automations', 'save.md'), '---\nname: Save\n---\n- write: ~/Notes\n');
    expect((await statuses()).automations).toMatchObject({ state: 'ok', summary: '1 on' });
    const run = (status: string, detail?: string) => `${JSON.stringify({ at: new Date().toISOString(), automation: 'Save', hash: 'h',
      meetingId: 'm', trigger: 'meeting-ready', status, actions: [{ kind: 'webhook', target: 'x', status, ...(detail ? { detail } : {}) }] })}\n`;
    writeFileSync(join(libraryDir, 'automation-runs.jsonl'), run('skipped', 'Waiting for your approval. To be asked now: seashell automations run m "Save"'));
    expect((await statuses()).automations).toMatchObject({ state: 'attention', summary: '1 on · waiting for you' });
    writeFileSync(join(libraryDir, 'automation-runs.jsonl'), run('failed', 'HTTP 500'));
    expect((await statuses()).automations).toMatchObject({ state: 'broken', summary: '1 on · last run failed' });
    writeFileSync(join(home, 'Automations', 'save.md'), '---\nname: Save\nenabled: false\n---\n- write: ~/Notes\n');
    expect((await statuses()).automations).toMatchObject({ state: 'off', summary: '1 · all off' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
