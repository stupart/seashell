import { describe, expect, test } from 'bun:test';
import {
  filterLibraryEntries,
  meetingEntryRow,
  listWhen,
  formatTuiClock,
  moveSelection,
  moveTranscriptScroll,
  speakerColorIndex,
  tuiLayout,
} from '../src/tui-state.ts';

describe('TUI navigation state', () => {
  test('clamps sidebar selection and transcript scrolling', () => {
    expect(moveSelection(0, -1, 4)).toBe(0);
    expect(moveSelection(2, 1, 4)).toBe(3);
    expect(moveSelection(3, 1, 4)).toBe(3);
    expect(moveTranscriptScroll(0, 5, 20, 8)).toBe(5);
    expect(moveTranscriptScroll(10, 10, 20, 8)).toBe(12);
  });

  test('filters library navigation without mutating the canonical list', () => {
    const entries = [{
      id: 'one',
      title: 'Product interview',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
      sourceFilename: 'meeting.MP4',
      speakerCount: 2,
      segmentCount: 10,
      kind: 'transcript' as const,
      directory: '/tmp/one',
    }];
    expect(filterLibraryEntries(entries, 'mp4')).toEqual(entries);
    expect(filterLibraryEntries(entries, 'missing')).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  test('assigns stable speaker colors', () => {
    expect(speakerColorIndex('SPEAKER_00')).toBe(speakerColorIndex('SPEAKER_00'));
    expect(speakerColorIndex('SPEAKER_00')).toBeGreaterThanOrEqual(0);
    expect(speakerColorIndex('SPEAKER_00')).toBeLessThan(6);
  });

  test('formats a compact media-relative clock for the terminal', () => {
    expect(formatTuiClock(4.9)).toBe('00:04');
    expect(formatTuiClock(65)).toBe('01:05');
    expect(formatTuiClock(3_661)).toBe('1:01:01');
  });

  test('keeps the history drawer beside the transcript until space gets tight', () => {
    expect(tuiLayout(71, 24).compact).toBe(true);
    expect(tuiLayout(72, 24).compact).toBe(false);
    expect(tuiLayout(120, 36)).toMatchObject({
      compact: false,
      sidebarWidth: 40,
      visibleTranscriptRows: 31,
      visibleLibraryItems: 32,
    });
    expect(tuiLayout(80, 24)).toMatchObject({
      compact: false,
      sidebarWidth: 28,
      visibleTranscriptRows: 19,
      visibleLibraryItems: 20,
    });
    expect(tuiLayout(60, 24)).toMatchObject({
      compact: true,
      sidebarWidth: 56,
    });
  });
});

test('meeting rows lead with day, time and length so same-titled meetings differ', () => {
  const entry = (createdAt: string, duration?: number, captureState?: 'recording') => ({
    id: 'm', title: 'Google Meet', createdAt, updatedAt: createdAt, sourceFilename: 'Live capture session',
    speakerCount: 0, segmentCount: 0, kind: 'meeting' as const, directory: '/tmp/m',
    ...(duration === undefined ? {} : { duration }), ...(captureState ? { captureState } : {}),
  });
  const now = new Date(2026, 9, 2, 15, 0);
  const earlier = new Date(2026, 9, 1, 9, 28);
  const today = new Date(2026, 9, 2, 10, 3);
  const day = earlier.toLocaleDateString([], { month: 'short', day: 'numeric' }).replace(/(\D)(\d)$/u, '$1 $2');
  expect(meetingEntryRow(entry(earlier.toISOString(), 2_064), 30, now, false)).toBe(`Google Meet${' '.repeat(30 - 12 - day.length)} ${day}`);
  // A second meeting that day brings the time in, so same-titled rows stay apart.
  expect(meetingEntryRow(entry(earlier.toISOString(), 2_064), 30, now)).toEndWith(`${day}  9:28a`);
  expect(meetingEntryRow(entry(today.toISOString(), 4_400), 30, now)).toEndWith(' 10:03a');
  expect(meetingEntryRow(entry(today.toISOString(), 300, 'recording'), 30, now)).toStartWith('● Google Meet');
  expect(meetingEntryRow({ ...entry(earlier.toISOString()), title: 'A very long meeting title that cannot fit' }, 24, now)).toEndWith(`… ${day}  9:28a`);
});

test('dates and times line up in a column at 56 columns', () => {
  const entry = (title: string, createdAt: Date) => ({
    id: title, title, createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(), sourceFilename: 'Live capture session',
    speakerCount: 0, segmentCount: 0, kind: 'meeting' as const, directory: '/tmp/m',
  });
  const now = new Date(2026, 10, 10, 16, 0);
  const list: Array<[string, Date, boolean]> = [
    ['Design review', new Date(2026, 10, 10, 9, 5), true],
    ['Acme discovery call', new Date(2026, 10, 10, 10, 30), true],
    ['Weekly product sync', new Date(2026, 10, 9, 10, 0), false],
    ['Board prep', new Date(2026, 9, 28, 13, 0), true],
    ['Hiring loop debrief', new Date(2026, 9, 28, 10, 0), true],
  ];
  const column = Math.max(...list.map(([, at, withTime]) => listWhen(at.toISOString(), now, withTime).length));
  const rows = list.map(([title, at, withTime]) => meetingEntryRow(entry(title, at), 52, now, withTime, column));
  for (const row of rows) expect(row).toHaveLength(52);
  // Each part of the date starts in the same column on every row that has it.
  const starts = (pattern: RegExp) => new Set(rows.flatMap((row) => { const at = row.search(pattern); return at < 0 ? [] : [at]; }));
  expect(starts(/[ \d]\d:\d\d[ap]/u).size).toBe(1);
  expect(starts(/[A-Z][a-z]{2} [ \d]\d/u).size).toBe(1);
});

test("every row's time ends in the same terminal column, whatever its title is written in", () => {
  const entry = (title: string, createdAt: Date) => ({
    id: title, title, createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(), sourceFilename: 'Live capture session',
    speakerCount: 0, segmentCount: 0, kind: 'meeting' as const, directory: '/tmp/m',
  });
  const now = new Date(2026, 10, 10, 17, 50);
  const list: Array<[string, Date, boolean]> = [
    ['Acme discovery call', new Date(2026, 10, 10, 14, 50), true],
    ['🚀 Launch review 🚀', new Date(2026, 10, 10, 9, 5), true],
    ['設計レビューと来期の計画についての長い会議', new Date(2026, 10, 7, 14, 30), true],
    ['Roadmap review', new Date(2026, 10, 7, 9, 5), true],
    ['Board prep', new Date(2026, 10, 5, 13, 0), false],
  ];
  const column = Math.max(...list.map(([, at, withTime]) => listWhen(at.toISOString(), now, withTime).length));
  // As the app draws them at 56 columns: the selected row starts with ›, the rest with two spaces.
  const rows = list.map(([title, at, withTime], index) => `${index === 0 ? '› ' : '  '}${meetingEntryRow(entry(title, at), 52, now, withTime, column)}`);
  for (const row of rows) expect(Bun.stringWidth(row)).toBe(54);
  const timeEnds = new Set(rows.filter((row) => /\d[ap]$/u.test(row)).map((row) => Bun.stringWidth(row)));
  expect(timeEnds).toEqual(new Set([54]));
});
