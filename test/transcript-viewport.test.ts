import { test, expect } from 'bun:test';
import { stripVTControlCharacters } from 'util';
import { timedTranscriptRows, transcriptRows, MouseScrollDecoder } from '../src/transcript-viewport.ts';

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
