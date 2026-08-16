import { randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
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
  confidence: number;
  speakerId?: string;
  person?: string;
}

export interface MeetingAnalysis {
  final: boolean;
  summary: string;
  claims: MeetingClaim[];
  runId: string;
  createdAt: string;
}

export interface MeetingProvisionalOverlay {
  schemaVersion: 1;
  runId: string;
  observedAt: string;
  fromCursor: number;
  toCursor: number;
  summary: string;
  claims: MeetingClaim[];
}

export interface MeetingChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  evidenceSegmentIds?: string[];
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
  chat: MeetingChatMessage[];
  failure?: string;
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
  };
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
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
    confidence: claim.confidence,
    ...(optionalString(claim.speakerId, `${label} speakerId`) === undefined
      ? {}
      : { speakerId: claim.speakerId as string }),
    ...(optionalString(claim.person, `${label} person`) === undefined
      ? {}
      : { person: claim.person as string }),
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
  };
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
  return {
    schemaVersion: 1,
    meetingId: string(artifact.meetingId, 'meetingId'),
    transcriptId: string(artifact.transcriptId, 'transcriptId'),
    title: string(artifact.title, 'meeting title'),
    createdAt: string(artifact.createdAt, 'meeting createdAt'),
    updatedAt: string(artifact.updatedAt, 'meeting updatedAt'),
    status: artifact.status as MeetingArtifactStatus,
    mode: artifact.mode as MeetingEnrichmentMode,
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
  const path = meetingArtifactPath(libraryDir, transcriptId);
  if (!existsSync(path)) return undefined;
  try {
    return parseMeetingArtifact(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${path} contains malformed JSON`);
    throw error;
  }
}

function markdownList(claims: MeetingClaim[]): string {
  return claims.length > 0
    ? claims.map((claim) => `- ${claim.text} _(${claim.evidenceSegmentIds.join(', ')})_`).join('\n')
    : '- None captured.';
}

function documentFor(artifact: MeetingArtifact, type: MeetingClaimType, title: string): string {
  const claims = (artifact.analysis?.claims ?? artifact.provisionalClaims)
    .filter((claim) => claim.type === type);
  return `# ${title}\n\n${markdownList(claims)}\n`;
}

function writeMeetingProjections(
  directory: string,
  artifact: MeetingArtifact,
  record: TranscriptRecord,
): void {
  const analysis = artifact.analysis;
  if (analysis) {
    atomicWrite(join(directory, 'overlays', 'final.json'), `${JSON.stringify(analysis, null, 2)}\n`);
  }
  atomicWrite(
    join(directory, 'documents', 'summary.md'),
    `# Summary\n\n${analysis?.summary || 'No final summary yet.'}\n`,
  );
  atomicWrite(join(directory, 'documents', 'decisions.md'), documentFor(artifact, 'decision', 'Decisions'));
  atomicWrite(join(directory, 'documents', 'actions.md'), documentFor(artifact, 'action_item', 'Actions'));
  atomicWrite(join(directory, 'documents', 'notes.md'), documentFor(artifact, 'note', 'Notes'));
  atomicWrite(join(directory, 'documents', 'resources.md'), documentFor(artifact, 'resource', 'Resources'));

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
  artifact.updatedAt = new Date().toISOString();
  atomicWrite(join(directory, 'meeting.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  writeMeetingProjections(directory, artifact, record);
  return directory;
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
