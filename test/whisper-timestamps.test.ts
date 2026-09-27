import { describe, expect, test } from 'bun:test';
import { timedUnitsFromWhisperJson } from '../src/whisper-timestamps.ts';
import { readFileSync } from 'node:fs';

describe('timedUnitsFromWhisperJson', () => {
  test('real VAD mixed-clock output preserves whole sentences instead of collapsing words at the segment start', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/whisper-vad-mixed-clock.json', import.meta.url), 'utf8'));
    const units = timedUnitsFromWhisperJson(raw);
    expect(units).toHaveLength(raw.transcription.length);
    for (const [i, unit] of units.entries()) {
      const segment = raw.transcription[i];
      expect(unit).toEqual({ start: segment.offsets.from / 1000, end: segment.offsets.to / 1000, text: segment.text.trim() });
      expect(unit.end - unit.start).toBeGreaterThan(4);
    }
  });

  test('punctuation preserves text without extending a word into subsequent silence', () => {
    expect(timedUnitsFromWhisperJson({ transcription: [{ offsets: { from: 0, to: 7000 }, text: ' release notes.', tokens: [
      { text: ' release', offsets: { from: 4260, to: 4600 }, t_dtw: 460 },
      { text: ' notes', offsets: { from: 4600, to: 5000 }, t_dtw: 504 },
      { text: '.', offsets: { from: 5000, to: 6520 }, t_dtw: 652 },
    ] }] })).toEqual([
      { start: 4.26, end: 4.6, anchor: 4.6, text: 'release' },
      { start: 4.6, end: 5.04, anchor: 5.04, text: 'notes.' },
    ]);
  });

  test('raw token clock mismatches and regressing anchors fall back without dropping text', () => {
    for (const tokens of [
      [{ text: ' Later', offsets: { from: 10, to: 500 }, t_dtw: -1 }],
      [{ text: ' Later', offsets: { from: 10000, to: 10500 }, t_dtw: 1050 },
        { text: ' words.', offsets: { from: 10500, to: 11000 }, t_dtw: 1040 }],
    ]) expect(timedUnitsFromWhisperJson({ transcription: [{ offsets: { from: 10000, to: 12000 }, text: ' Later words.', tokens }] }))
      .toEqual([{ start: 10, end: 12, text: 'Later words.' }]);
  });

  test('filters special tokens and folds BPE pieces and punctuation into words', () => {
    const result = timedUnitsFromWhisperJson({
      transcription: [
        {
          offsets: { from: 0, to: 1000 },
          text: ' Hello, transcription!',
          tokens: [
            { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
            { text: ' Hello', offsets: { from: 100, to: 300 } },
            { text: ',', offsets: { from: 300, to: 350 } },
            { text: ' trans', offsets: { from: 400, to: 600 } },
            { text: 'cription', offsets: { from: 600, to: 900 } },
            { text: '!', offsets: { from: 900, to: 950 } },
            { text: '[_TT_50]', offsets: { from: 950, to: 950 } },
          ],
        },
      ],
    });

    expect(result).toEqual([
      { start: 0.1, end: 0.35, text: 'Hello,' },
      { start: 0.4, end: 0.95, text: 'transcription!' },
    ]);
  });

  test('falls back to segment timestamps when token timings are absent', () => {
    expect(timedUnitsFromWhisperJson({
      transcription: [
        {
          offsets: { from: 1250, to: 2500 },
          text: ' Segment fallback. ',
        },
      ],
    })).toEqual([
      { start: 1.25, end: 2.5, text: 'Segment fallback.' },
    ]);
  });

  test('uses DTW centisecond anchors instead of silence-smeared offsets', () => {
    expect(timedUnitsFromWhisperJson({
      transcription: [
        {
          offsets: { from: 10000, to: 25000 },
          text: ' And so',
          tokens: [
            {
              text: ' And',
              offsets: { from: 10320, to: 10550 },
              t_dtw: 1450,
            },
            {
              text: ' so',
              offsets: { from: 10680, to: 10910 },
              t_dtw: 1486,
            },
          ],
        },
      ],
    })).toEqual([
      { start: 14.27, end: 14.5, anchor: 14.5, text: 'And' },
      { start: 14.63, end: 14.86, anchor: 14.86, text: 'so' },
    ]);
  });

  test('falls back to complete segment text rather than dropping an untimed token', () => {
    expect(timedUnitsFromWhisperJson({
      transcription: [
        {
          offsets: { from: 0, to: 1000 },
          text: ' Keep every word.',
          tokens: [
            { text: ' Keep', offsets: { from: 0, to: 300 } },
            { text: ' every' },
            { text: ' word.', offsets: { from: 600, to: 1000 } },
          ],
        },
      ],
    })).toEqual([
      { start: 0, end: 1, text: 'Keep every word.' },
    ]);
  });
});
