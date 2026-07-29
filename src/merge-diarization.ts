import type {
  DiarizationTurn,
  TimedTranscriptUnit,
  TranscriptSegment,
} from './transcript-types.ts';

export interface MergeDiarizationOptions {
  /**
   * Attribute a transcript unit to the closest turn when timestamp boundaries
   * miss by at most this many seconds.
   */
  nearestTurnTolerance?: number;
  /**
   * Keep same-speaker text in one segment unless silence exceeds this gap.
   */
  maxMergeGap?: number;
  unknownSpeaker?: string;
  /** Authoritative role-to-speaker mappings, e.g. local -> LOCAL. */
  roleSpeakers?: Readonly<Record<string, string>>;
}

const DEFAULT_OPTIONS: Required<MergeDiarizationOptions> = {
  nearestTurnTolerance: 0.75,
  maxMergeGap: 1,
  unknownSpeaker: 'UNKNOWN',
  roleSpeakers: {},
};

function overlapDuration(
  left: Pick<TimedTranscriptUnit, 'start' | 'end'>,
  right: Pick<DiarizationTurn, 'start' | 'end'>,
): number {
  return Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
}

function distanceBetween(
  left: Pick<TimedTranscriptUnit, 'start' | 'end'>,
  right: Pick<DiarizationTurn, 'start' | 'end'>,
): number {
  if (left.end < right.start) return right.start - left.end;
  if (right.end < left.start) return left.start - right.end;
  return 0;
}

function validateInterval(
  value: Pick<TimedTranscriptUnit, 'start' | 'end'> & { anchor?: number },
  kind: string,
): void {
  if (!Number.isFinite(value.start) || !Number.isFinite(value.end)) {
    throw new Error(`${kind} timestamps must be finite numbers`);
  }
  if (value.start < 0 || value.end < value.start) {
    throw new Error(`${kind} has an invalid interval: ${value.start}-${value.end}`);
  }
  if (
    value.anchor !== undefined &&
    (!Number.isFinite(value.anchor) || value.anchor < 0)
  ) {
    throw new Error(`${kind} has an invalid DTW anchor: ${value.anchor}`);
  }
}

function speakerForUnit(
  unit: TimedTranscriptUnit,
  turns: DiarizationTurn[],
  options: Required<MergeDiarizationOptions>,
): string {
  if (unit.role) {
    const knownSpeaker = options.roleSpeakers[unit.role];
    if (knownSpeaker) return knownSpeaker;
  }

  const applicableTurns = unit.role
    ? turns.filter((turn) => turn.role === unit.role)
    : turns;

  if (unit.anchor !== undefined) {
    const containingTurn = applicableTurns.find(
      (turn) => turn.start <= unit.anchor! && unit.anchor! <= turn.end,
    );
    if (containingTurn) return containingTurn.speaker;

    let nearestTurn: DiarizationTurn | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const turn of applicableTurns) {
      const distance = unit.anchor < turn.start
        ? turn.start - unit.anchor
        : unit.anchor - turn.end;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestTurn = turn;
      }
    }
    if (nearestTurn && nearestDistance <= options.nearestTurnTolerance) {
      return nearestTurn.speaker;
    }
    return options.unknownSpeaker;
  }

  let bestTurn: DiarizationTurn | undefined;
  let bestOverlap = 0;
  const midpoint = unit.start + (unit.end - unit.start) / 2;

  for (const turn of applicableTurns) {
    const overlap = overlapDuration(unit, turn);
    if (
      overlap > bestOverlap ||
      (overlap > 0 &&
        overlap === bestOverlap &&
        turn.start <= midpoint &&
        midpoint <= turn.end &&
        bestTurn !== undefined &&
        !(bestTurn.start <= midpoint && midpoint <= bestTurn.end))
    ) {
      bestOverlap = overlap;
      bestTurn = turn;
    }
  }

  if (bestTurn && bestOverlap > 0) return bestTurn.speaker;

  let nearestTurn: DiarizationTurn | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const turn of applicableTurns) {
    const distance = distanceBetween(unit, turn);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestTurn = turn;
    }
  }

  if (nearestTurn && nearestDistance <= options.nearestTurnTolerance) {
    return nearestTurn.speaker;
  }

  return options.unknownSpeaker;
}

function joinTranscriptText(current: string, next: string): string {
  const cleanNext = next.trim();
  if (!cleanNext) return current;
  if (!current) return cleanNext;

  // Punctuation and English contractions attach to the previous word.
  if (/^[,.;:!?%)\]}]/u.test(cleanNext) || /^['’](?:s|t|re|ve|ll|d|m)\b/iu.test(cleanNext)) {
    return current + cleanNext;
  }

  return `${current} ${cleanNext}`;
}

/**
 * Attribute timestamped Whisper units to the pyannote turn with the greatest
 * temporal overlap, then merge adjacent units spoken by the same speaker.
 */
export function mergeDiarization(
  transcriptUnits: TimedTranscriptUnit[],
  diarizationTurns: DiarizationTurn[],
  providedOptions: MergeDiarizationOptions = {},
): TranscriptSegment[] {
  const options = { ...DEFAULT_OPTIONS, ...providedOptions };

  for (const unit of transcriptUnits) validateInterval(unit, 'Transcript unit');
  for (const turn of diarizationTurns) {
    validateInterval(turn, 'Diarization turn');
    if (!turn.speaker.trim()) throw new Error('Diarization turn speaker cannot be empty');
  }

  const units = transcriptUnits
    .filter((unit) => unit.text.trim().length > 0)
    .toSorted(
      (a, b) =>
        (a.anchor ?? a.start) - (b.anchor ?? b.start) ||
        a.start - b.start ||
        a.end - b.end,
    );
  const turns = diarizationTurns.toSorted(
    (a, b) => a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker),
  );

  const merged: TranscriptSegment[] = [];
  for (const unit of units) {
    const speaker = speakerForUnit(unit, turns, options);
    const previous = merged.at(-1);

    if (
      previous &&
      previous.speaker === speaker &&
      unit.start - previous.end <= options.maxMergeGap
    ) {
      previous.end = Math.max(previous.end, unit.end);
      previous.text = joinTranscriptText(previous.text, unit.text);
      continue;
    }

    merged.push({
      start: unit.start,
      end: unit.end,
      speaker,
      text: unit.text.trim(),
    });
  }

  return merged;
}
