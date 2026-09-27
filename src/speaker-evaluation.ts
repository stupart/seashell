import type { StructuredTranscript, TranscriptSegment } from './transcript-types.ts';

/** Author independently of the observations supplied to the attribution reader.
 * Turns may overlap across channels; within one channel represent overlap as a
 * single turn listing every audible person. An empty list means unattributable. */
export interface SpeakerReferenceTurn {
  id: string;
  start: number;
  end: number;
  channel: 'microphone' | 'system-audio';
  speakers: readonly string[];
}

export interface SpeakerEvaluationDurations {
  referenceSeconds: number;
  transcribedSeconds: number;
  missingSeconds: number;
  eligibleNameSeconds: number;
  transcribedEligibleNameSeconds: number;
  correctNameSeconds: number;
  wrongNameSeconds: number;
  unknownNameSeconds: number;
  ambiguousSeconds: number;
  safeAbstentionSeconds: number;
  unsafeNameSeconds: number;
  microphoneSeconds: number;
  transcribedMicrophoneSeconds: number;
  wrongSourceSeconds: number;
  provenanceViolationSeconds: number;
}

export interface SpeakerEvaluation extends SpeakerEvaluationDurations {
  /** Correct named seconds / all unambiguous remote reference seconds. */
  namedCoverage: number | null;
  /** Correct named seconds / transcribed unambiguous remote reference seconds. */
  transcribedNamedCoverage: number | null;
  /** Wrong or unsafe named seconds / all asserted named seconds. */
  wrongNameRate: number | null;
  transcriptCoverage: number | null;
  turns: Array<SpeakerEvaluationDurations & { id: string }>;
}

const fields = [
  'referenceSeconds', 'transcribedSeconds', 'missingSeconds', 'eligibleNameSeconds',
  'transcribedEligibleNameSeconds', 'correctNameSeconds', 'wrongNameSeconds',
  'unknownNameSeconds', 'ambiguousSeconds', 'safeAbstentionSeconds', 'unsafeNameSeconds',
  'microphoneSeconds', 'transcribedMicrophoneSeconds', 'wrongSourceSeconds',
  'provenanceViolationSeconds',
] as const;
const empty = (): SpeakerEvaluationDurations => Object.fromEntries(fields.map(key => [key, 0])) as unknown as SpeakerEvaluationDurations;
const channel = (segment: TranscriptSegment): SpeakerReferenceTurn['channel'] => segment.speaker === 'LOCAL' ? 'microphone' : 'system-audio';
const named = (segment: TranscriptSegment): boolean => Boolean(segment.speaker &&
  !['LOCAL', 'SYSTEM'].includes(segment.speaker) && !segment.speaker.startsWith('REMOTE_'));
const inside = (start: number, end: number, at: number): boolean => start <= at && at < end;
const validTime = (start: number, end: number): boolean => Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
const ratio = (numerator: number, denominator: number): number | null => denominator > 0 ? numerator / denominator : null;
const round = (value: number): number => Math.round(value * 1e9) / 1e9;

/** Time-weighted scoring, independent of Meet IDs, polling intervals and reader
 * thresholds. This measures display-name attribution, not biometric identity,
 * word accuracy, or conventional diarization error rate. Silence outside the
 * authored reference turns is not scored. Conflicting simultaneous name claims
 * count as wrong; duplicated segments cannot increase scored duration.
 *
 * Saved speaker IDs encode source channel. A swap during simultaneous mic and
 * system speech cannot be inferred from timing: check known utterance text on
 * each source separately. wrongSourceSeconds detects wrong-channel output in
 * reference windows where that other channel has no reference speech. */
export function evaluateSpeakerAttribution(
  reference: readonly SpeakerReferenceTurn[],
  document: Pick<StructuredTranscript, 'transcript' | 'speakers'>,
  options: { expectedNamedSource?: TranscriptSegment['speakerSource'] } = {},
): SpeakerEvaluation {
  const expectedSource = options.expectedNamedSource ?? 'google-meet-accessibility';
  const ids = new Set<string>();
  const sorted = [...reference].sort((a, b) => a.start - b.start);
  const ends = new Map<SpeakerReferenceTurn['channel'], number>();
  for (const turn of sorted) {
    if (!turn.id || ids.has(turn.id) || !validTime(turn.start, turn.end) ||
        !['microphone', 'system-audio'].includes(turn.channel) ||
        turn.speakers.some(name => !name.trim()) || new Set(turn.speakers).size !== turn.speakers.length) {
      throw new Error('Invalid speaker reference turn');
    }
    if ((ends.get(turn.channel) ?? -1) > turn.start) throw new Error('Reference turns overlap within one channel; combine their speakers');
    ids.add(turn.id); ends.set(turn.channel, turn.end);
  }
  const labels = new Map<string, string>();
  for (const speaker of document.speakers) {
    if (!speaker.id || !speaker.label || labels.has(speaker.id)) throw new Error('Invalid or duplicate predicted speaker ID');
    labels.set(speaker.id, speaker.label);
  }
  for (const segment of document.transcript) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start) {
      throw new Error('Invalid predicted segment time');
    }
  }
  const segments = document.transcript.filter(segment => segment.end > segment.start && segment.text.trim());
  const totals = empty();
  const turns = sorted.map(turn => {
    const result = { id: turn.id, ...empty() };
    const relevant = segments.filter(segment => segment.start < turn.end && segment.end > turn.start);
    const otherReference = sorted.filter(other => other.channel !== turn.channel && other.start < turn.end && other.end > turn.start);
    const boundaries = [...new Set([turn.start, turn.end,
      ...relevant.flatMap(segment => [Math.max(turn.start, segment.start), Math.min(turn.end, segment.end)]),
      ...otherReference.flatMap(other => [Math.max(turn.start, other.start), Math.min(turn.end, other.end)]),
    ])].sort((a, b) => a - b);
    for (let index = 1; index < boundaries.length; index++) {
      const start = boundaries[index - 1]!, end = boundaries[index]!, duration = end - start, at = (start + end) / 2;
      const active = relevant.filter(segment => inside(segment.start, segment.end, at));
      const predicted = active.filter(segment => channel(segment) === turn.channel);
      const names = predicted.filter(named);
      result.referenceSeconds += duration;
      if (!predicted.length) result.missingSeconds += duration;
      else result.transcribedSeconds += duration;
      if (active.some(segment => channel(segment) !== turn.channel) &&
          !otherReference.some(other => inside(other.start, other.end, at))) result.wrongSourceSeconds += duration;
      if (predicted.some(segment => named(segment) ? segment.speakerSource !== expectedSource : segment.speakerSource !== undefined)) {
        result.provenanceViolationSeconds += duration;
      }
      if (turn.channel === 'microphone') {
        result.microphoneSeconds += duration;
        if (predicted.length) result.transcribedMicrophoneSeconds += duration;
      } else if (turn.speakers.length === 1) {
        result.eligibleNameSeconds += duration;
        if (predicted.length) {
          result.transcribedEligibleNameSeconds += duration;
          if (!names.length) result.unknownNameSeconds += duration;
          else if (names.every(segment => labels.get(segment.speaker!) === turn.speakers[0])) result.correctNameSeconds += duration;
          else result.wrongNameSeconds += duration;
        }
      } else {
        result.ambiguousSeconds += duration;
        if (names.length) result.unsafeNameSeconds += duration;
        else if (predicted.length) result.safeAbstentionSeconds += duration;
      }
    }
    for (const key of fields) { result[key] = round(result[key]); totals[key] += result[key]; }
    return result;
  });
  for (const key of fields) totals[key] = round(totals[key]);
  return {
    ...totals,
    namedCoverage: ratio(totals.correctNameSeconds, totals.eligibleNameSeconds),
    transcribedNamedCoverage: ratio(totals.correctNameSeconds, totals.transcribedEligibleNameSeconds),
    wrongNameRate: ratio(totals.wrongNameSeconds + totals.unsafeNameSeconds,
      totals.correctNameSeconds + totals.wrongNameSeconds + totals.unsafeNameSeconds),
    transcriptCoverage: ratio(totals.transcribedSeconds, totals.referenceSeconds),
    turns,
  };
}
