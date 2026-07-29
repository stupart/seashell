import { describe, expect, test } from 'bun:test';
import { mergeDiarization } from '../src/merge-diarization.ts';

describe('mergeDiarization', () => {
  test('aligns timestamped transcript words to speaker turns and merges them', () => {
    const transcript = [
      { start: 0, end: 0.4, text: 'Hello' },
      { start: 0.4, end: 0.9, text: 'there,' },
      { start: 1.1, end: 1.5, text: 'General' },
      { start: 1.5, end: 2, text: 'Kenobi.' },
    ];
    const diarization = [
      { start: 0, end: 1.05, speaker: 'SPEAKER_00' },
      { start: 1.05, end: 2.1, speaker: 'SPEAKER_01' },
    ];

    expect(mergeDiarization(transcript, diarization)).toEqual([
      {
        start: 0,
        end: 0.9,
        speaker: 'SPEAKER_00',
        text: 'Hello there,',
      },
      {
        start: 1.1,
        end: 2,
        speaker: 'SPEAKER_01',
        text: 'General Kenobi.',
      },
    ]);
  });

  test('uses known channel roles before considering other-channel turns', () => {
    const transcript = [
      { start: 0, end: 1, text: 'Can you hear me?', role: 'local' },
      { start: 0, end: 1, text: 'Loud and clear.', role: 'remote' },
    ];
    const diarization = [
      { start: 0, end: 1, speaker: 'REMOTE_00', role: 'remote' },
    ];

    expect(mergeDiarization(transcript, diarization, {
      roleSpeakers: { local: 'LOCAL' },
    })).toEqual([
      {
        start: 0,
        end: 1,
        speaker: 'LOCAL',
        text: 'Can you hear me?',
      },
      {
        start: 0,
        end: 1,
        speaker: 'REMOTE_00',
        text: 'Loud and clear.',
      },
    ]);
  });

  test('uses a nearby turn for small boundary misses and UNKNOWN for large gaps', () => {
    const transcript = [
      { start: 1.05, end: 1.2, text: 'near' },
      { start: 4, end: 4.2, text: 'far' },
    ];
    const diarization = [
      { start: 0, end: 1, speaker: 'SPEAKER_00' },
    ];

    expect(mergeDiarization(transcript, diarization)).toEqual([
      {
        start: 1.05,
        end: 1.2,
        speaker: 'SPEAKER_00',
        text: 'near',
      },
      {
        start: 4,
        end: 4.2,
        speaker: 'UNKNOWN',
        text: 'far',
      },
    ]);
  });

  test('uses a DTW anchor when heuristic token offsets smear across silence', () => {
    const transcript = [
      {
        start: 10.32,
        end: 10.55,
        anchor: 14.5,
        text: 'And',
      },
    ];
    const diarization = [
      { start: 9, end: 11, speaker: 'SPEAKER_00' },
      { start: 14, end: 16, speaker: 'SPEAKER_01' },
    ];

    expect(mergeDiarization(transcript, diarization)).toEqual([
      {
        start: 10.32,
        end: 10.55,
        speaker: 'SPEAKER_01',
        text: 'And',
      },
    ]);
  });

  test('keeps lexical DTW order when heuristic starts are non-monotonic', () => {
    const transcript = [
      { start: 14.27, end: 14.5, anchor: 14.5, text: 'And' },
      { start: 14.3, end: 14.86, anchor: 14.86, text: 'so,' },
      { start: 14.71, end: 16.12, anchor: 16.12, text: 'Americans.' },
    ];

    expect(mergeDiarization(
      transcript,
      [{ start: 14, end: 17, speaker: 'SPEAKER_01' }],
    )).toEqual([
      {
        start: 14.27,
        end: 16.12,
        speaker: 'SPEAKER_01',
        text: 'And so, Americans.',
      },
    ]);
  });

  test('does not merge the same speaker across a long silence', () => {
    const transcript = [
      { start: 0, end: 0.5, text: 'First.' },
      { start: 3, end: 3.5, text: 'Second.' },
    ];
    const diarization = [
      { start: 0, end: 4, speaker: 'SPEAKER_00' },
    ];

    expect(mergeDiarization(transcript, diarization)).toHaveLength(2);
  });
});
