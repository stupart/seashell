import { test, expect } from 'bun:test';
import { stripVTControlCharacters } from 'util';
import { lastTranscriptScroll, timedTranscriptRows, transcriptRows, transcriptWindow, MouseScrollDecoder } from '../src/transcript-viewport.ts';

test('one long paragraph remains reachable row by row at narrow widths', () => {
  const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
  const record = { transcript: [{ start: 0, end: 100, text: words.join(' '), speaker: 'LOCAL' }],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }] };
  for (const timestamps of [true, false]) for (const speakers of [true, false]) {
    const rows = transcriptRows(record, 30, { timestamps, speakers }).map(stripVTControlCharacters);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.at(-1)).toContain('word99');
    expect(rows.every((row) => row.length <= 30)).toBe(true);
    for (const word of words) expect(rows.join(' ')).toContain(word);
  }
});

test('wheel reports are decoded across chunks; releases, clicks and horizontal wheels cannot trigger shortcuts', () => {
  const decoder = new MouseScrollDecoder();
  expect(decoder.read('[<64;12;5M')).toEqual({ consumed: true, events: [{ delta: -3, column: 12 }] });
  expect(decoder.read('[<65;')).toEqual({ consumed: true, events: [] });
  expect(decoder.read('12;5M\x1b[<65;12;5M').events).toHaveLength(2);
  for (const report of ['[<0;12;5M', '[<64;12;5m', '[<66;12;5M']) {
    expect(decoder.read(report)).toEqual({ consumed: true, events: [] });
  }
  expect(decoder.read('m')).toEqual({ consumed: false, events: [] });
});

const timedRecord = {
  transcript: [
    { start: 0, end: 4, speaker: 'LOCAL', text: 'A made-up opening line that is long enough to wrap onto a second row here.' },
    { start: 65, end: 70, speaker: 'REMOTE_00', text: 'A short reply.' },
  ],
  speakers: [{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_00', label: 'Remote speaker 1' }],
};

test('each transcript row knows when its line was said, wrapped rows included', () => {
  for (const [columns, options] of [[40, { timestamps: true, speakers: true }], [80, { timestamps: true, speakers: true }],
    [40, { timestamps: false, speakers: true }]] as const) {
    const timed = timedTranscriptRows(timedRecord, columns, options);
    expect(timed.map((row) => row.text)).toEqual(transcriptRows(timedRecord, columns, options));
    // The opening line wraps; every one of its rows, and none of the reply's, starts at 0.
    const reply = timed.findIndex((row) => row.start === 65);
    expect(reply).toBeGreaterThan(1);
    expect(timed.slice(0, reply).every((row) => row.start === 0)).toBe(true);
    expect(timed.slice(reply).every((row) => row.start === 65)).toBe(true);
    expect(stripVTControlCharacters(timed.slice(reply).map((row) => row.text).join(' '))).toContain('A short reply');
  }
  // Words run together without lines: no row can say when.
  expect(timedTranscriptRows(timedRecord, 40, { timestamps: false, speakers: false }).every((row) => row.start === undefined)).toBe(true);
});

test('a line cut at the top of the view keeps its time and speaker', () => {
  const options = { timestamps: true, speakers: true };
  const plain = (rows: { text: string }[]) => rows.map((row) => stripVTControlCharacters(row.text));
  // Stacked: the time and speaker sit on a row of their own above the words that are left.
  const stacked = timedTranscriptRows(timedRecord, 40, options);
  expect(plain(transcriptWindow(stacked, 1, 3))).toEqual(['00:00  You', 'A made-up opening line that is long', 'enough to wrap onto a second row here.']);
  // A row from the middle of a line starts with "…", so the time and speaker over it never read as one sentence with it.
  expect(plain(transcriptWindow(stacked, 2, 3))).toEqual(['00:00  You', '…enough to wrap onto a second row here.', '01:05  Speaker 1']);
  // The last scroll leaves room for that row, so the last words are never pushed out of view.
  const last = lastTranscriptScroll(stacked, 3);
  expect(plain(transcriptWindow(stacked, last, 3)).at(-1)).toBe('A short reply.');
  // In columns: the cut row takes its line's time and speaker beside it.
  const columns = timedTranscriptRows(timedRecord, 64, options);
  expect(plain(transcriptWindow(columns, 1, 2))[0]).toMatch(/^00:00  You {8}…\S/u);
  // The rows after a line's first leave a column for "…", so a cut row fits as its line's first does.
  for (const width of [40, 64]) for (const row of transcriptWindow(timedTranscriptRows(timedRecord, width, options), 2, 3)) {
    expect(Bun.stringWidth(stripVTControlCharacters(row.text))).toBeLessThanOrEqual(width);
  }
  expect(lastTranscriptScroll(columns, 2)).toBe(columns.length - 2);
});

test('something to look at in the notes stays marked on every row it wraps to, so all of it is yellow', async () => {
  const { wrappedMeetingRows } = await import('../src/transcript-viewport.ts');
  const { CAUTION, OWNER_NOTES_UNREAD, plainMeetingLines } = await import('../src/meeting-tui.ts');
  const rows = wrappedMeetingRows([`${CAUTION}${OWNER_NOTES_UNREAD}`], 30);
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.every((row) => row.startsWith(CAUTION))).toBe(true);
  expect(rows.map((row) => row.slice(CAUTION.length)).join(' ')).toBe(OWNER_NOTES_UNREAD);
  expect(plainMeetingLines([`${CAUTION}${OWNER_NOTES_UNREAD}`])).toEqual([OWNER_NOTES_UNREAD]);
});

test('"line removed" sits in the time column on its own row, without pushing the other owners left', async () => {
  const { wrappedMeetingRows } = await import('../src/transcript-viewport.ts');
  const rows = wrappedMeetingRows(['- Send the summary.\tYou · Fri\t00:35', '- Share the deck.\t\tline removed'], 60).map((row) => stripVTControlCharacters(row));
  expect(rows[0]).toEndWith('You · Fri  00:35');
  expect(rows[1]).toEndWith('line removed');
  expect(rows.every((row) => Bun.stringWidth(row) === 60)).toBe(true);
});
