import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  humainRouteRequest,
  NEWER_ENGINE,
  olderHumainEngine,
  olderThanRevision4,
  runHumainMeeting,
  type HumainMeetingRoute,
  type MeetingEngineCheck,
} from './humain-client.ts';
import { loadMeetingArtifact, type MeetingArtifact, type MeetingAttendee, type MeetingCalendarEvent } from './meeting-artifact.ts';
import { claimsForHumain, engineCheck, meetingSegments, retryableRun, runSafeId, stableKey } from './meeting-enrichment.ts';
import { isPrivate } from './meeting-memory.ts';
import { loadProfile } from './meeting-templates.ts';
import { findTranscriptRecord, listTranscriptRecords } from './transcript-library.ts';
import type { TranscriptRecord } from './transcript-types.ts';
import { formatTuiClock } from './tui-state.ts';
import { loadVocabulary } from './vocabulary.ts';

/**
 * A brief before a meeting: what was said the last times you met these people
 * or this series, what is still open, and what to bring up. Seashell picks the
 * past meetings itself (the same recurring title, or people in common, newest
 * first, at most 20, never a private one), Humain writes the brief, and it is
 * saved as Markdown in ~/Documents/Sea Shell/Briefs, every point cited.
 */

export const MAX_BRIEF_MEETINGS = 20;
const BRIEF_TIMEOUT_MS = 8 * 60_000;
/** Titles that say nothing about which meeting it is, so they never make a series. */
const GENERIC_TITLES = new Set(['meeting', 'recording', 'call', 'google meet', 'zoom meeting', 'teams meeting', 'facetime', 'busy', 'hold']);

export function briefsDirectory(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.SEASHELL_BRIEFS_DIR || join(dirname(libraryDir), 'Briefs');
}

/** The meeting coming up, as the calendar has it. */
export interface UpcomingMeeting {
  title: string;
  startsAt: string;
  eventId?: string;
  calendar?: string;
  attendees: MeetingAttendee[];
  description?: string;
}

export function upcomingFromEvent(event: MeetingCalendarEvent): UpcomingMeeting {
  return {
    title: event.title, startsAt: event.startAt, eventId: event.eventId, attendees: event.attendees,
    ...(event.calendar ? { calendar: event.calendar } : {}),
    ...(event.location ? { description: event.location } : {}),
  };
}

/** One brief per meeting: a recurring event's occurrences share an event id, so the start time tells them apart. */
export function briefKey(upcoming: Pick<UpcomingMeeting, 'title' | 'startsAt' | 'eventId'>): string {
  return createHash('sha256').update(JSON.stringify([upcoming.eventId ?? upcoming.title, upcoming.startsAt])).digest('hex').slice(0, 20);
}

function normalizedTitle(title: string | undefined): string {
  return (title ?? '').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const personKey = (person: Pick<MeetingAttendee, 'name' | 'email'>) =>
  (person.email?.trim() || person.name.trim()).toLocaleLowerCase('en-US');

/**
 * Who "you" are on calendar invites, so a meeting is not "with" everyone just
 * because you were in both. You are the attendee whose address names the
 * calendar the event is on, and anyone on nine in ten of your past invites.
 */
export function ownerKeys(libraryDir: string, upcoming?: Pick<UpcomingMeeting, 'calendar'>): Set<string> {
  const keys = new Set<string>();
  if (upcoming?.calendar && /@/u.test(upcoming.calendar)) keys.add(upcoming.calendar.trim().toLocaleLowerCase('en-US'));
  const counts = new Map<string, number>();
  let meetings = 0;
  for (const entry of listTranscriptRecords(libraryDir).slice(0, 200)) {
    let attendees: MeetingAttendee[] = [];
    try { attendees = JSON.parse(readFileSync(join(entry.directory, 'meeting.json'), 'utf8')).calendar?.attendees ?? []; } catch { continue; }
    if (attendees.length < 2) continue;
    meetings += 1;
    for (const key of new Set(attendees.map(personKey))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // You are on nearly every invite; a close colleague on most of them is still someone in common.
  if (meetings >= 5) for (const [key, count] of counts) if (count >= meetings * 0.9) keys.add(key);
  return keys;
}

export interface RelevantMeeting {
  id: string;
  title: string;
  startedAt: string;
  /** Why it was chosen: the same series, or people in common. */
  why: 'series' | 'people';
  /** The people in common, by name. */
  shared: string[];
  artifact: MeetingArtifact;
  record: TranscriptRecord;
}

/**
 * The past meetings a brief reads: the same recurring title, or anyone in
 * common other than you, newest first. Only finished meetings with notes; a
 * private one is never read.
 */
export function relevantMeetings(libraryDir: string, upcoming: UpcomingMeeting, limit = MAX_BRIEF_MEETINGS): RelevantMeeting[] {
  const you = ownerKeys(libraryDir, upcoming);
  const title = normalizedTitle(upcoming.title);
  const people = new Map(upcoming.attendees.map((person) => [personKey(person), person.name]));
  for (const key of you) people.delete(key);
  const starts = Date.parse(upcoming.startsAt);
  const found: RelevantMeeting[] = [];
  for (const entry of listTranscriptRecords(libraryDir)) {
    if (found.length >= limit) break;
    if (entry.captureState === 'recording' || entry.captureState === 'processing') continue;
    if (Number.isFinite(starts) && Date.parse(entry.createdAt) >= starts) continue;
    if (isPrivate(entry.directory)) continue;
    let artifact: MeetingArtifact | undefined;
    let record: TranscriptRecord;
    try {
      artifact = loadMeetingArtifact(libraryDir, entry.id);
      record = findTranscriptRecord(libraryDir, entry.id).record;
    } catch { continue; }
    if (!artifact || (!artifact.analysis?.summary && !(artifact.analysis?.claims ?? artifact.provisionalClaims).length)) continue;
    const pastTitle = normalizedTitle(artifact.calendar?.title ?? artifact.title);
    const series = (upcoming.eventId !== undefined && artifact.calendar?.eventId === upcoming.eventId) ||
      (title !== '' && !GENERIC_TITLES.has(title) && pastTitle === title);
    const shared = [...new Set([...(artifact.calendar?.attendees ?? []), ...artifact.attendees]
      .flatMap((person) => people.has(personKey(person)) ? [people.get(personKey(person))!] : []))];
    if (!series && !shared.length) continue;
    found.push({ id: entry.id, title: artifact.calendar?.title ?? artifact.title, startedAt: entry.createdAt,
      why: series ? 'series' : 'people', shared, artifact, record });
  }
  return found;
}

// MARK: - The brief

export interface BriefSource { meetingId: string; evidenceSegmentIds: string[] }
export interface BriefItem { text: string; sources: BriefSource[] }
export interface BriefSection { heading: string; items: BriefItem[] }

export interface Brief {
  schemaVersion: 1;
  key: string;
  upcoming: UpcomingMeeting;
  createdAt: string;
  summary: string;
  sections: BriefSection[];
  /** The past meetings it read, newest first, and where each cited moment is. */
  meetings: Array<{ id: string; title: string; startedAt: string; moments: Record<string, number> }>;
  /** The Markdown file. */
  path: string;
}

/** There is nothing to brief from: said plainly, never as a failure. */
export class NoBriefHistoryError extends Error {
  constructor(title: string) {
    super(`Nothing to brief from yet: no past meeting has the title "${title}" or anyone on its invite.`);
    this.name = 'NoBriefHistoryError';
  }
}

function parseBriefOutput(value: unknown, sent: ReadonlyMap<string, ReadonlySet<string>>): Pick<Brief, 'summary' | 'sections'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Humain brief output must be an object');
  const output = value as Record<string, unknown>;
  if (typeof output.summary !== 'string' || !output.summary.trim() || !Array.isArray(output.sections)) {
    throw new Error('Humain brief output is missing its summary or sections');
  }
  const sections = output.sections.map((raw, index): BriefSection => {
    const section = raw as Record<string, unknown> | undefined;
    if (!section || typeof section.heading !== 'string' || !section.heading.trim() || !Array.isArray(section.items)) {
      throw new Error(`Humain brief section ${index} is invalid`);
    }
    return {
      heading: section.heading.trim(),
      items: section.items.map((rawItem, itemIndex) => {
        const item = rawItem as Record<string, unknown> | undefined;
        if (!item || typeof item.text !== 'string' || !item.text.trim() || !Array.isArray(item.sources)) {
          throw new Error(`Humain brief section ${index} item ${itemIndex} is invalid`);
        }
        const sources = item.sources.map((rawSource) => {
          const source = rawSource as Record<string, unknown> | undefined;
          const segments = typeof source?.meetingId === 'string' ? sent.get(source.meetingId) : undefined;
          if (!segments || !Array.isArray(source!.evidenceSegmentIds) ||
              source!.evidenceSegmentIds.some((id) => typeof id !== 'string' || !segments.has(id))) {
            throw new Error(`Humain brief section ${index} item ${itemIndex} cites a meeting or moment it was not given`);
          }
          return { meetingId: source!.meetingId as string, evidenceSegmentIds: [...source!.evidenceSegmentIds] as string[] };
        });
        return { text: item.text.trim(), sources };
      }),
    };
  });
  return { summary: output.summary.trim(), sections };
}

const dayAndTime = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** "Weekly sync, Nov 4, 12:04": a citation a person can find. */
export function briefCitation(brief: Pick<Brief, 'meetings'>, source: BriefSource): string {
  const meeting = brief.meetings.find((candidate) => candidate.id === source.meetingId);
  if (!meeting) return '';
  const times = source.evidenceSegmentIds.flatMap((id) => meeting.moments[id] === undefined ? [] : [meeting.moments[id]!])
    .sort((a, b) => a - b);
  return `${meeting.title}, ${day(meeting.startedAt)}${times.length ? `, ${formatTuiClock(times[0]!)}` : ''}`;
}

export function briefMarkdown(brief: Omit<Brief, 'path'>): string {
  const cite = (item: BriefItem) => item.sources.length ? ` _(${item.sources.map((source) => briefCitation(brief, source)).filter(Boolean).join('; ')})_` : '';
  return [
    '---',
    `title: ${JSON.stringify(brief.upcoming.title)}`,
    `starts: ${brief.upcoming.startsAt}`,
    `made: ${brief.createdAt}`,
    `meetings: [${brief.meetings.map((meeting) => meeting.id).join(', ')}]`,
    '---',
    `# Brief: ${brief.upcoming.title}`,
    '',
    `_${dayAndTime(brief.upcoming.startsAt)} · from ${brief.meetings.length} past ${brief.meetings.length === 1 ? 'meeting' : 'meetings'}_`,
    '',
    brief.summary,
    ...brief.sections.flatMap((section) => ['', `## ${section.heading}`, '',
      ...(section.items.length ? section.items.map((item) => `- ${item.text}${cite(item)}`) : ['- Nothing came up.'])]),
    '',
    '## Read from',
    '',
    ...brief.meetings.map((meeting) => `- ${meeting.title}, ${dayAndTime(meeting.startedAt)} (${meeting.id})`),
    '',
  ].join('\n');
}

function dataPath(libraryDir: string, key: string, env: NodeJS.ProcessEnv): string {
  return join(briefsDirectory(libraryDir, env), '.data', `${key}.json`);
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'w', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The brief already made for this meeting, if any. */
export function findBrief(libraryDir: string, upcoming: Pick<UpcomingMeeting, 'title' | 'startsAt' | 'eventId'>, env: NodeJS.ProcessEnv = process.env): Brief | undefined {
  try {
    const brief = JSON.parse(readFileSync(dataPath(libraryDir, briefKey(upcoming), env), 'utf8')) as Brief;
    return brief.schemaVersion === 1 && existsSync(brief.path) ? brief : undefined;
  } catch { return undefined; }
}

/** Every brief made, newest meeting first. */
export function listBriefs(libraryDir: string, env: NodeJS.ProcessEnv = process.env): Brief[] {
  const directory = join(briefsDirectory(libraryDir, env), '.data');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith('.json') && file !== 'attempts.json').flatMap((file) => {
    try {
      const brief = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Brief;
      return brief.schemaVersion === 1 && existsSync(brief.path) ? [brief] : [];
    } catch { return []; }
  }).toSorted((left, right) => right.upcoming.startsAt.localeCompare(left.upcoming.startsAt));
}

/** "2026-11-12 0930 Weekly sync.md": sorted by when, named by what. */
function briefFileName(upcoming: UpcomingMeeting): string {
  const at = new Date(upcoming.startsAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`;
  const title = upcoming.title.replace(/[/:\\\u0000-\u001f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80) || 'Meeting';
  return `${stamp} ${title}.md`;
}

export interface MakeBriefOptions {
  route: HumainMeetingRoute;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
  runner?: typeof runHumainMeeting;
  engine?: MeetingEngineCheck;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

/**
 * Write a brief for an upcoming meeting and save it. Throws NoBriefHistoryError
 * when there is nothing to read, and says plainly when the engine is too old.
 */
export async function makeBrief(libraryDir: string, upcoming: UpcomingMeeting, options: MakeBriefOptions): Promise<Brief> {
  const env = options.env ?? process.env;
  const chosen = relevantMeetings(libraryDir, upcoming);
  if (!chosen.length) throw new NoBriefHistoryError(upcoming.title);
  if (await olderThanRevision4(engineCheck(options))) throw new Error(`This AI engine cannot write briefs yet. ${NEWER_ENGINE}`);
  options.onStatus?.(`Reading ${chosen.length} past ${chosen.length === 1 ? 'meeting' : 'meetings'}…`);
  const sent = new Map<string, Set<string>>();
  const meetings = chosen.map((meeting) => {
    const all = meetingSegments(meeting.record);
    // Each claim cites only lines the meeting still has, as on every request to Humain.
    const claims = claimsForHumain(meeting.artifact.analysis?.claims ?? meeting.artifact.provisionalClaims, new Set(all.map((segment) => segment.id)));
    const cited = new Set(claims.flatMap((claim) => claim.evidenceSegmentIds));
    // Only the lines the notes cite: enough to quote, and 20 meetings stay small.
    const segments = all.filter((segment) => cited.has(segment.id));
    sent.set(meeting.id, new Set(segments.map((segment) => segment.id)));
    return {
      meetingId: meeting.id, title: meeting.title, startedAt: meeting.startedAt,
      ...(meeting.artifact.analysis?.summary ? { summary: meeting.artifact.analysis.summary } : {}),
      claims, ...(segments.length ? { segments } : {}),
    };
  });
  const vocabulary = loadVocabulary(libraryDir, env).terms;
  const profile = loadProfile(libraryDir, env);
  const instructions = profile || vocabulary.length ? { ...(profile ? { profile } : {}), ...(vocabulary.length ? { vocabulary } : {}) } : undefined;
  const key = briefKey(upcoming);
  const request = {
    upcoming: {
      title: upcoming.title, startsAt: upcoming.startsAt,
      ...(upcoming.attendees.length ? { attendees: upcoming.attendees.map((person) => ({ name: person.name, ...(person.email ? { email: person.email } : {}) })) } : {}),
      ...(upcoming.description ? { description: upcoming.description } : {}),
    },
    meetings,
    ...(instructions ? { instructions } : {}),
    ...humainRouteRequest(options.route),
  };
  const idempotencyKey = stableKey(['brief', key, request]);
  const storeDir = join(briefsDirectory(libraryDir, env), '.humain');
  const { runId, idempotencyKey: attemptKey } = retryableRun(storeDir, runSafeId(`brief-${key}`, idempotencyKey), idempotencyKey);
  options.onStatus?.('Writing the brief…');
  const result = await (options.runner ?? runHumainMeeting)('brief', { briefId: key, idempotencyKey: attemptKey, ...request },
    { storeDir, runId, ...(options.onStatus ? { onStatus: options.onStatus } : {}), ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: BRIEF_TIMEOUT_MS })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw olderHumainEngine(message) ? new Error(`This AI engine cannot write briefs yet. ${NEWER_ENGINE}`) : error;
    });
  const output = parseBriefOutput(result.output, sent);
  const brief: Omit<Brief, 'path'> = {
    schemaVersion: 1, key, upcoming, createdAt: (options.now ?? new Date()).toISOString(), ...output,
    meetings: chosen.map((meeting) => ({ id: meeting.id, title: meeting.title, startedAt: meeting.startedAt,
      moments: Object.fromEntries(meetingSegments(meeting.record).filter((segment) => sent.get(meeting.id)?.has(segment.id))
        .map((segment) => [segment.id, segment.start])) })),
  };
  const path = join(briefsDirectory(libraryDir, env), briefFileName(upcoming));
  // A brief made again for the same meeting replaces the earlier one.
  const earlier = findBrief(libraryDir, upcoming, env);
  atomicWrite(path, briefMarkdown(brief));
  if (earlier && earlier.path !== path) rmSync(earlier.path, { force: true });
  atomicWrite(dataPath(libraryDir, key, env), `${JSON.stringify({ ...brief, path }, null, 2)}\n`);
  return { ...brief, path };
}

// MARK: - Before meetings, by themselves

/** How long before a meeting the recorder makes its brief. */
export const BRIEF_LEAD_MINUTES = 15;

/** What the recorder already did for a meeting, so it tries once and tells you once. */
type Attempt = { at: string; outcome: 'made' | 'no-history' | 'failed'; detail?: string };

function attemptsPath(libraryDir: string, env: NodeJS.ProcessEnv): string {
  return join(briefsDirectory(libraryDir, env), '.data', 'attempts.json');
}

export function readBriefAttempts(libraryDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, Attempt> {
  try { return JSON.parse(readFileSync(attemptsPath(libraryDir, env), 'utf8')) as Record<string, Attempt>; } catch { return {}; }
}

export function recordBriefAttempt(libraryDir: string, key: string, attempt: Attempt, env: NodeJS.ProcessEnv = process.env, now = new Date()): void {
  // A month of attempts is plenty to never ask twice.
  const kept = Object.entries(readBriefAttempts(libraryDir, env)).filter(([, value]) => now.getTime() - Date.parse(value.at) < 31 * 86_400_000);
  atomicWrite(attemptsPath(libraryDir, env), `${JSON.stringify(Object.fromEntries([...kept, [key, attempt]]), null, 2)}\n`);
}

/** The calendar meeting a brief is due for now: starting within the lead time, with no brief and no attempt yet. */
export function briefDue(events: readonly MeetingCalendarEvent[], libraryDir: string, now = new Date(), env: NodeJS.ProcessEnv = process.env): UpcomingMeeting | undefined {
  const attempts = readBriefAttempts(libraryDir, env);
  return events.map(upcomingFromEvent)
    .filter((upcoming) => {
      const until = Date.parse(upcoming.startsAt) - now.getTime();
      return until > 0 && until <= BRIEF_LEAD_MINUTES * 60_000 && !attempts[briefKey(upcoming)] && !findBrief(libraryDir, upcoming, env);
    })
    .toSorted((left, right) => left.startsAt.localeCompare(right.startsAt))[0];
}

/** The next meeting on the calendar today, for the home screen and `seashell brief next`. */
export function nextCalendarMeeting(events: readonly MeetingCalendarEvent[], now = new Date()): MeetingCalendarEvent | undefined {
  return events.filter((event) => Date.parse(event.startAt) > now.getTime() - 5 * 60_000 && Date.parse(event.endAt) > now.getTime())
    .toSorted((left, right) => left.startAt.localeCompare(right.startAt))[0];
}

// MARK: - The next meeting, for the app

/**
 * The recorder reads the calendar; the app does not, so the app learns the
 * next meeting from this file beside the library, as it learns the recorder's
 * state. `history` is how many past meetings a brief would read.
 */
export interface NextMeeting {
  upcoming: UpcomingMeeting;
  history: number;
  /** The brief's Markdown file, once there is one. */
  brief?: string;
  updatedAtUnixMs: number;
}

const NEXT_FILE = '.next-meeting.json';

export function writeNextMeeting(libraryDir: string, next: Omit<NextMeeting, 'updatedAtUnixMs'> | undefined, nowUnixMs = Date.now()): void {
  const path = join(libraryDir, NEXT_FILE);
  if (!next) { rmSync(path, { force: true }); return; }
  atomicWrite(path, `${JSON.stringify({ ...next, updatedAtUnixMs: nowUnixMs })}\n`);
}

/** The next meeting while it is still to come and the recorder said so recently. */
export function readNextMeeting(libraryDir: string, now = new Date()): NextMeeting | undefined {
  try {
    const next = JSON.parse(readFileSync(join(libraryDir, NEXT_FILE), 'utf8')) as NextMeeting;
    if (!next?.upcoming?.title || typeof next.upcoming.startsAt !== 'string' || !Number.isSafeInteger(next.updatedAtUnixMs)) return undefined;
    if (now.getTime() - next.updatedAtUnixMs > 15 * 60_000 || Date.parse(next.upcoming.startsAt) < now.getTime() - 10 * 60_000) return undefined;
    return { ...next, ...(next.brief && !existsSync(next.brief) ? { brief: undefined } : {}) };
  } catch { return undefined; }
}
