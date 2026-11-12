import { dirname, join } from 'path';
import { ownerKeys } from './briefs.ts';
import {
  humainRouteRequest,
  olderHumainEngine,
  OlderEngineError,
  olderThanRevision4,
  runHumainMeeting,
  type HumainMeetingRoute,
  type MeetingEngineCheck,
} from './humain-client.ts';
import { MeetingAiOffError, meetingIsPrivateAt, readMeetingArtifact, type MeetingArtifact, type OwnerNote } from './meeting-artifact.ts';
import { claimsForHumain, engineCheck, meetingSegments, ownerInstructions, retryableRun, runSafeId, stableKey } from './meeting-enrichment.ts';
import { profileName } from './meeting-templates.ts';
import { meetingOwnerNotes } from './owner-notes.ts';
import { findTranscriptRecord } from './transcript-library.ts';

/**
 * A follow-up written from one meeting: an email with a subject, or a Slack
 * message. Seashell never sends it. It is shown, copied, or opened in the mail
 * app as a draft for the owner to read, change and send themselves.
 */

export type DraftKind = 'email' | 'slack';

export interface DraftParagraph {
  /** A bullet is a point of a list, when you asked for one: its words without a marker; Seashell adds "- ". */
  kind: 'greeting' | 'body' | 'bullet' | 'closing';
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
  /** Who it is for, by name, for the app to show above the subject. */
  names: string[];
  /** Who it is for, each with an address when the invite has one: the To line where there is room for them. */
  people: Array<{ name: string; email?: string }>;
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
/** Humain's limit for `draft.ask`, which carries your extra ask and then your notes. */
const DRAFT_ASK_LIMIT = 2_000;
const MY_NOTES = 'My notes: ';

/**
 * What you asked for, then what you typed about the meeting. Humain's draft takes no owner notes of
 * its own, so they travel in the ask as "My notes:", whole notes first, the last one cut to fit.
 */
export function draftAsk(ask: string | undefined, notes: readonly Pick<OwnerNote, 'text'>[]): string | undefined {
  const typed = notes.map((note) => note.text.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  if (!typed.length) return ask || undefined;
  const lead = ask ? `${ask} ` : '';
  const room = DRAFT_ASK_LIMIT - lead.length - MY_NOTES.length;
  let joined = '';
  for (const text of typed) {
    const next = joined ? `${joined}; ${text}` : text;
    if (next.length <= room) { joined = next; continue; }
    if (!joined) joined = `${text.slice(0, room - 1)}…`;
    break;
  }
  return `${lead}${MY_NOTES}${joined}`;
}

/** A sign-off left waiting for a name: "Talk soon,". */
const DANGLING_SIGN_OFF = /^[^.!?\n]{1,40},$/u;

/** "Talk soon," is signed with your name from About me, or left off: a sign-off with no name dangles. */
function signOff(paragraphs: DraftParagraph[], name: string | undefined): DraftParagraph[] {
  return paragraphs.flatMap((paragraph) => paragraph.kind !== 'closing' || !DANGLING_SIGN_OFF.test(paragraph.text) ? [paragraph]
    : name ? [{ ...paragraph, text: `${paragraph.text} ${name}` }] : []);
}

function parseDraftOutput(value: unknown, kind: DraftKind, validIds: ReadonlySet<string>): Pick<FollowUpDraft, 'subject' | 'paragraphs'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Humain draft output must be an object');
  const output = value as Record<string, unknown>;
  if (!Array.isArray(output.paragraphs) || !output.paragraphs.length) throw new Error('Humain draft output has no paragraphs');
  const paragraphs = output.paragraphs.map((raw, index): DraftParagraph => {
    const paragraph = raw as Record<string, unknown> | undefined;
    if (!paragraph || !['greeting', 'body', 'bullet', 'closing'].includes(paragraph.kind as string) ||
        typeof paragraph.text !== 'string' || !paragraph.text.trim() || !Array.isArray(paragraph.evidenceSegmentIds) ||
        paragraph.evidenceSegmentIds.some((id) => typeof id !== 'string' || !validIds.has(id))) {
      throw new Error(`Humain draft paragraph ${index} is invalid or cites a line the meeting does not have`);
    }
    // A bullet's marker is Seashell's to add, so one the AI wrote anyway is not doubled.
    const text = paragraph.kind === 'bullet' ? paragraph.text.trim().replace(/^[-•*–]\s+/u, '') : paragraph.text.trim();
    return { kind: paragraph.kind as DraftParagraph['kind'], text, evidenceSegmentIds: [...paragraph.evidenceSegmentIds] as string[] };
  });
  const subject = typeof output.subject === 'string' && output.subject.trim() ? output.subject.trim() : undefined;
  return { ...(kind === 'email' && subject ? { subject } : {}), paragraphs };
}

/** The people invited, except you: their names for the AI, their addresses for the To line. */
function recipients(libraryDir: string, artifact: MeetingArtifact): { names: string[]; to: string[]; people: FollowUpDraft['people'] } {
  const you = ownerKeys(libraryDir, artifact.calendar);
  const people = [...(artifact.calendar?.attendees ?? []), ...artifact.attendees]
    .filter((person, index, all) => all.findIndex((other) => (other.email || other.name) === (person.email || person.name)) === index)
    .filter((person) => !you.has((person.email?.trim() || person.name.trim()).toLocaleLowerCase('en-US')));
  return { names: people.map((person) => person.name), to: people.flatMap((person) => person.email ? [person.email] : []),
    people: people.map((person) => ({ name: person.name, ...(person.email ? { email: person.email } : {}) })) };
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
  const typedAsk = options.ask?.replace(/\s+/gu, ' ').trim();
  if (typedAsk && typedAsk.length > ASK_LIMIT) throw new Error(`Keep the extra ask under ${ASK_LIMIT.toLocaleString('en-US')} characters.`);
  // What you typed about the meeting, during the call or after it, so the email says what you just noted.
  const ask = draftAsk(typedAsk, meetingOwnerNotes(libraryDir, record.id, artifact));
  if (await olderThanRevision4(engineCheck(options))) throw new OlderEngineError('This AI engine cannot write follow-ups yet.');
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
      throw olderHumainEngine(message) ? new OlderEngineError('This AI engine cannot write follow-ups yet.') : error;
    });
  const parsed = parseDraftOutput(result.output, kind, new Set(segments.map((segment) => segment.id)));
  const output = { ...parsed, paragraphs: signOff(parsed.paragraphs, profileName(libraryDir)) };
  const cited = new Set(output.paragraphs.flatMap((paragraph) => paragraph.evidenceSegmentIds));
  return {
    kind, meetingId: record.id, title: artifact.title, ...output,
    moments: Object.fromEntries(segments.filter((segment) => cited.has(segment.id)).map((segment) => [segment.id, segment.start])),
    to: kind === 'email' ? people.to : [],
    names: people.names,
    people: people.people,
  };
}

/** A paragraph as it reads: a bullet with its "- ". */
export function draftParagraphText(paragraph: Pick<DraftParagraph, 'kind' | 'text'>): string {
  return paragraph.kind === 'bullet' ? `- ${paragraph.text}` : paragraph.text;
}

/** Whether a paragraph follows the one before it on the next line: bullets in a row are one list. */
export function continuesList(paragraphs: readonly Pick<DraftParagraph, 'kind'>[], index: number): boolean {
  return index > 0 && paragraphs[index]!.kind === 'bullet' && paragraphs[index - 1]!.kind === 'bullet';
}

/** The message as it would be pasted: paragraphs a blank line apart, a list a line a bullet, with the subject first for an email. */
export function draftText(draft: Pick<FollowUpDraft, 'subject' | 'paragraphs'>, options: { subject?: boolean } = {}): string {
  const body = draft.paragraphs.map((paragraph, index) =>
    `${index === 0 ? '' : continuesList(draft.paragraphs, index) ? '\n' : '\n\n'}${draftParagraphText(paragraph)}`).join('');
  return options.subject !== false && draft.subject ? `Subject: ${draft.subject}\n\n${body}` : body;
}

/** A mailto: address that opens a new message with the subject and body filled in. Opening it sends nothing. */
export function mailtoUrl(draft: Pick<FollowUpDraft, 'subject' | 'paragraphs' | 'to'>): string {
  // RFC 6068: line breaks in a body are CRLF.
  const body = draftText(draft, { subject: false }).replace(/\r?\n/gu, '\r\n');
  const fields = [...(draft.subject ? [`subject=${encodeURIComponent(draft.subject)}`] : []), `body=${encodeURIComponent(body)}`];
  return `mailto:${draft.to.map((address) => encodeURIComponent(address).replace(/%40/gu, '@')).join(',')}?${fields.join('&')}`;
}
