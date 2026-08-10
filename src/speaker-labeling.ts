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
  email?: string;
}

/**
 * A meeting adapter can emit this after reading the visible active-speaker
 * indicator. `capturedAt` uses the same recording-relative clock as transcript
 * segments; Sea Shell never uploads the screenshot itself.
 */
export interface ActiveSpeakerObservation {
  capturedAt: number;
  name: string;
  source?: string;
}

export interface SpeakerLabelingEvidence {
  screenshots: MeetScreenshotEvidence[];
  attendees: MeetAttendee[];
  activeSpeakers?: ActiveSpeakerObservation[];
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

type IdentitySource = 'screen' | 'self' | 'peer';

interface IdentityVote {
  score: number;
  sources: Set<IdentitySource>;
}

function normalizedWords(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function hasPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

/**
 * Build aliases that resolve to exactly one roster name. First names are only
 * accepted when unique, so a meeting with two people named Alex stays safe.
 */
function attendeeAliases(attendees: MeetAttendee[]): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  const add = (alias: string, name: string) => {
    if (!alias) return;
    const names = candidates.get(alias) ?? new Set<string>();
    names.add(name);
    candidates.set(alias, names);
  };

  for (const attendee of attendees) {
    const name = attendee.name.trim();
    const normalized = normalizedWords(name);
    if (!name || !normalized) continue;
    add(normalized, name);
    add(normalized.split(' ')[0] ?? '', name);
  }

  return new Map(
    [...candidates]
      .filter(([, names]) => names.size === 1)
      .map(([alias, names]) => [alias, [...names][0]!] as const),
  );
}

function anonymousSpeakerLabel(speaker: Speaker): boolean {
  const label = speaker.label.trim();
  return label === speaker.id || /^(?:SPEAKER|REMOTE)_\d+$|^(?:LOCAL|UNKNOWN)$/i.test(label);
}

function speakerAt(
  transcript: TranscriptSegment[],
  capturedAt: number,
): string | undefined {
  const containing = transcript.filter(
    (segment) =>
      segment.speaker &&
      capturedAt >= segment.start &&
      capturedAt < segment.end,
  );
  const containingSpeakers = new Set(containing.map((segment) => segment.speaker!));
  if (containingSpeakers.size === 1) return [...containingSpeakers][0];
  if (containingSpeakers.size > 1) return undefined;

  const nearby = transcript
    .filter((segment): segment is TranscriptSegment & { speaker: string } => Boolean(segment.speaker))
    .map((segment) => ({
      speaker: segment.speaker,
      distance: capturedAt < segment.start
        ? segment.start - capturedAt
        : capturedAt - segment.end,
    }))
    .filter((candidate) => candidate.distance <= 0.75)
    .toSorted((a, b) => a.distance - b.distance);

  const closest = nearby[0];
  if (!closest) return undefined;
  const conflicting = nearby.find(
    (candidate) =>
      candidate.speaker !== closest.speaker &&
      candidate.distance - closest.distance < 0.2,
  );
  return conflicting ? undefined : closest.speaker;
}

/**
 * Conservative local identity pass. It names diarization clusters only from:
 * timestamped active-speaker observations, roster-matched self-introductions,
 * or an explicit handoff to the next speaker. Conflicts remain anonymous.
 *
 * An opt-in LLM can implement SpeakerLabeler later, but should follow the same
 * contract: choose only from supplied attendees and preserve unknowns.
 */
export class EvidenceSpeakerLabeler implements SpeakerLabeler {
  async labelSpeakers(request: SpeakerLabelingRequest): Promise<Speaker[]> {
    const aliases = attendeeAliases(request.evidence.attendees);
    const votes = new Map<string, Map<string, IdentityVote>>();
    const addVote = (
      speakerId: string | undefined,
      name: string | undefined,
      score: number,
      source: IdentitySource,
    ) => {
      if (!speakerId || !name) return;
      const speakerVotes = votes.get(speakerId) ?? new Map<string, IdentityVote>();
      const vote = speakerVotes.get(name) ?? { score: 0, sources: new Set() };
      vote.score += score;
      vote.sources.add(source);
      speakerVotes.set(name, vote);
      votes.set(speakerId, speakerVotes);
    };

    for (const observation of request.evidence.activeSpeakers ?? []) {
      const name = aliases.get(normalizedWords(observation.name));
      addVote(speakerAt(request.transcript, observation.capturedAt), name, 6, 'screen');
    }

    for (const segment of request.transcript) {
      if (!segment.speaker) continue;
      const text = normalizedWords(segment.text);
      const selfIdentifiedNames = new Set<string>();
      for (const [alias, name] of aliases) {
        const selfIdentified = [
          `my name is ${alias}`,
          `i am ${alias}`,
          `im ${alias}`,
          `this is ${alias}`,
          `${alias} here`,
        ].some((phrase) => hasPhrase(text, phrase));
        if (selfIdentified) selfIdentifiedNames.add(name);
      }
      for (const name of selfIdentifiedNames) addVote(segment.speaker, name, 5, 'self');
    }

    for (const [index, segment] of request.transcript.entries()) {
      const text = normalizedWords(segment.text);
      const handedOffNames = new Set<string>();
      for (const [alias, name] of aliases) {
        const handoff = [
          `over to ${alias}`,
          `hear from ${alias}`,
          `question for ${alias}`,
          `${alias} what do you think`,
          `${alias} can you`,
          `${alias} could you`,
          `${alias} would you`,
          `${alias} go ahead`,
          `${alias} take it away`,
          `${alias} youre up`,
        ].some((phrase) => hasPhrase(text, phrase));
        if (handoff) handedOffNames.add(name);
      }
      const response = request.transcript.slice(index + 1).find((candidate) => {
        if (candidate.start - segment.end > 12) return false;
        return Boolean(
          candidate.speaker &&
          candidate.speaker !== segment.speaker &&
          candidate.text.trim(),
        );
      });
      if (response && response.start - segment.end <= 12) {
        for (const name of handedOffNames) addVote(response.speaker, name, 3, 'peer');
      }
    }

    return request.speakers.map((speaker) => {
      if (!anonymousSpeakerLabel(speaker)) return { ...speaker };
      const ranked = [...(votes.get(speaker.id) ?? new Map())]
        .toSorted(([, a], [, b]) => b.score - a.score);
      const [bestName, bestVote] = ranked[0] ?? [];
      const runnerUp = ranked[1]?.[1].score ?? 0;
      if (!bestName || !bestVote || bestVote.score < 3 || bestVote.score - runnerUp < 2) {
        return { ...speaker };
      }
      return { ...speaker, label: bestName };
    });
  }
}

export function parseSpeakerLabelingEvidence(value: unknown): SpeakerLabelingEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Speaker evidence must be a JSON object');
  }
  const candidate = value as Record<string, unknown>;
  const attendees = candidate.attendees ?? [];
  const screenshots = candidate.screenshots ?? [];
  const activeSpeakers = candidate.activeSpeakers ?? [];
  if (!Array.isArray(attendees) || !Array.isArray(screenshots) || !Array.isArray(activeSpeakers)) {
    throw new Error('Speaker evidence arrays are invalid');
  }

  const parsedAttendees = attendees.map((raw, index): MeetAttendee => {
    if (!raw || typeof raw !== 'object' || typeof (raw as Record<string, unknown>).name !== 'string') {
      throw new Error(`Speaker evidence attendee ${index} is invalid`);
    }
    const attendee = raw as Record<string, unknown>;
    const name = (attendee.name as string).trim();
    if (!name || (attendee.email !== undefined && typeof attendee.email !== 'string')) {
      throw new Error(`Speaker evidence attendee ${index} is invalid`);
    }
    return { name, ...(typeof attendee.email === 'string' ? { email: attendee.email } : {}) };
  });
  const parsedScreenshots = screenshots.map((raw, index): MeetScreenshotEvidence => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Speaker evidence screenshot ${index} is invalid`);
    }
    const screenshot = raw as Record<string, unknown>;
    if (
      typeof screenshot.capturedAt !== 'number' ||
      !Number.isFinite(screenshot.capturedAt) ||
      screenshot.capturedAt < 0 ||
      typeof screenshot.imagePath !== 'string' ||
      !screenshot.imagePath.trim()
    ) {
      throw new Error(`Speaker evidence screenshot ${index} is invalid`);
    }
    return { capturedAt: screenshot.capturedAt, imagePath: screenshot.imagePath };
  });
  const parsedActiveSpeakers = activeSpeakers.map((raw, index): ActiveSpeakerObservation => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Active-speaker observation ${index} is invalid`);
    }
    const observation = raw as Record<string, unknown>;
    if (
      typeof observation.capturedAt !== 'number' ||
      !Number.isFinite(observation.capturedAt) ||
      observation.capturedAt < 0 ||
      typeof observation.name !== 'string' ||
      !observation.name.trim() ||
      (observation.source !== undefined && typeof observation.source !== 'string')
    ) {
      throw new Error(`Active-speaker observation ${index} is invalid`);
    }
    return {
      capturedAt: observation.capturedAt,
      name: observation.name.trim(),
      ...(typeof observation.source === 'string' ? { source: observation.source } : {}),
    };
  });

  return {
    attendees: parsedAttendees,
    screenshots: parsedScreenshots,
    activeSpeakers: parsedActiveSpeakers,
  };
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
