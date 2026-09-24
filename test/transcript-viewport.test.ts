import { test, expect } from 'bun:test';
import { stripVTControlCharacters } from 'util';
import { transcriptRows, MouseScrollDecoder } from '../src/transcript-viewport.ts';

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
