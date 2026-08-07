import { describe, expect, test } from 'bun:test';
import {
  coalesceTranscriptSegments,
  formatClock,
  renderSrt,
  renderText,
  renderVtt,
} from '../src/transcript-renderer.ts';
import type { StructuredTranscript } from '../src/transcript-types.ts';

const document: StructuredTranscript = {
  transcript: [
    { start: 1.234, end: 1.8, speaker: 'SPEAKER_00', text: 'Hello' },
    { start: 1.8, end: 2.4, speaker: 'SPEAKER_00', text: 'there.' },
    { start: 3, end: 4.125, speaker: 'SPEAKER_01', text: 'General Kenobi.' },
  ],
  speakers: [
    { id: 'SPEAKER_00', label: 'Tyler' },
    { id: 'SPEAKER_01', label: 'SPEAKER_01' },
  ],
};

describe('text rendering', () => {
  test('supports plain, timestamp, speaker, and combined variants', () => {
    expect(renderText(document)).toBe('Hello there. General Kenobi.');
    expect(renderText(document, { timestamps: true })).toBe(
      '[00:00:01.234] Hello there.\n[00:00:03.000] General Kenobi.',
    );
    expect(renderText(document, { speakers: true })).toBe(
      'Tyler: Hello there.\nSPEAKER_01: General Kenobi.',
    );
    expect(renderText(document, { timestamps: true, speakers: true })).toBe(
      '[00:00:01.234] Tyler: Hello there.\n' +
      '[00:00:03.000] SPEAKER_01: General Kenobi.',
    );
  });

  test('keeps anonymous speaker IDs separate from editable labels', () => {
    expect(document.transcript[0]?.speaker).toBe('SPEAKER_00');
    expect(document.speakers[0]?.label).toBe('Tyler');
  });
});

describe('subtitle rendering', () => {
  test('writes valid monotonically ordered SRT cues with speaker labels', () => {
    const srt = renderSrt(document, { speakers: true });
    expect(srt).toContain('1\n00:00:01,234 --> 00:00:02,400\n[Tyler] Hello there.');
    expect(srt).toContain('2\n00:00:03,000 --> 00:00:04,125\n[SPEAKER_01] General Kenobi.');
  });

  test('writes WebVTT and can suppress speaker presentation', () => {
    expect(renderVtt(document, { speakers: false })).toBe(
      'WEBVTT\n\n' +
      '00:00:01.234 --> 00:00:02.400\nHello there.\n\n' +
      '00:00:03.000 --> 00:00:04.125\nGeneral Kenobi.\n',
    );
  });

  test('coalesces word-like units without crossing speakers', () => {
    const cues = coalesceTranscriptSegments(document);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 1.234, end: 2.4, text: 'Hello there.' });
  });

  test('formats long durations with fixed-width clock fields', () => {
    expect(formatClock(3723.004)).toBe('01:02:03.004');
  });
});
