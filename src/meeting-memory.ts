import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import {
  citedSegmentIds,
  loadMeetingArtifact,
  readMeetingAiSettingsAt,
  type MeetingArtifact,
  type MeetingClaim,
  type MeetingClaimType,
} from './meeting-artifact.ts';
import { findTranscriptRecord, listTranscriptRecords, loadTranscriptPath } from './transcript-library.ts';
import { videoMapIn } from './video-meeting.ts';
import type { TranscriptRecord } from './transcript-types.ts';

/**
 * Seashell's memory: reads and queries over the meeting library, with no
 * transport. The MCP server is one way in; anything else that wants to ask the
 * library questions (an Atlas connector, the CLI) calls these directly. Every
 * function refuses or hides meetings the owner turned AI off for.
 */

export type Arguments = Record<string, unknown>;

export function text(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

export function count(value: unknown, name: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`);
  return Math.min(value as number, maximum);
}

function date(value: unknown, name: string): number | undefined {
  const raw = text(value, name);
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO date such as 2026-10-01`);
  return parsed;
}

export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const rest = `${String(Math.floor(whole % 3600 / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
}

/**
 * Each speaker's label. One Seashell matched from a known voice, which nobody
 * has confirmed, is marked suggested so an agent does not take it as fact.
 */
function labels(record: TranscriptRecord): Map<string, { label: string; suggested?: true }> {
  const names = new Map(record.speakers.map(speaker => [speaker.id, { label: speaker.label, ...(speaker.suggestion ? { suggested: true as const } : {}) }]));
  if (!names.has('LOCAL')) names.set('LOCAL', { label: 'Microphone' });
  if (!names.has('SYSTEM')) names.set('SYSTEM', { label: 'System audio' });
  return names;
}

/** Who said a line, for agents: the label, and whether it is only a suggestion. */
function saidBy(names: ReturnType<typeof labels>, speaker: string | undefined) {
  const name = names.get(speaker ?? 'SYSTEM');
  return { speaker: name?.label ?? speaker ?? 'Unknown', ...(name?.suggested ? { speakerSuggested: true } : {}) };
}

function segmentId(record: TranscriptRecord, index: number): string {
  return record.transcript[index]?.id?.trim() || `s${String(index + 1).padStart(6, '0')}`;
}

function minutes(record: TranscriptRecord): number | undefined {
  return record.source.duration === undefined ? undefined : Math.round(record.source.duration / 6) / 10;
}

/** Meetings the owner turned AI off for are not handed to agents. */
export const PRIVATE_MEETING = 'This meeting is private: its owner turned AI off for it in Seashell, so it is not shared with agents.';

export function isPrivate(directory: string): boolean {
  return readMeetingAiSettingsAt(directory)?.off === true;
}

/** One meeting by ID, refused when private. */
export function loadMeeting(libraryDir: string, id: unknown) {
  const found = findTranscriptRecord(libraryDir, text(id, 'id', true)!);
  if (isPrivate(dirname(found.path))) throw new Error(PRIVATE_MEETING);
  return { ...found, directory: dirname(found.path), artifact: loadMeetingArtifact(libraryDir, found.record.id) };
}

/**
 * "s000002 01:05": a citation an agent can quote and a person can find. A line
 * no longer in the transcript (a phantom line cleaned away) says so, rather
 * than pointing at the start of the meeting.
 */
function citer(record: TranscriptRecord) {
  const starts = new Map(record.transcript.map((segment, index) => [segmentId(record, index), segment.start]));
  return (item: { evidenceSegmentIds?: string[]; removedEvidenceSegmentIds?: string[] }) => citedSegmentIds(item)
    .map(id => { const start = starts.get(id); return start === undefined ? `${id} (no longer in the transcript)` : `${id} ${clock(start)}`; });
}

function claimsOf(artifact: MeetingArtifact | undefined): MeetingClaim[] {
  return artifact?.analysis?.claims ?? artifact?.provisionalClaims ?? [];
}

export function listMeetings(libraryDir: string, args: Arguments = {}) {
  const query = text(args.query, 'query')?.toLocaleLowerCase();
  const from = date(args.from, 'from');
  const to = date(args.to, 'to');
  const limit = count(args.limit, 'limit', 20, 200);
  const meetings = [];
  for (const entry of listTranscriptRecords(libraryDir)) {
    const started = Date.parse(entry.createdAt);
    if ((from !== undefined && started < from) || (to !== undefined && started > to + 86_400_000 - 1)) continue;
    if (isPrivate(entry.directory)) {
      // Listed so a question about it gets a straight answer, but nothing of its content.
      if (!query || entry.title.toLocaleLowerCase().includes(query)) {
        meetings.push({ id: entry.id, title: entry.title, startedAt: entry.createdAt, private: true });
        if (meetings.length >= limit) break;
      }
      continue;
    }
    const artifact = loadMeetingArtifact(libraryDir, entry.id);
    const summary = artifact?.analysis?.summary;
    if (query) {
      const record = loadTranscriptPath(`${entry.directory}/transcript.json`);
      const haystack = [entry.title, summary ?? '', ...record.transcript.map(segment => segment.text)].join('\n').toLocaleLowerCase();
      if (!query.split(/\s+/u).every(word => haystack.includes(word))) continue;
    }
    meetings.push({
      id: entry.id, title: entry.title, startedAt: entry.createdAt,
      ...(entry.duration === undefined ? {} : { durationMinutes: Math.round(entry.duration / 6) / 10 }),
      kind: entry.kind, segments: entry.segmentCount,
      notes: artifact?.analysis ? (artifact.analysis.final ? 'final' : 'draft') : artifact?.provisionalClaims.length ? 'live-draft' : 'none',
      ...(summary ? { summary: summary.length > 280 ? `${summary.slice(0, 277)}…` : summary } : {}),
    });
    if (meetings.length >= limit) break;
  }
  return { meetings };
}

export function getMeeting(libraryDir: string, args: Arguments) {
  const { record, artifact } = loadMeeting(libraryDir, args.id);
  const names = labels(record);
  const cite = citer(record);
  const claims = claimsOf(artifact);
  return {
    id: record.id, title: record.title, startedAt: record.createdAt,
    ...(minutes(record) === undefined ? {} : { durationMinutes: minutes(record) }),
    ...(artifact?.app ? { app: artifact.app } : {}),
    ...(artifact?.calendar ? { calendar: { title: artifact.calendar.title, startAt: artifact.calendar.startAt,
      attendees: artifact.calendar.attendees.map(person => ({ name: person.name, ...(person.email ? { email: person.email } : {}) })) } } : {}),
    speakers: [...new Set(record.transcript.map(segment => segment.speaker ?? 'SYSTEM'))]
      .map(id => ({ id, label: names.get(id)?.label ?? id, ...(names.get(id)?.suggested ? { suggested: true } : {}) })),
    notes: {
      status: artifact?.analysis?.final ? 'final' : artifact?.analysis ? 'draft' : claims.length ? 'live-draft' : 'none',
      ...(artifact?.notesOutdated ? { possiblyOutOfDate: artifact.notesOutdated.reason } : {}),
      ...(artifact?.analysis?.summary ? { summary: artifact.analysis.summary } : {}),
      items: claims.map(claim => ({
        type: claim.type, text: claim.text,
        ...(claim.person ? { person: claim.person } : {}),
        ...(claim.due ? { due: claim.due } : {}),
        evidence: cite(claim),
      })),
      // The notes in the owner's template, section by section, each point cited.
      ...(artifact?.analysis?.notes ? {
        template: artifact.analysis.template,
        sections: artifact.analysis.notes.map(section => ({
          heading: section.heading,
          items: section.items.map(item => ({ text: item.text, evidence: cite(item) })),
        })),
      } : {}),
    },
    ...(artifact?.insights?.length ? { insights: artifact.insights.map(insight => insight.extractor) } : {}),
    transcriptSegments: record.transcript.length,
  };
}

export function getTranscript(libraryDir: string, args: Arguments) {
  const { record } = loadMeeting(libraryDir, args.id);
  const offset = count(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const limit = count(args.limit, 'limit', 200, 500);
  const speaker = text(args.speaker, 'speaker')?.toLocaleLowerCase();
  const names = labels(record);
  const segments = record.transcript.map((segment, index) => ({
    id: segmentId(record, index), at: clock(segment.start), start: segment.start, end: segment.end,
    ...saidBy(names, segment.speaker), text: segment.text,
  })).filter(segment => !speaker || segment.speaker.toLocaleLowerCase().includes(speaker));
  const page = segments.slice(offset, offset + limit);
  return { id: record.id, title: record.title, total: segments.length, offset, segments: page,
    ...(offset + page.length < segments.length ? { nextOffset: offset + page.length } : {}) };
}

export function searchTranscripts(libraryDir: string, args: Arguments) {
  const words = text(args.query, 'query', true)!.toLocaleLowerCase().split(/\s+/u);
  const limit = count(args.limit, 'limit', 30, 200);
  const matches = [];
  for (const entry of listTranscriptRecords(libraryDir)) {
    if (isPrivate(entry.directory)) continue;
    let record: TranscriptRecord;
    try { record = loadTranscriptPath(`${entry.directory}/transcript.json`); } catch { continue; }
    const names = labels(record);
    for (const [index, segment] of record.transcript.entries()) {
      const lower = segment.text.toLocaleLowerCase();
      if (!words.every(word => lower.includes(word))) continue;
      matches.push({ meetingId: record.id, title: record.title, startedAt: record.createdAt,
        segmentId: segmentId(record, index), at: clock(segment.start),
        ...saidBy(names, segment.speaker), text: segment.text });
      if (matches.length >= limit) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

export function listActionItems(libraryDir: string, args: Arguments = {}) {
  const since = date(args.since, 'since');
  const limit = count(args.limit, 'limit', 50, 500);
  const items = [];
  for (const entry of listTranscriptRecords(libraryDir)) {
    if (since !== undefined && Date.parse(entry.createdAt) < since) continue;
    if (isPrivate(entry.directory)) continue;
    const artifact = loadMeetingArtifact(libraryDir, entry.id);
    for (const claim of claimsOf(artifact)) {
      if (claim.type !== 'action_item') continue;
      items.push({ meetingId: entry.id, title: entry.title, startedAt: entry.createdAt, text: claim.text,
        ...(claim.person ? { person: claim.person } : {}), ...(claim.due ? { due: claim.due } : {}),
        evidence: claim.evidenceSegmentIds, final: Boolean(artifact?.analysis?.final),
        ...(artifact?.notesOutdated ? { possiblyOutOfDate: artifact.notesOutdated.reason } : {}) });
      if (items.length >= limit) return { items };
    }
  }
  return { items };
}

/** The kinds of note a cross-meeting query can ask for, and the words people use for them. */
export const NOTE_KINDS: Record<string, MeetingClaimType> = {
  decision: 'decision', decisions: 'decision',
  action: 'action_item', actions: 'action_item', action_item: 'action_item', action_items: 'action_item',
  risk: 'risk', risks: 'risk',
  question: 'open_question', questions: 'open_question', open_question: 'open_question', open_questions: 'open_question',
  'follow-up': 'follow_up', 'follow-ups': 'follow_up', follow_up: 'follow_up', follow_ups: 'follow_up', followup: 'follow_up', followups: 'follow_up',
};

const QUERY_KINDS: MeetingClaimType[] = ['decision', 'action_item', 'risk', 'open_question', 'follow_up'];

function noteKinds(value: unknown): MeetingClaimType[] {
  if (value === undefined) return QUERY_KINDS;
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map(item => {
    const kind = typeof item === 'string' ? NOTE_KINDS[item.trim().toLocaleLowerCase()] : undefined;
    if (!kind) throw new Error(`kind must be one of: decisions, actions, risks, questions, follow-ups`);
    return kind;
  }))];
}

/**
 * Notes across meetings, from the claims each meeting's notes stored: "action
 * items for Dana", "decisions about pricing since October". A topic matches the
 * note's words or the transcript lines it cites; a person matches the owner
 * or the speaker. Seashell does not track whether an action was done.
 */
export function queryNotes(libraryDir: string, args: Arguments = {}) {
  const kinds = noteKinds(args.kind);
  const person = text(args.person, 'person')?.toLocaleLowerCase();
  const about = text(args.about, 'about')?.toLocaleLowerCase().split(/\s+/u);
  const meeting = text(args.meeting, 'meeting')?.toLocaleLowerCase().split(/\s+/u);
  const since = date(args.since, 'since');
  const until = date(args.until, 'until');
  const limit = count(args.limit, 'limit', 50, 500);
  const items = [];
  for (const entry of listTranscriptRecords(libraryDir)) {
    const started = Date.parse(entry.createdAt);
    if ((since !== undefined && started < since) || (until !== undefined && started > until + 86_400_000 - 1)) continue;
    if (meeting && !meeting.every(word => entry.title.toLocaleLowerCase().includes(word))) continue;
    if (isPrivate(entry.directory)) continue;
    const artifact = loadMeetingArtifact(libraryDir, entry.id);
    const claims = claimsOf(artifact).filter(claim => kinds.includes(claim.type));
    if (!claims.length) continue;
    let record: TranscriptRecord;
    try { record = loadTranscriptPath(`${entry.directory}/transcript.json`); } catch { continue; }
    const names = labels(record);
    const said = new Map(record.transcript.map((segment, index) => [segmentId(record, index), segment.text]));
    const cite = citer(record);
    for (const claim of claims) {
      const speaker = claim.speakerId ? names.get(claim.speakerId)?.label : undefined;
      if (person && ![claim.person, speaker].some(name => name?.toLocaleLowerCase().includes(person))) continue;
      const quotes = claim.evidenceSegmentIds.flatMap(id => said.get(id) ?? []);
      const haystack = [claim.text, ...quotes].join('\n').toLocaleLowerCase();
      if (about && !about.every(word => haystack.includes(word))) continue;
      const quote = quotes[0]?.replace(/\s+/gu, ' ').trim();
      items.push({ meetingId: entry.id, title: entry.title, startedAt: entry.createdAt, type: claim.type, text: claim.text,
        ...(claim.person ? { person: claim.person } : {}), ...(claim.due ? { due: claim.due } : {}),
        evidence: cite(claim),
        ...(quote ? { quote: quote.length > 200 ? `${quote.slice(0, 199)}…` : quote } : {}),
        final: Boolean(artifact?.analysis?.final),
        ...(artifact?.notesOutdated ? { possiblyOutOfDate: artifact.notesOutdated.reason } : {}) });
      if (items.length >= limit) return { items, truncated: true };
    }
  }
  return { items, truncated: false };
}

/** What a meeting's extractors found, each item cited. */
export function getInsights(libraryDir: string, args: Arguments) {
  const { record, artifact } = loadMeeting(libraryDir, args.id);
  const wanted = text(args.extractor, 'extractor')?.toLocaleLowerCase();
  const cite = citer(record);
  const insights = (artifact?.insights ?? [])
    .filter(insight => !wanted || insight.extractor.toLocaleLowerCase() === wanted)
    .map(insight => ({
      extractor: insight.extractor, createdAt: insight.createdAt,
      // Each insight is stale or not on its own: rewriting the notes does not run every extractor.
      ...(insight.outdated ? { possiblyOutOfDate: insight.outdated.reason } : {}),
      ...(insight.summary ? { summary: insight.summary } : {}),
      fields: insight.fields.map(field => ({
        name: field.name,
        items: field.items.map(item => ({ text: item.text, evidence: cite(item) })),
      })),
    }));
  if (wanted && !insights.length) throw new Error(`No insights from "${String(args.extractor)}" for this meeting yet. Run it with run_extractor.`);
  return { id: record.id, title: record.title, insights };
}

/**
 * Where a transcript moment is in the meeting's screen recording. The video
 * sits beside the transcript as video.json (see video-meeting.ts): each movie's
 * time is transcript time + its startOffsetSeconds. A resumed call can have
 * several movies; the moment is in the one that was recording when it began.
 * Undefined when there is no video or no movie covers the moment.
 */
export function videoMoment(libraryDir: string, args: Arguments): { file: string; offsetSeconds: number; at: string } | undefined {
  const { record, directory } = loadMeeting(libraryDir, args.id);
  const wanted = text(args.segmentId, 'segmentId', true)!;
  const index = record.transcript.findIndex((_segment, position) => segmentId(record, position) === wanted);
  if (index < 0) throw new Error(`Segment ${wanted} is not in this meeting`);
  const segment = record.transcript[index]!;
  const movies = videoMapIn(directory)?.segments ?? [];
  // The last movie that had started by the end of the moment.
  const movie = movies.filter((candidate) => existsSync(candidate.file) && segment.end + candidate.startOffsetSeconds >= 0).at(-1);
  if (!movie) return undefined;
  const offsetSeconds = Math.max(0, Math.round((segment.start + movie.startOffsetSeconds) * 1000) / 1000);
  if (movie.durationSeconds !== undefined && offsetSeconds > movie.durationSeconds) return undefined;
  return { file: movie.file, offsetSeconds, at: clock(offsetSeconds) };
}
