import { expect, test } from 'bun:test';
import { recordingRows, recordingSummary, settingsStatus } from '../src/SettingsScreen.tsx';

test('recording rows follow the saved rule, browser calls and each app', () => {
  const config = { meeting: { automation: { mode: 'automatic' as const, browserWithoutCalendar: 'automatic' as const, apps: { facetime: 'off' as const } } } };
  const rows = recordingRows(config);
  expect(rows.slice(0, 2).map((row) => [row.label, row.value])).toEqual([['Calls', 'automatic'], ['Browser, no calendar', 'automatic']]);
  expect(rows.find((row) => row.id === 'facetime')).toMatchObject({ label: 'FaceTime', value: 'off', help: 'FaceTime: never recorded.' });
  expect(rows.find((row) => row.id === 'zoom')).toMatchObject({ value: 'default', help: 'Zoom: follows Calls.' });
  expect(recordingSummary(config)).toBe('Records by itself · FaceTime off');
});

test('recording turned off the old way reads as off, and defaults read as Seashell behaves', () => {
  expect(recordingRows({ meeting: { automation: { enabled: false, mode: 'automatic' } } })[0]!.value).toBe('off');
  expect(recordingSummary({})).toBe('Records by itself');
  expect(recordingRows({})[1]!.value).toBe('ask');
});

test("the Settings title counts the same rows the list marks: recording first, then the extras", () => {
  const status = (id: string, optional: boolean, state: 'ok' | 'attention' | 'off' | 'broken') =>
    ({ id, label: id, optional, state, summary: '', detail: '' }) as never;
  const healthy = [status('recorder', false, 'ok'), status('microphone', false, 'ok'),
    status('extractors', true, 'broken'), status('automations', true, 'broken'), status('video', true, 'attention'), status('calendar', true, 'off')];
  // Off is a choice, not a problem: only broken and attention extras are counted.
  expect(settingsStatus(healthy, 80)).toEqual({ text: 'Recording works · 3 extras need a look', color: 'yellow' });
  expect(settingsStatus(healthy.slice(0, 2), 80)).toEqual({ text: 'Recording works', color: 'green' });
  const broken = [status('recorder', false, 'broken'), status('microphone', false, 'attention'), status('video', true, 'attention')];
  expect(settingsStatus(broken, 80).text).toBe('Recording needs 2 fixes · 1 extra needs a look');
  // Narrow, the same counts in fewer words.
  expect(settingsStatus(broken, 30).text).toBe('2 to fix · 1 extra to check');
});
