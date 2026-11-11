import { describe, expect, test } from 'bun:test';
import {
  filterLibraryEntries,
  meetingEntryRow,
  listWhen,
  snippetAround,
  formatTuiClock,
  moveSelection,
  moveTranscriptScroll,
  speakerColorIndex,
  tuiLayout,
  wrapWords,
} from '../src/tui-state.ts';

describe('TUI navigation state', () => {
  test('wraps words without leaving one alone on the last line', () => {
    const text = 'Until you allow it, background meetings record other people but not you.';
    expect(wrapWords(text, 70)).toEqual(['Until you allow it, background meetings record other people but', 'not you.']);
    // Already two words on the last line, or one word in all: left as it is.
    expect(wrapWords('One two three four', 10)).toEqual(['One two', 'three four']);
    expect(wrapWords('Word', 10)).toEqual(['Word']);
  });

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

test('meeting rows show the time for today and the day before that, against the right edge', () => {
  const entry = (createdAt: string, duration?: number, captureState?: 'recording') => ({
    id: 'm', title: 'Google Meet', createdAt, updatedAt: createdAt, sourceFilename: 'Live capture session',
    speakerCount: 0, segmentCount: 0, kind: 'meeting' as const, directory: '/tmp/m',
    ...(duration === undefined ? {} : { duration }), ...(captureState ? { captureState } : {}),
  });
  const now = new Date(2026, 9, 2, 15, 0);
  const earlier = new Date(2026, 9, 1, 9, 28);
  const today = new Date(2026, 9, 2, 10, 3);
  const day = earlier.toLocaleDateString([], { month: 'short', day: 'numeric' });
  expect(meetingEntryRow(entry(earlier.toISOString(), 2_064), 30, now)).toBe(`Google Meet${' '.repeat(30 - 12 - day.length)} ${day}`);
  expect(meetingEntryRow(entry(today.toISOString(), 4_400), 30, now)).toEndWith(' 10:03 am');
  expect(meetingEntryRow(entry(today.toISOString(), 300, 'recording'), 30, now)).toStartWith('● Google Meet');
  expect(meetingEntryRow({ ...entry(earlier.toISOString()), title: 'A very long meeting title that cannot fit' }, 24, now)).toEndWith(`… ${day}`);
  // A meeting kept with its video has ▶ beside its date.
  expect(meetingEntryRow(entry(earlier.toISOString()), 30, now, 0, true)).toEndWith(`▶ ${day}`);
});

test("every row's date ends in the same terminal column, whatever its title is written in", () => {
  const entry = (title: string, createdAt: Date) => ({
    id: title, title, createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(), sourceFilename: 'Live capture session',
    speakerCount: 0, segmentCount: 0, kind: 'meeting' as const, directory: '/tmp/m',
  });
  const now = new Date(2026, 10, 10, 17, 50);
  const list: Array<[string, Date]> = [
    ['Acme discovery call', new Date(2026, 10, 10, 14, 50)],
    ['🚀 Launch review 🚀', new Date(2026, 10, 10, 9, 5)],
    ['設計レビューと来期の計画についての長い会議', new Date(2026, 10, 7, 14, 30)],
    ['Roadmap review', new Date(2026, 10, 7, 9, 5)],
    ['Board prep', new Date(2026, 9, 28, 13, 0)],
  ];
  const column = Math.max(...list.map(([, at]) => listWhen(at.toISOString(), now).length));
  // As the app draws them at 56 columns: the selected row starts with ›, the rest with two spaces.
  const rows = list.map(([title, at], index) => `${index === 0 ? '› ' : '  '}${meetingEntryRow(entry(title, at), 52, now, column)}`);
  for (const row of rows) expect(Bun.stringWidth(row)).toBe(54);
  // Today's rows end in a time, older rows in a day; all in one column.
  expect(rows.slice(0, 2).every((row) => /\d [ap]m$/u.test(row))).toBeTrue();
  expect(rows.slice(2).every((row) => /[A-Z][a-z]{2} \d{1,2}$/u.test(row))).toBeTrue();
});

test('a search snippet is cut around what matched', () => {
  const line = 'Sure. We looked at the pricing again and the per-seat number works for us, which is what matters.';
  expect(snippetAround('Short line about pricing.', 'pricing', 40)).toBe('Short line about pricing.');
  const cut = snippetAround(line, 'pricing', 30);
  expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(30);
  expect(cut).toContain('pricing');
  expect(cut.startsWith('…') && cut.endsWith('…')).toBeTrue();
});
