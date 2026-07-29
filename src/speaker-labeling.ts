import type {
  Speaker,
  StructuredTranscript,
  TranscriptSegment,
} from './transcript-types.ts';

export interface MeetScreenshotEvidence {
  /** Capture time in seconds from the beginning of the meeting recording. */
  capturedAt: number;
  imagePath: string;
}

export interface MeetAttendee {
  name: string;
  email: string;
}

export interface SpeakerLabelingEvidence {
  screenshots: MeetScreenshotEvidence[];
  attendees: MeetAttendee[];
}

export interface SpeakerLabelingRequest {
  speakers: Speaker[];
  transcript: TranscriptSegment[];
  evidence: SpeakerLabelingEvidence;
}

/**
 * Seam for a future Meet vision implementation. Implementations can inspect
 * timestamped active-speaker screenshots and map diarized IDs to attendees.
 */
export interface SpeakerLabeler {
  labelSpeakers(request: SpeakerLabelingRequest): Promise<Speaker[]>;
}

/**
 * Deliberately performs no visual inference. It preserves channel-derived
 * labels (such as local/remote) and otherwise leaves pyannote IDs unchanged.
 */
export class StubMeetSpeakerLabeler implements SpeakerLabeler {
  async labelSpeakers(request: SpeakerLabelingRequest): Promise<Speaker[]> {
    return request.speakers.map((speaker) => ({ ...speaker }));
  }
}

export async function applySpeakerLabels(
  document: StructuredTranscript,
  labeler: SpeakerLabeler,
  evidence: SpeakerLabelingEvidence,
): Promise<StructuredTranscript> {
  const proposedSpeakers = await labeler.labelSpeakers({
    speakers: document.speakers,
    transcript: document.transcript,
    evidence,
  });

  if (!Array.isArray(proposedSpeakers)) {
    throw new Error('Speaker labeler must return an array');
  }

  const knownIds = new Set(document.speakers.map((speaker) => speaker.id));
  const labels = new Map<string, string>();
  for (const speaker of proposedSpeakers) {
    if (
      !speaker ||
      typeof speaker.id !== 'string' ||
      typeof speaker.label !== 'string' ||
      !speaker.label.trim()
    ) {
      throw new Error('Speaker labeler returned an invalid speaker');
    }
    if (!knownIds.has(speaker.id)) {
      throw new Error(`Speaker labeler returned unknown ID: ${speaker.id}`);
    }
    if (labels.has(speaker.id)) {
      throw new Error(`Speaker labeler returned duplicate ID: ${speaker.id}`);
    }
    labels.set(speaker.id, speaker.label);
  }

  const speakers = document.speakers.map((speaker) => ({
    id: speaker.id,
    label: labels.get(speaker.id) ?? speaker.label,
  }));

  return { ...document, speakers };
}
