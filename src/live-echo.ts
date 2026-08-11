import type { TranscriptSegment } from './transcript-types.ts';

function words(text: string): string[] {
  return text
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}']+/gu) ?? [];
}

function overlapScore(left: string[], right: string[]): { shared: number; containment: number } {
  const leftCounts = new Map<string, number>();
  for (const word of left) leftCounts.set(word, (leftCounts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of right) {
    const remaining = leftCounts.get(word) ?? 0;
    if (remaining > 0) {
      shared += 1;
      leftCounts.set(word, remaining - 1);
    }
  }
  return { shared, containment: shared / Math.max(1, Math.min(left.length, right.length)) };
}

/**
 * Conservative transcript-level echo guard for speaker playback leaking into
 * the microphone. It only suppresses strong lexical matches that overlap in
 * media time; ambiguous local speech remains untouched.
 */
export function isLikelySystemAudioLeak(
  microphone: TranscriptSegment,
  system: TranscriptSegment,
  paddingSeconds = 2,
): boolean {
  if (microphone.speaker !== 'LOCAL' || system.speaker !== 'SYSTEM') return false;
  const overlaps = Math.min(microphone.end, system.end) + paddingSeconds >=
    Math.max(microphone.start, system.start);
  if (!overlaps) return false;
  const microphoneWords = words(microphone.text);
  const systemWords = words(system.text);
  if (Math.min(microphoneWords.length, systemWords.length) < 4) return false;
  const score = overlapScore(microphoneWords, systemWords);
  return score.shared >= 4 && score.containment >= 0.72;
}

/** System capture wins only for near-duplicate overlap; it never merges tracks. */
export function reconcileLiveEcho(
  existing: readonly TranscriptSegment[],
  incoming: TranscriptSegment,
): readonly TranscriptSegment[] {
  if (
    incoming.speaker === 'LOCAL' &&
    existing.some((segment) => isLikelySystemAudioLeak(incoming, segment))
  ) return existing;
  const retained = incoming.speaker === 'SYSTEM'
    ? existing.filter((segment) => !isLikelySystemAudioLeak(segment, incoming))
    : [...existing];
  return [...retained, incoming].toSorted((left, right) =>
    left.start - right.start || left.end - right.end);
}
