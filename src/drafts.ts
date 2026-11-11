import { dirname, join } from 'path';
import { ownerKeys } from './briefs.ts';
import {
  humainRouteRequest,
  NEWER_ENGINE,
  olderHumainEngine,
  olderThanRevision4,
  runHumainMeeting,
  type HumainMeetingRoute,
  type MeetingEngineCheck,
} from './humain-client.ts';
import { MeetingAiOffError, meetingIsPrivateAt, readMeetingArtifact, type MeetingArtifact } from './meeting-artifact.ts';
import { claimsForHumain, engineCheck, meetingSegments, ownerInstructions, retryableRun, runSafeId, stableKey } from './meeting-enrichment.ts';
import { findTranscriptRecord } from './transcript-library.ts';

/**
 * A follow-up written from one meeting: an email with a subject, or a Slack
 * message. Seashell never sends it. It is shown, copied, or opened in the mail
 * app as a draft for the owner to read, change and send themselves.
 */

export type DraftKind = 'email' | 'slack';

export interface DraftParagraph {
  kind: 'greeting' | 'body' | 'closing';
  text: string;
  evidenceSegmentIds: string[];
}

export interface FollowUpDraft {
  kind: DraftKind;
  meetingId: string;
  title: string;
  subject?: string;
  paragraphs: DraftParagraph[];
  /** Where each cited line is in the meeting, in seconds. */
  moments: Record<string, number>;
  /** Addresses for the email's To line: everyone invited, except you. */
  to: string[];
}

export interface DraftOptions {
  /** Who it is for, in words; the people invited, except you, when unset. */
  audience?: string;
  /** Anything else: "keep it to three bullets". */
  ask?: string;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
  runner?: typeof runHumainMeeting;
  engine?: MeetingEngineCheck;
}

const DRAFT_TIMEOUT_MS = 6 * 60_000;
const ASK_LIMIT = 1_000;

function parseDraftOutput(value: unknown, kind: DraftKind, validIds: ReadonlySet<string>): Pick<FollowUpDraft, 'subject' | 'paragraphs'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Humain draft output must be an object');
  const output = value as Record<string, unknown>;
  if (!Array.isArray(output.paragraphs) || !output.paragraphs.length) throw new Error('Humain draft output has no paragraphs');
  const paragraphs = output.paragraphs.map((raw, index): DraftParagraph => {
    const paragraph = raw as Record<string, unknown> | undefined;
    if (!paragraph || !['greeting', 'body', 'closing'].includes(paragraph.kind as string) ||
        typeof paragraph.text !== 'string' || !paragraph.text.trim() || !Array.isArray(paragraph.evidenceSegmentIds) ||
        paragraph.evidenceSegmentIds.some((id) => typeof id !== 'string' || !validIds.has(id))) {
      throw new Error(`Humain draft paragraph ${index} is invalid or cites a line the meeting does not have`);
    }
    return { kind: paragraph.kind as DraftParagraph['kind'], text: paragraph.text.trim(), evidenceSegmentIds: [...paragraph.evidenceSegmentIds] as string[] };
  });
  const subject = typeof output.subject === 'string' && output.subject.trim() ? output.subject.trim() : undefined;
  return { ...(kind === 'email' && subject ? { subject } : {}), paragraphs };
}

/** The people invited, except you: their names for the AI, their addresses for the To line. */
function recipients(libraryDir: string, artifact: MeetingArtifact): { names: string[]; to: string[] } {
  const you = ownerKeys(libraryDir, artifact.calendar);
  const people = [...(artifact.calendar?.attendees ?? []), ...artifact.attendees]
    .filter((person, index, all) => all.findIndex((other) => (other.email || other.name) === (person.email || person.name)) === index)
    .filter((person) => !you.has((person.email?.trim() || person.name.trim()).toLocaleLowerCase('en-US')));
  return { names: people.map((person) => person.name), to: people.flatMap((person) => person.email ? [person.email] : []) };
}

/**
 * Write a follow-up from one meeting. Nothing is saved and nothing is sent: the
 * meeting is read without writing, as agents read it. A private meeting, or one
 * whose meeting.json can't be read, is refused, and privacy is read again just
 * before the request leaves.
 */
export async function draftFollowUp(
  libraryDir: string,
  transcriptId: string,
  kind: DraftKind,
  route: HumainMeetingRoute,
  options: DraftOptions = {},
): Promise<FollowUpDraft> {
  const { record, path } = findTranscriptRecord(libraryDir, transcriptId);
  const directory = dirname(path);
  if (meetingIsPrivateAt(directory)) throw new MeetingAiOffError();
  const artifact = readMeetingArtifact(directory, record);
  if (!artifact) throw new Error('Make it a meeting first: m in Seashell, or seashell meeting create <id>.');
  const segments = meetingSegments(record);
  if (!segments.length) throw new Error('This meeting has no transcript text to write from.');
  const ask = options.ask?.replace(/\s+/gu, ' ').trim();
  if (ask && ask.length > ASK_LIMIT) throw new Error(`Keep the extra ask under ${ASK_LIMIT.toLocaleString('en-US')} characters.`);
  if (await olderThanRevision4(engineCheck(options))) throw new Error(`This AI engine cannot write follow-ups yet. ${NEWER_ENGINE}`);
  const people = recipients(libraryDir, artifact);
  const audience = options.audience?.trim() || (people.names.length ? people.names.join(', ') : undefined);
  const { instructions } = ownerInstructions(libraryDir, artifact, {}, 'chat');
  const finalClaims = claimsForHumain(artifact.analysis?.claims ?? artifact.provisionalClaims, new Set(segments.map((segment) => segment.id)));
  // Checking the engine can take 20 seconds: a meeting made private meanwhile is not sent.
  if (meetingIsPrivateAt(directory)) throw new MeetingAiOffError();
  const context = { calendar: artifact.calendar ?? null, attendees: artifact.attendees };
  const draft = { kind, ...(audience ? { audience } : {}), ...(ask ? { ask } : {}) };
  const idempotencyKey = stableKey([record.id, 'draft', draft, segments, finalClaims, route, context, ...(instructions ? [instructions] : [])]);
  const storeDir = join(dirname(path), '.humain');
  const { runId, idempotencyKey: attemptKey } = retryableRun(storeDir, runSafeId(`meeting-${record.id}-draft-${kind}`, idempotencyKey), idempotencyKey);
  options.onStatus?.(kind === 'email' ? 'Writing the email…' : 'Writing the message…');
  const result = await (options.runner ?? runHumainMeeting)('draft', {
    meetingId: artifact.meetingId,
    ...humainRouteRequest(route),
    segments,
    finalClaims,
    context,
    ...(instructions ? { instructions } : {}),
    draft,
    idempotencyKey: attemptKey,
  }, { storeDir, runId, ...(options.onStatus ? { onStatus: options.onStatus } : {}), ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: DRAFT_TIMEOUT_MS })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw olderHumainEngine(message) ? new Error(`This AI engine cannot write follow-ups yet. ${NEWER_ENGINE}`) : error;
    });
  const output = parseDraftOutput(result.output, kind, new Set(segments.map((segment) => segment.id)));
  const cited = new Set(output.paragraphs.flatMap((paragraph) => paragraph.evidenceSegmentIds));
  return {
    kind, meetingId: record.id, title: artifact.title, ...output,
    moments: Object.fromEntries(segments.filter((segment) => cited.has(segment.id)).map((segment) => [segment.id, segment.start])),
    to: kind === 'email' ? people.to : [],
  };
}

/** The message as it would be pasted: paragraphs a blank line apart, with the subject first for an email. */
export function draftText(draft: Pick<FollowUpDraft, 'subject' | 'paragraphs'>, options: { subject?: boolean } = {}): string {
  const body = draft.paragraphs.map((paragraph) => paragraph.text).join('\n\n');
  return options.subject !== false && draft.subject ? `Subject: ${draft.subject}\n\n${body}` : body;
}

/** A mailto: address that opens a new message with the subject and body filled in. Opening it sends nothing. */
export function mailtoUrl(draft: Pick<FollowUpDraft, 'subject' | 'paragraphs' | 'to'>): string {
  // RFC 6068: line breaks in a body are CRLF.
  const body = draftText(draft, { subject: false }).replace(/\r?\n/gu, '\r\n');
  const fields = [...(draft.subject ? [`subject=${encodeURIComponent(draft.subject)}`] : []), `body=${encodeURIComponent(body)}`];
  return `mailto:${draft.to.map((address) => encodeURIComponent(address).replace(/%40/gu, '@')).join(',')}?${fields.join('&')}`;
}
