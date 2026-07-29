import { describe, expect, test } from 'bun:test';
import { timedUnitsFromWhisperJson } from '../src/whisper-timestamps.ts';

describe('timedUnitsFromWhisperJson', () => {
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
