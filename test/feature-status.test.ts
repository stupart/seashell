import { expect, test } from 'bun:test';
import { readFeatureStatuses, renderFeatureStatusTable, type FeatureStatusDependencies, type MeetingEvidence } from '../src/feature-status.ts';
import type { MeetProbe } from '../src/meet-speakers.ts';

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
