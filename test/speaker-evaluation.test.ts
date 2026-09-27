import { expect, test } from 'bun:test';
import { evaluateSpeakerAttribution, type SpeakerReferenceTurn } from '../src/speaker-evaluation.ts';
import type { StructuredTranscript, TranscriptSegment } from '../src/transcript-types.ts';

const source = 'google-meet-accessibility' as const;
const reference = (start: number, end: number, speakers = ['Alice']): SpeakerReferenceTurn => ({
  id: `${start}-${end}`, start, end, channel: 'system-audio', speakers,
});
const prediction = (start: number, end: number, speaker = 'alice', speakerSource: TranscriptSegment['speakerSource'] = source): TranscriptSegment => ({
  start, end, speaker, speakerSource, text: 'Independent fixture words.',
});
const document = (transcript: TranscriptSegment[]): StructuredTranscript => ({ transcript, speakers: [
  { id: 'alice', label: 'Alice' }, { id: 'bob', label: 'Bob' },
  { id: 'SYSTEM', label: 'System audio' }, { id: 'LOCAL', label: 'Microphone' },
] });

test('duration scoring separates correct, wrong, unknown and missing without credit for absent speech', () => {
  const unknown = { ...prediction(6, 8, 'SYSTEM'), speakerSource: undefined };
  const score = evaluateSpeakerAttribution([reference(0, 10)], document([
    prediction(0, 4), prediction(4, 6, 'bob'), unknown,
  ]));
  expect(score).toMatchObject({
    referenceSeconds: 10, transcribedSeconds: 8, missingSeconds: 2,
    eligibleNameSeconds: 10, correctNameSeconds: 4, wrongNameSeconds: 2,
    unknownNameSeconds: 2, namedCoverage: .4, transcribedNamedCoverage: .5,
    wrongNameRate: 1 / 3, transcriptCoverage: .8, provenanceViolationSeconds: 0,
  });
});

test('all unknown has zero coverage and no measurable name-error denominator', () => {
  const score = evaluateSpeakerAttribution([reference(0, 2)], document([
    { ...prediction(0, 2, 'SYSTEM'), speakerSource: undefined },
  ]));
  expect(score).toMatchObject({ unknownNameSeconds: 2, namedCoverage: 0, transcribedNamedCoverage: 0, wrongNameRate: null });
  expect(evaluateSpeakerAttribution([reference(0, 2)], document([]))).toMatchObject({ missingSeconds: 2, namedCoverage: 0, transcribedNamedCoverage: null });
});

test('naming either person during overlap is unsafe, while source-only speech is a safe abstention', () => {
  const score = evaluateSpeakerAttribution([reference(0, 4, ['Alice', 'Bob'])], document([
    prediction(0, 2), { ...prediction(2, 4, 'SYSTEM'), speakerSource: undefined },
  ]));
  expect(score).toMatchObject({ ambiguousSeconds: 4, unsafeNameSeconds: 2, safeAbstentionSeconds: 2, wrongNameRate: 1, namedCoverage: null });
});

test('duplicate and contradictory predictions cannot inflate the good-name denominator', () => {
  expect(evaluateSpeakerAttribution([reference(0, 2)], document([
    prediction(0, 2), prediction(0, 2), prediction(.5, 1.5),
  ]))).toMatchObject({ correctNameSeconds: 2, transcribedSeconds: 2, namedCoverage: 1 });
  expect(evaluateSpeakerAttribution([reference(0, 2)], document([
    prediction(0, 2), prediction(.5, 1.5, 'bob'),
  ]))).toMatchObject({ correctNameSeconds: 1, wrongNameSeconds: 1, wrongNameRate: .5 });
});

test('concurrent microphone and system references score separately; source swaps in isolated windows fail', () => {
  const microphone: SpeakerReferenceTurn = { id: 'mic', start: .5, end: 1.5, channel: 'microphone', speakers: [] };
  const local = { ...prediction(.5, 1.5, 'LOCAL'), speakerSource: undefined };
  expect(evaluateSpeakerAttribution([reference(0, 2), microphone], document([prediction(0, 2), local]))).toMatchObject({
    referenceSeconds: 3, transcribedSeconds: 3, correctNameSeconds: 2,
    microphoneSeconds: 1, transcribedMicrophoneSeconds: 1, wrongSourceSeconds: 0,
  });
  expect(evaluateSpeakerAttribution([microphone], document([prediction(.5, 1.5)]))).toMatchObject({
    transcribedMicrophoneSeconds: 0, missingSeconds: 1, wrongSourceSeconds: 1,
  });
});

test('provenance must describe actual name evidence and must never leak into local or source-only output', () => {
  const mic: SpeakerReferenceTurn = { id: 'mic', start: 3, end: 4, channel: 'microphone', speakers: [] };
  const score = evaluateSpeakerAttribution([reference(0, 1), reference(1, 2), mic], document([
    prediction(0, 1, 'alice', 'google-meet-dom'), prediction(1, 2, 'SYSTEM'), prediction(3, 4, 'LOCAL'),
  ]));
  expect(score.provenanceViolationSeconds).toBe(3);
  expect(evaluateSpeakerAttribution([reference(0, 1)], document([prediction(0, 1, 'alice', 'google-meet-dom')]), {
    expectedNamedSource: 'google-meet-dom',
  }).provenanceViolationSeconds).toBe(0);
});

test('authored label changes are scored by time and unresolved predicted identities are wrong', () => {
  const score = evaluateSpeakerAttribution([reference(0, 1), reference(1, 2, ['Alicia']), reference(2, 3)], document([
    prediction(0, 2), prediction(2, 3, 'unlisted'),
  ]));
  expect(score).toMatchObject({ correctNameSeconds: 1, wrongNameSeconds: 2 });
});

test('invalid references and predictions fail instead of silently reducing the denominator', () => {
  expect(() => evaluateSpeakerAttribution([reference(0, 2), reference(1, 3)], document([]))).toThrow('overlap');
  expect(() => evaluateSpeakerAttribution([reference(0, NaN)], document([]))).toThrow('Invalid');
  expect(() => evaluateSpeakerAttribution([reference(0, 1)], document([prediction(0, Infinity)]))).toThrow('Invalid');
  expect(evaluateSpeakerAttribution([], document([]))).toMatchObject({ referenceSeconds: 0, namedCoverage: null, wrongNameRate: null });
});
