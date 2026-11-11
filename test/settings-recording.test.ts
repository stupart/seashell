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

test("the Settings title counts the marks the list shows, coloured by the worst", () => {
  const status = (id: string, optional: boolean, state: 'ok' | 'attention' | 'off' | 'broken') =>
    ({ id, label: id, optional, state, summary: '', detail: '' }) as never;
  const rows = [status('recorder', false, 'ok'), status('microphone', false, 'ok'),
    status('extractors', true, 'broken'), status('automations', true, 'broken'), status('video', true, 'attention'), status('calendar', true, 'off')];
  // Two ✗ and one ! read as failing first, in red, whether or not the rows are optional.
  expect(settingsStatus(rows)).toEqual({ text: '2 failing · 1 to check', color: 'red' });
  expect(settingsStatus([status('recorder', false, 'ok'), status('video', true, 'attention')])).toEqual({ text: '1 to check', color: 'yellow' });
  // Off is a choice, not a problem.
  expect(settingsStatus([status('recorder', false, 'ok'), status('calendar', true, 'off')])).toEqual({ text: 'Everything works', color: 'green' });
});
