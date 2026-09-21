import { createHash } from 'crypto';
import type { TranscriptRecord } from './transcript-types.ts';

export interface MeetingEvidence {
  revision: string;
  segments: string[];
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function meetingEvidence(record: TranscriptRecord): MeetingEvidence {
  const labels = new Map(record.speakers.map((speaker) => [speaker.id, speaker.label]));
  const segments = record.transcript.map((segment, index) => hash([
    segment.id?.trim() || `s${String(index + 1).padStart(6, '0')}`,
    segment.start, segment.end, segment.text, segment.speaker ?? null,
    segment.speaker ? labels.get(segment.speaker) ?? null : null,
  ]));
  return { revision: hash(segments), segments };
}

export function compareMeetingEvidence(before: MeetingEvidence | undefined, after: MeetingEvidence): 'same' | 'append' | 'revised' {
  if (!before) return 'revised';
  if (before.revision === after.revision) return 'same';
  return before.segments.length < after.segments.length &&
    before.segments.every((value, index) => value === after.segments[index]) ? 'append' : 'revised';
}

export function parseMeetingEvidence(value: unknown): MeetingEvidence | undefined {
  if (value === undefined) return undefined;
  const candidate = value as MeetingEvidence;
  if (!candidate || !Array.isArray(candidate.segments) ||
    candidate.segments.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) ||
    candidate.revision !== hash(candidate.segments)) {
    throw new Error('Meeting transcript evidence is invalid');
  }
  return { revision: candidate.revision, segments: [...candidate.segments] };
}
