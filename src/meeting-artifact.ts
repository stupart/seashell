import { createHash, randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import { findTranscriptRecord } from './transcript-library.ts';
import { renderSrt, renderText, renderVtt } from './transcript-renderer.ts';
import type { TranscriptRecord } from './transcript-types.ts';
import { compareMeetingEvidence, meetingEvidence, parseMeetingEvidence, type MeetingEvidence } from './meeting-evidence.ts';
import { forgetMeetingVoices } from './voiceprints.ts';

export const MEETING_CLAIM_TYPES = [
  'speaker_identity',
  'decision',
  'action_item',
  'date',
  'fact',
  'feedback',
  'note',
  'resource',
  'highlight',
  'risk',
  'open_question',
  'follow_up',
] as const;

export type MeetingClaimType = typeof MEETING_CLAIM_TYPES[number];
export type MeetingEnrichmentMode = 'streaming' | 'post-session' | 'hybrid';
export type MeetingArtifactStatus = 'base-only' | 'observing' | 'reconciling' | 'ready' | 'failed';

export interface MeetingAttendee {
  name: string;
  email?: string;
  response?: string;
}

export interface MeetingCalendarEvent {
  provider: string;
  eventId: string;
  calendar?: string;
  title: string;
  startAt: string;
  endAt: string;
  location?: string;
  joinUrl?: string;
  attendees: MeetingAttendee[];
}

export interface MeetingClaim {
  id: string;
  type: MeetingClaimType;
  text: string;
  evidenceSegmentIds: string[];
  /** Lines this cited that are no longer in the transcript. See withCurrentCitations. */
  removedEvidenceSegmentIds?: string[];
  confidence: number;
  speakerId?: string;
  /** Who owns an action or follow-up, as said. */
  person?: string;
  /** When an action or follow-up is due, as said: "by Friday". */
  due?: string;
  /** The owner's notes this came from. It may cite no transcript at all when only a note says it. */
  ownerNoteIds?: string[];
}

/** One point of templated notes, with the transcript segments it rests on. */
export interface MeetingNoteItem {
  text: string;
  evidenceSegmentIds: string[];
  /** Lines this cited that are no longer in the transcript. See withCurrentCitations. */
  removedEvidenceSegmentIds?: string[];
  /** The owner's notes it came from; with these, it may cite no transcript. */
  ownerNoteIds?: string[];
}

/**
 * Something the owner typed about the meeting, during the call or after it.
 * `at` is seconds on the transcript's clock; a note added later about the
 * meeting as a whole has none.
 */
export interface OwnerNote {
  id: string;
  text: string;
  at?: number;
  /** When it was written, for the record; never sent. */
  addedAt: string;
}

/** Humain's limits for `ownerNotes`. */
export const OWNER_NOTE_LIMITS = { notes: 200, text: 2_000 } as const;

/** A template heading and what the meeting said under it; empty when it did not come up. */
export interface MeetingNoteSection {
  heading: string;
  items: MeetingNoteItem[];
}

export interface MeetingAnalysis {
  final: boolean;
  summary: string;
  claims: MeetingClaim[];
  runId: string;
  createdAt: string;
  /** The template the notes follow, when one was used. */
  template?: string;
  notes?: MeetingNoteSection[];
  /** The owner wrote notes, and the engine that wrote these was too old to read them. */
  ownerNotesUnread?: true;
}

/** The owner's choices for this meeting's AI, made before or after it ran. */
export interface MeetingAiSettings {
  /** A template name, or "none" for no templated notes. Unset: chosen from the calendar title. */
  template?: string;
  /** Guidance for this meeting only: "focus on pricing". */
  note?: string;
  /** No AI for this meeting: no live analysis, notes or chat, and agents are refused it. */
  off?: boolean;
}

/** A meeting the owner turned AI off for. Every path that would send it to a model throws this. */
export class MeetingAiOffError extends Error {
  constructor() {
    super('AI is off for this meeting. Turn it on with [N] in the meeting, or: seashell meeting ai <id> on');
    this.name = 'MeetingAiOffError';
  }
}

/** What one extractor found in a meeting: its fields in order, every item cited. */
export interface MeetingInsight {
  extractor: string;
  createdAt: string;
  runId: string;
  summary?: string;
  fields: { name: string; items: MeetingNoteItem[] }[];
  /**
   * The transcript changed after this was found (see notesOutdated). Each
   * insight keeps its own mark until it runs again: rewriting the notes does
   * not run an extractor that only runs by hand.
   */
  outdated?: { at: string; reason: string };
}

export interface MeetingProvisionalOverlay {
  schemaVersion: 1;
  runId: string;
  observedAt: string;
  fromCursor: number;
  toCursor: number;
  summary: string;
  claims: MeetingClaim[];
  transcriptRevision?: string;
}

export interface MeetingChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  evidenceSegmentIds?: string[];
  /** Lines this cited that are no longer in the transcript. See withCurrentCitations. */
  removedEvidenceSegmentIds?: string[];
  runId?: string;
}

export interface MeetingArtifact {
  schemaVersion: 1;
  meetingId: string;
  transcriptId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: MeetingArtifactStatus;
  mode: MeetingEnrichmentMode;
  calendar?: MeetingCalendarEvent;
  attendees: MeetingAttendee[];
  session: {
    cursor: number;
    overlapSegments: number;
    observerRunIds: string[];
    reconciliationRunId?: string;
    maxObserverRuns: number;
    stoppedReason?: 'meeting-ended' | 'budget-exhausted' | 'cancelled' | 'failed';
  };
  provisionalClaims: MeetingClaim[];
  analysis?: MeetingAnalysis;
  ai?: MeetingAiSettings;
  /** The app the call ran in, when the background recorder saw it: "Zoom". */
  app?: string;
  /** Extractor results, also written to insights/<name>.json and .md. */
  insights?: MeetingInsight[];
  /** What the owner typed, in the order it was written. Kept through every rewrite of the notes. */
  ownerNotes?: OwnerNote[];
  /**
   * Words changed after the notes were written (a corrected line, a removed
   * phantom line) and the notes were kept rather than cleared. They may no
   * longer match the transcript until notes run again.
   */
  notesOutdated?: { at: string; reason: string };
  chat: MeetingChatMessage[];
  failure?: string;
  /** Content binding, independent of positional segment IDs and modified times. */
  transcriptEvidence?: MeetingEvidence;
}

export interface CreateMeetingArtifactOptions {
  mode?: MeetingEnrichmentMode;
  calendar?: MeetingCalendarEvent;
  attendees?: MeetingAttendee[];
  maxObserverRuns?: number;
  overlapSegments?: number;
  now?: Date;
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || Number(resolved) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(resolved);
}

export function transcriptSegmentId(record: TranscriptRecord, index: number): string {
  return record.transcript[index]?.id?.trim() || `s${String(index + 1).padStart(6, '0')}`;
}

export function createMeetingArtifact(
  record: TranscriptRecord,
  options: CreateMeetingArtifactOptions = {},
): MeetingArtifact {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const calendarAttendees = options.calendar?.attendees ?? [];
  return {
    schemaVersion: 1,
    meetingId: record.id,
    transcriptId: record.id,
    title: options.calendar?.title?.trim() || record.title,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'base-only',
    mode: options.mode ?? 'hybrid',
    ...(options.calendar ? { calendar: options.calendar } : {}),
    attendees: (options.attendees ?? calendarAttendees).map((attendee) => ({ ...attendee })),
    session: {
      cursor: 0,
      overlapSegments: positiveInteger(options.overlapSegments, 2, 'overlapSegments'),
      observerRunIds: [],
      maxObserverRuns: positiveInteger(options.maxObserverRuns, 24, 'maxObserverRuns'),
    },
    provisionalClaims: [],
    chat: [],
    transcriptEvidence: meetingEvidence(record),
  };
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

/** A saved list of cited lines no longer in the transcript; absent when there are none. */
function parseRemovedEvidence(value: unknown, label: string): { removedEvidenceSegmentIds?: string[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error(`${label} removedEvidenceSegmentIds must be strings`);
  }
  return value.length ? { removedEvidenceSegmentIds: [...value] as string[] } : {};
}

function parseAttendees(value: unknown): MeetingAttendee[] {
  if (!Array.isArray(value)) throw new Error('meeting attendees must be an array');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`meeting attendee ${index} is invalid`);
    }
    const attendee = raw as Record<string, unknown>;
    return {
      name: string(attendee.name, `meeting attendee ${index} name`),
      ...(optionalString(attendee.email, `meeting attendee ${index} email`) === undefined
        ? {}
        : { email: attendee.email as string }),
      ...(optionalString(attendee.response, `meeting attendee ${index} response`) === undefined
        ? {}
        : { response: attendee.response as string }),
    };
  });
}

export function parseMeetingClaim(value: unknown, label = 'meeting claim'): MeetingClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const claim = value as Record<string, unknown>;
  if (!MEETING_CLAIM_TYPES.includes(claim.type as MeetingClaimType)) {
    throw new Error(`${label} has an unsupported type`);
  }
  if (
    typeof claim.confidence !== 'number' ||
    !Number.isFinite(claim.confidence) ||
    claim.confidence < 0 ||
    claim.confidence > 1
  ) {
    throw new Error(`${label} confidence must be between 0 and 1`);
  }
  if (
    !Array.isArray(claim.evidenceSegmentIds) ||
    claim.evidenceSegmentIds.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    throw new Error(`${label} evidenceSegmentIds must be strings`);
  }
  return {
    id: string(claim.id, `${label} id`),
    type: claim.type as MeetingClaimType,
    text: string(claim.text, `${label} text`),
    evidenceSegmentIds: [...claim.evidenceSegmentIds] as string[],
    ...parseRemovedEvidence(claim.removedEvidenceSegmentIds, label),
    confidence: claim.confidence,
    ...(optionalString(claim.speakerId, `${label} speakerId`) === undefined
      ? {}
      : { speakerId: claim.speakerId as string }),
    ...(optionalString(claim.person, `${label} person`) === undefined
      ? {}
      : { person: claim.person as string }),
    // Humain allows a due date only on actions and follow-ups, including on claims sent back to it.
    ...(optionalString(claim.due, `${label} due`) === undefined || (claim.type !== 'action_item' && claim.type !== 'follow_up')
      ? {}
      : { due: claim.due as string }),
    ...ownerNoteIdsOf(claim.ownerNoteIds, label),
  };
}

/** Which of the owner's notes something came from: present only when it names one. */
function ownerNoteIdsOf(value: unknown, label: string): { ownerNoteIds?: string[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error(`${label} ownerNoteIds must be strings`);
  }
  return value.length ? { ownerNoteIds: [...value] as string[] } : {};
}

/** A cited point rests on the transcript, the owner's notes, or both: never on nothing. */
export function citesNothing(item: { evidenceSegmentIds: readonly string[]; ownerNoteIds?: readonly string[] }): boolean {
  return item.evidenceSegmentIds.length === 0 && !item.ownerNoteIds?.length;
}

export function parseOwnerNote(value: unknown, label = 'owner note'): OwnerNote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const note = value as Record<string, unknown>;
  const text = string(note.text, `${label} text`);
  if (text.length > OWNER_NOTE_LIMITS.text) throw new Error(`${label} is longer than ${OWNER_NOTE_LIMITS.text.toLocaleString('en-US')} characters`);
  if (note.at !== undefined && (typeof note.at !== 'number' || !Number.isFinite(note.at) || note.at < 0)) {
    throw new Error(`${label} at must be seconds from the start`);
  }
  return {
    id: string(note.id, `${label} id`),
    text,
    ...(note.at === undefined ? {} : { at: Math.round((note.at as number) * 1000) / 1000 }),
    addedAt: string(note.addedAt, `${label} addedAt`),
  };
}

function parseCalendar(value: unknown): MeetingCalendarEvent | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('meeting calendar must be an object');
  }
  const calendar = value as Record<string, unknown>;
  return {
    provider: string(calendar.provider, 'calendar provider'),
    eventId: string(calendar.eventId, 'calendar eventId'),
    ...(optionalString(calendar.calendar, 'calendar name') === undefined
      ? {}
      : { calendar: calendar.calendar as string }),
    title: string(calendar.title, 'calendar title'),
    startAt: string(calendar.startAt, 'calendar startAt'),
    endAt: string(calendar.endAt, 'calendar endAt'),
    ...(optionalString(calendar.location, 'calendar location') === undefined
      ? {}
      : { location: calendar.location as string }),
    ...(optionalString(calendar.joinUrl, 'calendar joinUrl') === undefined
      ? {}
      : { joinUrl: calendar.joinUrl as string }),
    attendees: parseAttendees(calendar.attendees ?? []),
  };
}

function parseAnalysis(value: unknown): MeetingAnalysis | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('meeting analysis must be an object');
  }
  const analysis = value as Record<string, unknown>;
  if (typeof analysis.final !== 'boolean' || !Array.isArray(analysis.claims)) {
    throw new Error('meeting analysis is invalid');
  }
  return {
    final: analysis.final,
    summary: string(analysis.summary, 'meeting analysis summary'),
    claims: analysis.claims.map((claim, index) => parseMeetingClaim(claim, `analysis claim ${index}`)),
    runId: string(analysis.runId, 'meeting analysis runId'),
    createdAt: string(analysis.createdAt, 'meeting analysis createdAt'),
    ...(optionalString(analysis.template, 'meeting analysis template') === undefined
      ? {}
      : { template: analysis.template as string }),
    ...(analysis.notes === undefined ? {} : { notes: parseMeetingNotes(analysis.notes) }),
    ...(analysis.ownerNotesUnread === true ? { ownerNotesUnread: true as const } : {}),
  };
}

/**
 * A cited point: notes, insights. Every one must rest on at least one segment,
 * or record the lines it rested on that were since removed.
 */
export function parseMeetingNoteItems(value: unknown, label: string): MeetingNoteItem[] {
  if (!Array.isArray(value)) throw new Error(`${label} items must be an array`);
  return value.map((item, itemIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label} item ${itemIndex} is invalid`);
    }
    const note = item as Record<string, unknown>;
    const removed = parseRemovedEvidence(note.removedEvidenceSegmentIds, `${label} item ${itemIndex}`);
    const fromNotes = ownerNoteIdsOf(note.ownerNoteIds, `${label} item ${itemIndex}`);
    // A point from the owner's notes alone may cite no transcript; any other must cite some, now or before a line was removed.
    if (!Array.isArray(note.evidenceSegmentIds) ||
        (note.evidenceSegmentIds.length === 0 && !removed.removedEvidenceSegmentIds && !fromNotes.ownerNoteIds) ||
        note.evidenceSegmentIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new Error(`${label} item ${itemIndex} must cite transcript segments`);
    }
    return {
      text: string(note.text, `${label} item ${itemIndex} text`),
      evidenceSegmentIds: [...note.evidenceSegmentIds] as string[],
      ...removed,
      ...fromNotes,
    };
  });
}

export function parseMeetingNotes(value: unknown, label = 'meeting notes'): MeetingNoteSection[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} section ${index} is invalid`);
    const section = raw as Record<string, unknown>;
    return {
      heading: string(section.heading, `${label} section ${index} heading`),
      items: parseMeetingNoteItems(section.items, `${label} section ${index}`),
    };
  });
}

function parseOutdated(value: unknown, label: string): { at: string; reason: string } | undefined {
  if (value === undefined) return undefined;
  const outdated = value as Record<string, unknown> | null;
  return { at: string(outdated?.at, `${label} at`), reason: string(outdated?.reason, `${label} reason`) };
}

export function parseMeetingInsight(value: unknown, label = 'meeting insight'): MeetingInsight {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const insight = value as Record<string, unknown>;
  if (!Array.isArray(insight.fields)) throw new Error(`${label} fields must be an array`);
  const summary = typeof insight.summary === 'string' && insight.summary.trim() ? insight.summary.trim() : undefined;
  const outdated = parseOutdated(insight.outdated, `${label} outdated`);
  return {
    extractor: string(insight.extractor, `${label} extractor`),
    createdAt: string(insight.createdAt, `${label} createdAt`),
    runId: string(insight.runId, `${label} runId`),
    ...(summary ? { summary } : {}),
    ...(outdated ? { outdated } : {}),
    fields: insight.fields.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} field ${index} is invalid`);
      const field = raw as Record<string, unknown>;
      return {
        name: string(field.name, `${label} field ${index} name`),
        items: parseMeetingNoteItems(field.items, `${label} field ${index}`),
      };
    }),
  };
}

function parseAiSettings(value: unknown): MeetingAiSettings | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('meeting AI settings must be an object');
  const ai = value as Record<string, unknown>;
  const template = optionalString(ai.template, 'meeting AI template');
  const note = optionalString(ai.note, 'meeting AI note');
  if (ai.off !== undefined && typeof ai.off !== 'boolean') throw new Error('meeting AI off must be true or false');
  return {
    ...(template === undefined ? {} : { template }),
    ...(note === undefined ? {} : { note }),
    ...(ai.off === true ? { off: true } : {}),
  };
}

/**
 * The owner's AI choices for a meeting, read straight from meeting.json without
 * reconciling it against the transcript — for keeping them across a rewrite.
 */
export function readMeetingAiSettings(libraryDir: string, transcriptId: string): MeetingAiSettings | undefined {
  try {
    return readMeetingAiSettingsAt(dirname(meetingArtifactPath(libraryDir, transcriptId)));
  } catch {
    return undefined;
  }
}

/**
 * The same, for a transcript folder already in hand. A meeting.json that is
 * there but can't be read might have said AI is off, so it reads as off: when
 * in doubt, nothing is shared, and the owner can turn AI back on.
 */
export function readMeetingAiSettingsAt(directory: string): MeetingAiSettings | undefined {
  const path = join(directory, 'meeting.json');
  if (!existsSync(path)) return undefined;
  try {
    const ai = parseAiSettings((JSON.parse(readFileSync(path, 'utf8')) as { ai?: unknown }).ai);
    return ai && Object.keys(ai).length ? ai : undefined;
  } catch {
    return { off: true };
  }
}

/** Whether the owner turned AI off for the meeting in this folder, or its settings can't be read to tell. */
export function meetingIsPrivateAt(directory: string): boolean {
  return readMeetingAiSettingsAt(directory)?.off === true;
}

export function parseMeetingArtifact(value: unknown, path = 'meeting.json'): MeetingArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must contain a meeting object`);
  }
  const artifact = value as Record<string, unknown>;
  const statuses: MeetingArtifactStatus[] = ['base-only', 'observing', 'reconciling', 'ready', 'failed'];
  const modes: MeetingEnrichmentMode[] = ['streaming', 'post-session', 'hybrid'];
  if (
    artifact.schemaVersion !== 1 ||
    !statuses.includes(artifact.status as MeetingArtifactStatus) ||
    !modes.includes(artifact.mode as MeetingEnrichmentMode) ||
    !artifact.session ||
    typeof artifact.session !== 'object' ||
    Array.isArray(artifact.session) ||
    !Array.isArray(artifact.provisionalClaims) ||
    !Array.isArray(artifact.chat)
  ) {
    throw new Error(`${path} is not a supported Sea Shell meeting artifact`);
  }
  const session = artifact.session as Record<string, unknown>;
  const stoppedReasons = ['meeting-ended', 'budget-exhausted', 'cancelled', 'failed'];
  if (
    !Number.isSafeInteger(session.cursor) || Number(session.cursor) < 0 ||
    !Array.isArray(session.observerRunIds) ||
    session.observerRunIds.some((id) => typeof id !== 'string') ||
    (session.stoppedReason !== undefined && !stoppedReasons.includes(String(session.stoppedReason)))
  ) {
    throw new Error(`${path} has invalid meeting session state`);
  }
  const calendar = parseCalendar(artifact.calendar);
  const analysis = parseAnalysis(artifact.analysis);
  const ai = parseAiSettings(artifact.ai);
  const transcriptEvidence = parseMeetingEvidence(artifact.transcriptEvidence);
  if (artifact.insights !== undefined && !Array.isArray(artifact.insights)) throw new Error(`${path} insights must be an array`);
  const outdated = parseOutdated(artifact.notesOutdated, 'notesOutdated');
  // Insights saved before each kept its own mark share the meeting's, if they are older than it.
  const insights = artifact.insights?.map((insight, index) => parseMeetingInsight(insight, `insight ${index}`))
    .map((insight) => outdated && !insight.outdated && Date.parse(insight.createdAt) <= Date.parse(outdated.at) ? { ...insight, outdated } : insight);
  if (artifact.ownerNotes !== undefined && !Array.isArray(artifact.ownerNotes)) throw new Error(`${path} ownerNotes must be an array`);
  const ownerNotes = artifact.ownerNotes?.map((note, index) => parseOwnerNote(note, `owner note ${index}`));
  return {
    schemaVersion: 1,
    meetingId: string(artifact.meetingId, 'meetingId'),
    transcriptId: string(artifact.transcriptId, 'transcriptId'),
    title: string(artifact.title, 'meeting title'),
    createdAt: string(artifact.createdAt, 'meeting createdAt'),
    updatedAt: string(artifact.updatedAt, 'meeting updatedAt'),
    status: artifact.status as MeetingArtifactStatus,
    mode: artifact.mode as MeetingEnrichmentMode,
    ...(transcriptEvidence ? { transcriptEvidence } : {}),
    ...(calendar === undefined ? {} : { calendar }),
    attendees: parseAttendees(artifact.attendees ?? []),
    session: {
      cursor: Number(session.cursor),
      overlapSegments: positiveInteger(session.overlapSegments, 2, 'overlapSegments'),
      observerRunIds: [...session.observerRunIds] as string[],
      ...(optionalString(session.reconciliationRunId, 'reconciliationRunId') === undefined
        ? {}
        : { reconciliationRunId: session.reconciliationRunId as string }),
      maxObserverRuns: positiveInteger(session.maxObserverRuns, 24, 'maxObserverRuns'),
      ...(session.stoppedReason === undefined
        ? {}
        : { stoppedReason: session.stoppedReason as MeetingArtifact['session']['stoppedReason'] }),
    },
    provisionalClaims: artifact.provisionalClaims.map((claim, index) =>
      parseMeetingClaim(claim, `provisional claim ${index}`)),
    ...(analysis === undefined ? {} : { analysis }),
    ...(ai === undefined || Object.keys(ai).length === 0 ? {} : { ai }),
    ...(optionalString(artifact.app, 'meeting app') === undefined ? {} : { app: artifact.app as string }),
    ...(insights?.length ? { insights } : {}),
    ...(ownerNotes?.length ? { ownerNotes } : {}),
    ...(outdated === undefined ? {} : { notesOutdated: outdated }),
    chat: artifact.chat.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`chat message ${index} is invalid`);
      }
      const message = raw as Record<string, unknown>;
      if (message.role !== 'user' && message.role !== 'assistant') {
        throw new Error(`chat message ${index} role is invalid`);
      }
      return {
        id: string(message.id, `chat message ${index} id`),
        role: message.role,
        text: string(message.text, `chat message ${index} text`),
        createdAt: string(message.createdAt, `chat message ${index} createdAt`),
        ...(message.evidenceSegmentIds === undefined
          ? {}
          : Array.isArray(message.evidenceSegmentIds) &&
              message.evidenceSegmentIds.every((id) => typeof id === 'string' && id.trim())
            ? { evidenceSegmentIds: [...message.evidenceSegmentIds] as string[] }
            : (() => { throw new Error(`chat message ${index} evidence is invalid`); })()),
        ...parseRemovedEvidence(message.removedEvidenceSegmentIds, `chat message ${index}`),
        ...(optionalString(message.runId, `chat message ${index} runId`) === undefined
          ? {}
          : { runId: message.runId as string }),
      };
    }),
    ...(optionalString(artifact.failure, 'meeting failure') === undefined
      ? {}
      : { failure: artifact.failure as string }),
  };
}

export function meetingArtifactPath(libraryDir: string, transcriptId: string): string {
  return join(dirname(findTranscriptRecord(libraryDir, transcriptId).path), 'meeting.json');
}

export function loadMeetingArtifact(
  libraryDir: string,
  transcriptId: string,
): MeetingArtifact | undefined {
  const found = findTranscriptRecord(libraryDir, transcriptId);
  const path = join(dirname(found.path), 'meeting.json');
  if (!existsSync(path)) return undefined;
  try {
    const artifact = synchronizeMeetingTranscript(dirname(path), found.record);
    return artifact && withCurrentCitations(artifact, found.record);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${path} contains malformed JSON`);
    throw error;
  }
}

type Cited = Pick<MeetingNoteItem, 'removedEvidenceSegmentIds'> & { evidenceSegmentIds?: string[] };

/** Every line a point cited, those still in the transcript first. */
export function citedSegmentIds(item: Cited): string[] {
  return [...(item.evidenceSegmentIds ?? []), ...(item.removedEvidenceSegmentIds ?? [])];
}

/**
 * A point that cited lines, none of which the transcript still has. A point
 * that only ever rested on the owner's notes cited no line, so it is never
 * this: it has nothing removed, and stays the owner's.
 */
export function sourceLineRemoved(item: Cited): boolean {
  return !item.evidenceSegmentIds?.length && Boolean(item.removedEvidenceSegmentIds?.length);
}

/**
 * Every citation split into the lines the transcript has now and the lines
 * removed from it: a phantom line cleaned away, or an older transcript
 * restored without it. A point whose every line is gone stays, marked, rather
 * than vanishing or pointing at nothing; one whose lines come back cites them
 * again. Notes, insights and chat answers saved before this split heal the
 * next time they are read. Returns the same object when nothing changed.
 */
export function withCurrentCitations(artifact: MeetingArtifact, record: TranscriptRecord): MeetingArtifact {
  const current = new Set(record.transcript.map((_segment, index) => transcriptSegmentId(record, index)));
  let changed = false;
  const cite = <T extends Cited>(item: T): T => {
    const evidence = item.evidenceSegmentIds ?? [];
    const removed = item.removedEvidenceSegmentIds ?? [];
    if (evidence.every((id) => current.has(id)) && !removed.some((id) => current.has(id))) return item;
    changed = true;
    const all = [...new Set([...evidence, ...removed])];
    const gone = all.filter((id) => !current.has(id));
    const { removedEvidenceSegmentIds: _removed, ...rest } = item;
    return { ...rest, evidenceSegmentIds: all.filter((id) => current.has(id)), ...(gone.length ? { removedEvidenceSegmentIds: gone } : {}) } as T;
  };
  const next: MeetingArtifact = {
    ...artifact,
    provisionalClaims: artifact.provisionalClaims.map(cite),
    ...(artifact.analysis ? { analysis: { ...artifact.analysis, claims: artifact.analysis.claims.map(cite),
      ...(artifact.analysis.notes ? { notes: artifact.analysis.notes.map((section) => ({ ...section, items: section.items.map(cite) })) } : {}) } } : {}),
    ...(artifact.insights ? { insights: artifact.insights.map((insight) => ({ ...insight,
      fields: insight.fields.map((field) => ({ ...field, items: field.items.map(cite) })) })) } : {}),
    chat: artifact.chat.map(cite),
  };
  return changed ? next : artifact;
}

/**
 * What a point rests on, for the Markdown copies of the notes: the lines it
 * cites, or that they were removed, and "your notes" when it came from them.
 */
function citationText(item: Cited & { ownerNoteIds?: readonly string[] }): string {
  return [
    ...(sourceLineRemoved(item) ? ['source line removed'] : item.evidenceSegmentIds ?? []),
    ...(item.ownerNoteIds?.length ? ['your notes'] : []),
  ].join(', ');
}

/** "Dana · by Friday": who owns an action or follow-up and when it is due, as said. */
export function claimOwnerAndDue(claim: Pick<MeetingClaim, 'person' | 'due'>): string | undefined {
  return [claim.person, claim.due].filter(Boolean).join(' · ') || undefined;
}

function markdownList(claims: MeetingClaim[]): string {
  return claims.length > 0
    ? claims.map((claim) => {
      const owner = claim.type === 'action_item' || claim.type === 'follow_up' ? claimOwnerAndDue(claim) : undefined;
      return `- ${claim.text}${owner ? ` (${owner})` : ''} _(${citationText(claim)})_`;
    }).join('\n')
    : '- None captured.';
}

/** "12:04" or "1:02:04": where in the meeting a note was written. */
function noteClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const rest = `${String(Math.floor(whole % 3600 / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${rest}` : rest;
}

/** What the owner typed about the meeting, readable without Seashell. */
export function ownerNotesMarkdown(title: string, notes: readonly OwnerNote[]): string {
  return `# Your notes\n\n_${title}_\n\n${notes.map((note) => `- ${note.at === undefined ? '' : `${noteClock(note.at)} `}${note.text}`).join('\n')}\n`;
}

function documentFor(artifact: MeetingArtifact, type: MeetingClaimType, title: string): string {
  const claims = (artifact.analysis?.claims ?? artifact.provisionalClaims)
    .filter((claim) => claim.type === type);
  return `# ${title}\n\n${markdownList(claims)}\n`;
}

/** The notes as their template laid them out, each point with the segments it cites. */
export function templatedNotesMarkdown(title: string, analysis: MeetingAnalysis): string {
  const sections = (analysis.notes ?? []).map((section) => `## ${section.heading}\n\n${
    section.items.length
      ? section.items.map((item) => `- ${item.text} _(${citationText(item)})_`).join('\n')
      : '- Not discussed.'
  }`);
  return `# ${title}\n\n${analysis.template ? `_${analysis.template} notes_\n\n` : ''}${analysis.summary}\n\n${sections.join('\n\n')}\n`;
}

/** A file name for an extractor: "Customer pains" is customer-pains. */
export function insightFileName(extractor: string): string {
  return extractor.normalize('NFKD').replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '').toLowerCase().slice(0, 60) || 'insight';
}

export function insightMarkdown(title: string, insight: MeetingInsight): string {
  const fields = insight.fields.map((field) => `## ${field.name}\n\n${field.items.length
    ? field.items.map((item) => `- ${item.text} _(${citationText(item)})_`).join('\n')
    : '- Not covered.'}`);
  const outdated = insight.outdated ? `_${insight.outdated.reason} after this was found, so it may be out of date._\n\n` : '';
  return `# ${insight.extractor}\n\n_${title}_\n\n${outdated}${insight.summary ? `${insight.summary}\n\n` : ''}${fields.join('\n\n')}\n`;
}

/** insights/ mirrors meeting.json: one JSON and one Markdown file per extractor, nothing stale. */
function writeInsightProjections(directory: string, artifact: MeetingArtifact): void {
  const folder = join(directory, 'insights');
  const wanted = new Set<string>();
  for (const insight of artifact.insights ?? []) {
    const name = insightFileName(insight.extractor);
    wanted.add(`${name}.json`); wanted.add(`${name}.md`);
    atomicWrite(join(folder, `${name}.json`), `${JSON.stringify({ schemaVersion: 1, meetingId: artifact.meetingId,
      title: artifact.title, transcriptRevision: artifact.transcriptEvidence?.revision, ...insight }, null, 2)}\n`);
    atomicWrite(join(folder, `${name}.md`), insightMarkdown(artifact.title, insight));
  }
  if (!existsSync(folder)) return;
  for (const file of readdirSync(folder)) {
    if (/\.(?:json|md)$/u.test(file) && !wanted.has(file)) rmSync(join(folder, file), { force: true });
  }
}

function writeMeetingProjections(
  directory: string,
  artifact: MeetingArtifact,
  record: TranscriptRecord,
): void {
  const analysis = artifact.analysis;
  if (analysis) {
    atomicWrite(join(directory, 'overlays', 'final.json'), `${JSON.stringify(analysis, null, 2)}\n`);
  } else {
    rmSync(join(directory, 'overlays', 'final.json'), { force: true });
  }
  atomicWrite(
    join(directory, 'documents', 'summary.md'),
    `# Summary\n\n${analysis?.summary || 'No final summary yet.'}\n`,
  );
  atomicWrite(join(directory, 'documents', 'decisions.md'), documentFor(artifact, 'decision', 'Decisions'));
  atomicWrite(join(directory, 'documents', 'actions.md'), documentFor(artifact, 'action_item', 'Actions'));
  atomicWrite(join(directory, 'documents', 'notes.md'), documentFor(artifact, 'note', 'Notes'));
  atomicWrite(join(directory, 'documents', 'resources.md'), documentFor(artifact, 'resource', 'Resources'));
  atomicWrite(join(directory, 'documents', 'risks.md'), documentFor(artifact, 'risk', 'Risks'));
  atomicWrite(join(directory, 'documents', 'open-questions.md'), documentFor(artifact, 'open_question', 'Open questions'));
  atomicWrite(join(directory, 'documents', 'follow-ups.md'), documentFor(artifact, 'follow_up', 'Follow-ups'));
  writeInsightProjections(directory, artifact);
  if (artifact.ownerNotes?.length) {
    atomicWrite(join(directory, 'documents', 'your-notes.md'), ownerNotesMarkdown(artifact.title, artifact.ownerNotes));
  } else {
    rmSync(join(directory, 'documents', 'your-notes.md'), { force: true });
  }
  if (analysis?.notes) {
    atomicWrite(join(directory, 'documents', 'meeting-notes.md'), templatedNotesMarkdown(artifact.title, analysis));
  } else {
    rmSync(join(directory, 'documents', 'meeting-notes.md'), { force: true });
  }

  const readable = renderText(record, { timestamps: true, speakers: true });
  const transcriptMarkdown = `# ${artifact.title}\n\n${readable}\n`;
  atomicWrite(join(directory, 'transcript.md'), transcriptMarkdown);
  atomicWrite(join(directory, 'transcript.srt'), renderSrt(record, { speakers: true }));
  atomicWrite(join(directory, 'transcript.vtt'), renderVtt(record, { speakers: true }));
  atomicWrite(join(directory, 'enriched', 'transcript.md'), transcriptMarkdown);
  atomicWrite(
    join(directory, 'enriched', 'transcript.json'),
    `${JSON.stringify({ transcript: record, meeting: artifact }, null, 2)}\n`,
  );
  atomicWrite(join(directory, 'enriched', 'transcript.srt'), renderSrt(record, { speakers: true }));
  atomicWrite(join(directory, 'enriched', 'transcript.vtt'), renderVtt(record, { speakers: true }));
}

export function saveMeetingArtifact(
  libraryDir: string,
  artifact: MeetingArtifact,
): string {
  const { path, record } = findTranscriptRecord(libraryDir, artifact.transcriptId);
  const directory = dirname(path);
  const evidence = meetingEvidence(record);
  const change = compareMeetingEvidence(artifact.transcriptEvidence, evidence);
  if (change === 'revised' && (artifact.transcriptEvidence || artifact.provisionalClaims.length || artifact.analysis || artifact.chat.length || artifact.session.cursor)) {
    throw new Error('Transcript changed while meeting analysis was running. Retry with the current transcript.');
  }
  if (change === 'append' && (artifact.analysis?.final || artifact.chat.length)) {
    throw new Error('Transcript grew while meeting analysis was running. Retry with the current transcript.');
  }
  Object.assign(artifact, withCurrentCitations(artifact, record));
  artifact.transcriptEvidence = evidence;
  artifact.updatedAt = new Date().toISOString();
  atomicWrite(join(directory, 'meeting.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  writeMeetingProjections(directory, artifact, record);
  // A private meeting keeps no voices, from the moment it is saved as private.
  if (artifact.ai?.off) forgetMeetingVoices(artifact.transcriptId);
  return directory;
}

/** Save evidence before replacement. Called before the authoritative transcript write. */
export function archiveMeetingTranscript(directory: string, previous: TranscriptRecord, next: TranscriptRecord): void {
  const path = join(directory, 'meeting.json');
  if (!existsSync(path) || meetingEvidence(previous).revision === meetingEvidence(next).revision) return;
  const artifact = parseMeetingArtifact(JSON.parse(readFileSync(path, 'utf8')), path);
  const change = compareMeetingEvidence(meetingEvidence(previous), meetingEvidence(next));
  if (change === 'revised' || artifact.analysis?.final || artifact.chat.length) {
    retainMeetingRevision(directory, artifact, previous);
  }
}

function retainMeetingRevision(directory: string, artifact: MeetingArtifact, transcript?: TranscriptRecord): void {
  const content = JSON.stringify({ schemaVersion: 1, meeting: artifact, transcript: transcript ?? null }, null, 2) + '\n';
  const id = createHash('sha256').update(content).digest('hex');
  const path = join(directory, 'history', 'meeting-revisions', `${id}.json`);
  if (!existsSync(path)) atomicWrite(path, content);
}

/**
 * Notes, chat and every insight marked as possibly out of date, when the
 * meeting has any. Each insight keeps its mark until it runs again.
 */
function markedOutdated(artifact: MeetingArtifact, reason: string): MeetingArtifact {
  if (!artifact.analysis && !artifact.provisionalClaims.length && !artifact.chat.length && !artifact.insights?.length) return artifact;
  const outdated = { at: new Date().toISOString(), reason };
  return { ...artifact, notesOutdated: outdated,
    ...(artifact.insights ? { insights: artifact.insights.map((insight) => insight.outdated ? insight : { ...insight, outdated }) } : {}) };
}

/** The same name, or one a fuller form of the other: "Dana" and "Dana Lee". */
function sameName(left: string, right: string): boolean {
  const words = (name: string): string[] => name.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [];
  const [a, b] = [words(left), words(right)];
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length > 0 && shorter.every((word, index) => word === longer[index]);
}

/** `name` as a whole word, exactly as written: "Dana", not "Danae" or "dana". */
function wholeName(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}_])`, 'gu');
}

/**
 * Notes written before a speaker had a name say "Remote speaker 1": every such
 * placeholder takes the name, and the notes stand. A real name that changes,
 * a suggested "Dana" undone or a misheard name corrected, may have put the
 * wrong person in them. An action Dana owned moves to the new name, and so
 * does "Dana" written as a whole word, unless another speaker here is also
 * called that. Either way the notes are marked out of date, since "Dana"
 * might also be someone the meeting only talked about.
 */
function renamedInNotes(
  artifact: MeetingArtifact, rename: { from: string; to: string }, speakers: TranscriptRecord['speakers'],
): { artifact: MeetingArtifact; outdated?: string } {
  if (/^(?:Remote speaker \d+|SPEAKER_\d+)$/u.test(rename.from)) {
    const pattern = new RegExp(`\\b${rename.from}\\b`, 'gu');
    const renamed = <T>(value: T): T => JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
      (typeof item === 'string' ? item.replace(pattern, rename.to) : item)) as T;
    return { artifact: {
      ...artifact,
      provisionalClaims: renamed(artifact.provisionalClaims),
      chat: renamed(artifact.chat),
      ...(artifact.analysis ? { analysis: renamed(artifact.analysis) } : {}),
      ...(artifact.insights ? { insights: renamed(artifact.insights) } : {}),
    } };
  }
  // "Microphone" and "System audio" name a source, not a person; a fuller or shorter form names the same one.
  if (/^(?:Microphone|System audio)$/u.test(rename.from) || sameName(rename.from, rename.to)) return { artifact };
  const pattern = wholeName(rename.from);
  const shared = speakers.some((speaker) => speaker.label !== rename.to && wholeName(rename.from).test(speaker.label));
  const say = (text: string) => shared || wholeName(rename.from).test(rename.to) ? text : text.replace(pattern, rename.to);
  const claim = (item: MeetingClaim): MeetingClaim => ({ ...item, text: say(item.text),
    ...(item.person === undefined ? {} : { person: !shared && item.person === rename.from ? rename.to : item.person }) });
  const point = <T extends { text: string }>(item: T): T => ({ ...item, text: say(item.text) });
  return {
    artifact: {
      ...artifact,
      provisionalClaims: artifact.provisionalClaims.map(claim),
      chat: artifact.chat.map(point),
      ...(artifact.analysis ? { analysis: { ...artifact.analysis, summary: say(artifact.analysis.summary), claims: artifact.analysis.claims.map(claim),
        ...(artifact.analysis.notes ? { notes: artifact.analysis.notes.map((section) => ({ ...section, items: section.items.map(point) })) } : {}) } } : {}),
      ...(artifact.insights ? { insights: artifact.insights.map((insight) => ({ ...insight,
        ...(insight.summary === undefined ? {} : { summary: say(insight.summary) }),
        fields: insight.fields.map((field) => ({ ...field, items: field.items.map(point) })) })) } : {}),
    },
    outdated: `${rename.from} was renamed to ${rename.to}`,
  };
}

/** Also repairs interruption between transcript replacement and projection refresh. */
export function synchronizeMeetingTranscript(
  directory: string,
  record: TranscriptRecord,
  options: { namesOnly?: { from: string; to: string }; keepNotes?: string } = {},
): MeetingArtifact | undefined {
  const path = join(directory, 'meeting.json');
  if (!existsSync(path)) return undefined;
  const artifact = parseMeetingArtifact(JSON.parse(readFileSync(path, 'utf8')), path);
  const evidence = meetingEvidence(record);
  const change = compareMeetingEvidence(artifact.transcriptEvidence, evidence);
  if (change === 'same') return artifact;
  // Naming a speaker changes no word or time, so the notes and chat still stand.
  // The evidence hash includes labels, and stored hashes depend on that, so the
  // caller says so rather than the hash changing.
  if (options.namesOnly) {
    const renamed = renamedInNotes(artifact, options.namesOnly, record.speakers);
    const named: MeetingArtifact = { ...renamed.artifact, transcriptEvidence: evidence, updatedAt: new Date().toISOString() };
    const updated = renamed.outdated ? markedOutdated(named, renamed.outdated) : named;
    atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`);
    writeMeetingProjections(directory, updated, record);
    return updated;
  }
  // A corrected word or a removed phantom line leaves the meeting's notes
  // mostly right, so they are kept and marked rather than thrown away. Segment
  // IDs do not move, so every citation still points at the same moment, and
  // a citation of a removed line moves aside, marked (withCurrentCitations).
  if (options.keepNotes) {
    const updated = withCurrentCitations(markedOutdated({ ...artifact, transcriptEvidence: evidence,
      updatedAt: new Date().toISOString() }, options.keepNotes), record);
    atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`);
    writeMeetingProjections(directory, updated, record);
    return updated;
  }
  if (change === 'revised' || artifact.analysis?.final || artifact.chat.length) retainMeetingRevision(directory, artifact);
  const updated = resetForTranscript(artifact, evidence, change);
  atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`);
  writeMeetingProjections(directory, updated, record);
  return updated;
}

/** What a meeting keeps when its transcript grew or changed in a way its notes cannot follow. */
function resetForTranscript(artifact: MeetingArtifact, evidence: MeetingEvidence, change: 'append' | 'revised'): MeetingArtifact {
  return {
    ...artifact,
    transcriptEvidence: evidence,
    status: 'base-only',
    updatedAt: new Date().toISOString(),
    session: {
      ...artifact.session,
      ...(change === 'revised' ? { cursor: 0 } : {}),
      // Keep cumulative observer runs so revisions cannot reset the cost budget.
      reconciliationRunId: undefined,
      stoppedReason: undefined,
    },
    provisionalClaims: change === 'revised' ? [] : artifact.provisionalClaims,
    analysis: undefined,
    insights: undefined,
    notesOutdated: undefined,
    chat: [],
    failure: undefined,
  };
}

/**
 * A meeting as loadMeetingArtifact would leave it, from a folder already in
 * hand, without writing anything: for readers such as agents, which must
 * never change what they read, and which list the library once rather than
 * search it for every meeting.
 */
export function readMeetingArtifact(directory: string, record: TranscriptRecord): MeetingArtifact | undefined {
  const path = join(directory, 'meeting.json');
  if (!existsSync(path)) return undefined;
  let artifact: MeetingArtifact;
  try {
    artifact = parseMeetingArtifact(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${path} contains malformed JSON`);
    throw error;
  }
  const evidence = meetingEvidence(record);
  const change = compareMeetingEvidence(artifact.transcriptEvidence, evidence);
  return withCurrentCitations(change === 'same' ? artifact : resetForTranscript(artifact, evidence, change), record);
}

export function appendProvisionalOverlay(
  libraryDir: string,
  transcriptId: string,
  overlay: MeetingProvisionalOverlay,
): string {
  const directory = dirname(findTranscriptRecord(libraryDir, transcriptId).path);
  const path = join(directory, 'overlays', 'provisional.jsonl');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, 'a', 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(overlay)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return path;
}

export function createChatMessage(
  role: MeetingChatMessage['role'],
  text: string,
  options: Pick<MeetingChatMessage, 'evidenceSegmentIds' | 'runId'> = {},
): MeetingChatMessage {
  return {
    id: randomUUID(),
    role,
    text: text.trim(),
    createdAt: new Date().toISOString(),
    ...(options.evidenceSegmentIds === undefined
      ? {}
      : { evidenceSegmentIds: [...options.evidenceSegmentIds] }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  };
}
