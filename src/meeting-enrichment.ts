import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import {
  appendProvisionalOverlay,
  citesNothing,
  createChatMessage,
  createMeetingArtifact,
  loadMeetingArtifact,
  MeetingAiOffError,
  meetingIsPrivateAt,
  MEETING_CLAIM_TYPES,
  parseMeetingClaim,
  readMeetingArtifact,
  saveMeetingArtifact,
  transcriptSegmentId,
  type MeetingAnalysis,
  type MeetingArtifact,
  parseMeetingNotes,
  type MeetingChatMessage,
  type MeetingClaim,
  type MeetingEnrichmentMode,
  type MeetingNoteSection,
} from './meeting-artifact.ts';
import { meetingInstructions, type MeetingInstructions } from './meeting-templates.ts';
import { rolePrompt, type PromptRole } from './prompts.ts';
import {
  humainRouteRequest,
  meetingEngineActions,
  NEWER_ENGINE,
  olderThanRevision4,
  runHumainMeeting,
  type HumainMeetingRoute,
  type MeetingEngineCheck,
} from './humain-client.ts';
import { carryCaptureNotes, meetingOwnerNotes, ownerNotesForAi } from './owner-notes.ts';
import { loadVocabulary } from './vocabulary.ts';
import { findTranscriptRecord } from './transcript-library.ts';
import { speakerLabel } from './transcript-renderer.ts';
import type { TranscriptRecord } from './transcript-types.ts';

/** A little longer than Humain's own per-role limits (3, 15 and 5 minutes), so
 * Humain reports its own timeout. Final notes read the whole meeting at once. */
const HUMAIN_ROLE_TIMEOUT_MS = { observe: 4 * 60_000, reconcile: 20 * 60_000, chat: 6 * 60_000 } as const;

interface HumainEnrichmentOutput {
  summary: string;
  claims: MeetingClaim[];
  notes?: MeetingNoteSection[];
}

export interface MeetingEnrichmentOptions {
  mode?: MeetingEnrichmentMode;
  /** Shared fallback retained for embedded clients built against meeting mode 0.1. */
  route?: HumainMeetingRoute;
  routes?: {
    observer?: HumainMeetingRoute;
    reconciliation?: HumainMeetingRoute;
  };
  context?: unknown;
  /** The owner's profile, template and note. Unset: read from the Templates folder and the meeting's choices. */
  instructions?: MeetingInstructions | null;
  minimumNewSegments?: number;
  maximumNewSegments?: number;
  overlapSegments?: number;
  maxObserverRuns?: number;
  onStatus?: (message: string) => void;
  /** Deterministic seam for tests and embedded hosts. */
  runner?: typeof runHumainMeeting;
  /** What the installed engine can do. With a runner and no check, the engine is taken to be current. */
  engine?: MeetingEngineCheck;
}

/** The installed engine's check, or none for a test's runner, which stands in for a current engine. */
export function engineCheck(options: { runner?: unknown; engine?: MeetingEngineCheck }): MeetingEngineCheck {
  return options.engine ?? (options.runner ? async () => undefined : meetingEngineActions);
}


function enrichmentRoute(
  options: MeetingEnrichmentOptions,
  role: 'observer' | 'reconciliation',
): HumainMeetingRoute {
  const route = options.routes?.[role] ?? options.route;
  if (!route) throw new Error(`Meeting enrichment requires an exact ${role} route`);
  return route;
}

export function stableKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function runSafeId(value: string, idempotencyKey: string): string {
  // Reserve the digest before truncating the readable prefix. Long transcript
  // IDs and changed requests must never share one durable run directory.
  return `${value.replace(/[^a-zA-Z0-9_-]+/gu, '-').slice(0, 63)}-${idempotencyKey.slice(0, 32)}`;
}

/**
 * A failed Humain run keeps its directory and idempotency claim, so asking
 * again with the same request can never start over: Humain refuses to reuse
 * that run. Move a retry after a terminal failure to a new attempt; reuse a
 * run that succeeded or is still resumable.
 */
export function retryableRun(storeDir: string, runId: string, idempotencyKey: string): { runId: string; idempotencyKey: string } {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? { runId, idempotencyKey }
      : { runId: `${runId}-r${attempt}`, idempotencyKey: `${idempotencyKey}:retry-${attempt}` };
    let status: unknown;
    try { status = JSON.parse(readFileSync(join(storeDir, 'runs', candidate.runId, 'receipt.json'), 'utf8')).status; }
    catch { return candidate; }
    if (!['failed', 'cancelled', 'timed-out', 'timedOut'].includes(String(status))) return candidate;
  }
  throw new Error('This meeting step failed too many times. Check the AI provider in Settings (,).');
}

export function meetingSegments(record: TranscriptRecord) {
  return record.transcript.map((segment, index) => ({
    id: transcriptSegmentId(record, index),
    start: segment.start,
    end: segment.end,
    text: segment.text,
    ...(segment.speaker === undefined ? {} : { speakerId: segment.speaker }),
    ...(speakerLabel(record, segment.speaker) === undefined
      ? {}
      : { speakerLabel: speakerLabel(record, segment.speaker) as string }),
  }));
}

/**
 * Claims as Humain takes them back, in the shape every engine accepts: each
 * citing only lines this transcript has, since Humain refuses a claim that
 * cites any other, and none naming the owner's notes. A claim with no line
 * left is not sent as a claim, for one of two reasons. One whose every line
 * was removed stays in the notes, marked, but a point nobody can check no
 * longer steers the AI. One that only the owner's notes support was never
 * "removed": it stays the owner's, and reaches Humain the way every owner note
 * does, as the note itself in `ownerNotes`. Unchanged claims are the same
 * objects, so a request that needed no filtering keeps its idempotency key.
 */
export function claimsForHumain(claims: readonly MeetingClaim[], validIds: ReadonlySet<string>): MeetingClaim[] {
  return claims.flatMap((claim) => {
    const { removedEvidenceSegmentIds: removed, ownerNoteIds: notes, ...sent } = claim;
    const evidence = sent.evidenceSegmentIds.filter((id) => validIds.has(id));
    if (!evidence.length) return [];
    if (!removed && !notes && evidence.length === sent.evidenceSegmentIds.length) return [claim];
    return [{ ...sent, evidenceSegmentIds: evidence }];
  });
}

/** Earlier chat as Humain takes it back: answers cite only lines this transcript has. */
export function conversationForHumain(messages: readonly MeetingChatMessage[], validIds: ReadonlySet<string>): MeetingChatMessage[] {
  return messages.map((message) => {
    const { removedEvidenceSegmentIds: removed, ...sent } = message;
    if (!removed && (sent.evidenceSegmentIds ?? []).every((id) => validIds.has(id))) return message;
    return { ...sent, ...(sent.evidenceSegmentIds ? { evidenceSegmentIds: sent.evidenceSegmentIds.filter((id) => validIds.has(id)) } : {}) };
  });
}

function parseEnrichmentOutput(
  value: unknown,
  validEvidenceIds: Set<string>,
  validNoteIds: ReadonlySet<string> = new Set(),
): HumainEnrichmentOutput {
  /** A point cites real segments and real notes, and at least one of the two. */
  const unsupported = (item: { evidenceSegmentIds: string[]; ownerNoteIds?: string[] }, label: string, cites = 'cites'): string | undefined => {
    const missing = item.evidenceSegmentIds.find((id) => !validEvidenceIds.has(id));
    if (missing) return `${label} ${cites} missing segment ${missing}`;
    const note = item.ownerNoteIds?.find((id) => !validNoteIds.has(id));
    if (note) return `${label} ${cites} missing owner note ${note}`;
    return citesNothing(item) ? `${label} ${cites} nothing` : undefined;
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Humain meeting output must be an object');
  }
  const output = value as Record<string, unknown>;
  if (typeof output.summary !== 'string' || !Array.isArray(output.claims)) {
    throw new Error('Humain meeting output is missing summary or claims');
  }
  const claims = output.claims.map((claim, index) => {
    const parsed = parseMeetingClaim(claim, `Humain claim ${index}`);
    if (!MEETING_CLAIM_TYPES.includes(parsed.type)) {
      throw new Error(`Humain claim ${index} has an unsupported type`);
    }
    const problem = unsupported(parsed, `Humain claim ${index}`);
    if (problem) throw new Error(problem);
    return parsed;
  });
  if (output.notes === undefined) return { summary: output.summary.trim(), claims };
  const notes = parseMeetingNotes(output.notes, 'Humain notes');
  for (const section of notes) {
    const problem = section.items.map((item) => unsupported(item, `Humain notes "${section.heading}"`, 'cite')).find(Boolean);
    if (problem) throw new Error(problem);
  }
  return { summary: output.summary.trim(), claims, notes };
}

/** Humain bounds each instruction so it can ride in every call's system prompt. */
const MAX_INSTRUCTION_CHARS = 16_000;

/**
 * The owner's instructions for this meeting. A template chosen for the
 * meeting wins over the calendar match; "none" leaves notes untemplated.
 * Given a role, that role's prompt from the Prompts folder follows "About me":
 * both are standing guidance, which Humain reads as the owner's profile.
 */
export function ownerInstructions(
  libraryDir: string,
  artifact: MeetingArtifact,
  options: Pick<MeetingEnrichmentOptions, 'instructions'>,
  role?: PromptRole,
  /** The owner's vocabulary goes to every run an engine can take it in. */
  include: { vocabulary?: boolean } = {},
): { instructions?: MeetingInstructions } {
  if (options.instructions !== undefined) {
    return options.instructions === null ? {} : { instructions: options.instructions };
  }
  const { instructions } = meetingInstructions(libraryDir, {
    title: artifact.title,
    ...(artifact.calendar?.title ? { calendarTitle: artifact.calendar.title } : {}),
    ...(artifact.ai?.template ? { template: artifact.ai.template } : {}),
    ...(artifact.ai?.note ? { note: artifact.ai.note } : {}),
  });
  const vocabulary = include.vocabulary === false ? [] : loadVocabulary(libraryDir).terms;
  const withVocabulary = (value: MeetingInstructions | undefined) => vocabulary.length ? { ...value, vocabulary } : value;
  const prompt = role ? rolePrompt(libraryDir, role) : undefined;
  if (!prompt) {
    const result = withVocabulary(instructions);
    return result ? { instructions: result } : {};
  }
  const profile = [instructions?.profile, prompt].filter(Boolean).join('\n\n');
  if (profile.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(`"About me" and the ${role === 'observer' ? 'live' : role === 'reconciliation' ? 'notes' : 'chat'} prompt are ${profile.length.toLocaleString('en-US')} characters together; the limit is 16,000. Shorten one of them.`);
  }
  return { instructions: withVocabulary({ ...instructions, profile })! };
}

function compactClaims(claims: MeetingClaim[]): MeetingClaim[] {
  const byId = new Map<string, MeetingClaim>();
  for (const claim of claims) byId.set(claim.id, claim);
  return [...byId.values()];
}

function windowFor(
  segments: ReturnType<typeof meetingSegments>,
  cursor: number,
  minimum: number,
  maximum: number,
  overlap: number,
) {
  const available = segments.length - cursor;
  if (available < minimum) return undefined;
  const toCursor = Math.min(segments.length, cursor + maximum);
  return {
    fromCursor: cursor,
    toCursor,
    segments: segments.slice(Math.max(0, cursor - overlap), toCursor),
  };
}

function baseArtifact(
  record: TranscriptRecord,
  existing: MeetingArtifact | undefined,
  options: MeetingEnrichmentOptions,
): MeetingArtifact {
  if (existing) {
    return {
      ...existing,
      mode: options.mode ?? existing.mode,
      session: {
        ...existing.session,
        overlapSegments: options.overlapSegments ?? existing.session.overlapSegments,
        maxObserverRuns: options.maxObserverRuns ?? existing.session.maxObserverRuns,
        stoppedReason: undefined,
      },
      failure: undefined,
    };
  }
  return createMeetingArtifact(record, {
    mode: options.mode,
    overlapSegments: options.overlapSegments,
    maxObserverRuns: options.maxObserverRuns,
  });
}

export async function enrichMeeting(
  libraryDir: string,
  transcriptId: string,
  options: MeetingEnrichmentOptions,
): Promise<MeetingArtifact> {
  const found = findTranscriptRecord(libraryDir, transcriptId);
  const record = found.record;
  const segments = meetingSegments(record);
  if (segments.length === 0) throw new Error('Meeting enrichment requires transcript text');
  const validIds = new Set(segments.map((segment) => segment.id));
  // Notes typed during the call wait in its capture bundle until they are carried into meeting.json.
  try { carryCaptureNotes(libraryDir, transcriptId); } catch { /* They are still read from the bundle below. */ }
  let artifact = baseArtifact(record, loadMeetingArtifact(libraryDir, transcriptId), options);
  if (artifact.ai?.off) throw new MeetingAiOffError();
  const older = await olderThanRevision4(engineCheck(options));
  const mode = options.mode ?? artifact.mode;
  const minimum = options.minimumNewSegments ?? 3;
  const maximum = options.maximumNewSegments ?? 12;
  const overlap = options.overlapSegments ?? artifact.session.overlapSegments;
  const storeDir = join(dirname(found.path), '.humain');
  const runner = options.runner ?? runHumainMeeting;

  try {
    if (mode === 'streaming' || mode === 'hybrid') {
      const observerRoute = enrichmentRoute(options, 'observer');
      const { instructions } = ownerInstructions(libraryDir, artifact, options, 'observer', { vocabulary: !older });
      artifact = { ...artifact, status: 'observing', mode };
      saveMeetingArtifact(libraryDir, artifact);
      let cursor = artifact.session.cursor;
      let runs = artifact.session.observerRunIds.length;
      while (cursor < segments.length && runs < artifact.session.maxObserverRuns) {
        const remaining = segments.length - cursor;
        const window = windowFor(
          segments,
          cursor,
          remaining < minimum ? 1 : minimum,
          maximum,
          overlap,
        );
        if (!window) break;
        options.onStatus?.(`Observing transcript ${window.fromCursor + 1}–${window.toCursor}…`);
        const approvedContext = options.context ?? {
          calendar: artifact.calendar ?? null,
          attendees: artifact.attendees,
        };
        const priorClaims = claimsForHumain(artifact.provisionalClaims, validIds);
        const idempotencyKey = stableKey([
          transcriptId,
          'observe',
          window.fromCursor,
          window.toCursor,
          window.segments,
          observerRoute,
          approvedContext,
          priorClaims,
          ...(instructions ? [instructions] : []),
        ]);
        const { runId, idempotencyKey: attemptKey } = retryableRun(storeDir,
          runSafeId(`meeting-${transcriptId}-observe-${window.fromCursor}-${window.toCursor}`, idempotencyKey), idempotencyKey);
        const result = await runner('observe', {
          meetingId: artifact.meetingId,
          ...humainRouteRequest(observerRoute),
          segments: window.segments,
          priorClaims,
          context: approvedContext,
          ...(instructions ? { instructions } : {}),
          idempotencyKey: attemptKey,
        }, { storeDir, runId, onStatus: options.onStatus, timeoutMs: HUMAIN_ROLE_TIMEOUT_MS.observe });
        const output = parseEnrichmentOutput(result.output, new Set(window.segments.map((segment) => segment.id)));
        appendProvisionalOverlay(libraryDir, transcriptId, {
          schemaVersion: 1,
          runId: result.runId,
          observedAt: new Date().toISOString(),
          fromCursor: window.fromCursor,
          toCursor: window.toCursor,
          summary: output.summary,
          claims: output.claims,
          transcriptRevision: artifact.transcriptEvidence?.revision,
        });
        cursor = window.toCursor;
        runs += 1;
        artifact = {
          ...artifact,
          provisionalClaims: compactClaims([...artifact.provisionalClaims, ...output.claims]),
          session: {
            ...artifact.session,
            cursor,
            observerRunIds: [...artifact.session.observerRunIds, result.runId],
          },
        };
        saveMeetingArtifact(libraryDir, artifact);
      }
      if (artifact.session.cursor < segments.length) {
        artifact = {
          ...artifact,
          session: { ...artifact.session, stoppedReason: 'budget-exhausted' },
        };
      }
    }

    if (mode === 'post-session' || mode === 'hybrid') {
      const reconciliationRoute = enrichmentRoute(options, 'reconciliation');
      const { instructions } = ownerInstructions(libraryDir, artifact, options, 'reconciliation', { vocabulary: !older });
      // The owner's own account of the meeting. An engine before revision 4 would ignore them, so it is not sent them.
      const written = meetingOwnerNotes(libraryDir, transcriptId, artifact);
      const ownerNotes = older ? [] : ownerNotesForAi(artifact, written);
      if (older && written.length) options.onStatus?.(`Your notes are kept, but this AI engine cannot read them. ${NEWER_ENGINE}`);
      artifact = { ...artifact, status: 'reconciling', mode };
      saveMeetingArtifact(libraryDir, artifact);
      options.onStatus?.('Writing the notes…');
      const approvedContext = options.context ?? {
        calendar: artifact.calendar ?? null,
        attendees: artifact.attendees,
      };
      const provisionalClaims = claimsForHumain(artifact.provisionalClaims, validIds);
      const idempotencyKey = stableKey([
        transcriptId,
        'reconcile',
        segments,
        provisionalClaims,
        reconciliationRoute,
        approvedContext,
        ...(instructions ? [instructions] : []),
        ...(ownerNotes.length ? [ownerNotes] : []),
      ]);
      const { runId, idempotencyKey: attemptKey } = retryableRun(storeDir,
        runSafeId(`meeting-${transcriptId}-reconcile`, idempotencyKey), idempotencyKey);
      const result = await runner('reconcile', {
        meetingId: artifact.meetingId,
        ...humainRouteRequest(reconciliationRoute),
        segments,
        provisionalClaims,
        context: approvedContext,
        ...(instructions ? { instructions } : {}),
        ...(ownerNotes.length ? { ownerNotes } : {}),
        idempotencyKey: attemptKey,
      }, { storeDir, runId, onStatus: options.onStatus, timeoutMs: HUMAIN_ROLE_TIMEOUT_MS.reconcile });
      const output = parseEnrichmentOutput(result.output, validIds, new Set(ownerNotes.map((note) => note.id)));
      if (instructions?.template && output.notes === undefined) {
        // An engine from before templates ignores them and returns plain claims.
        options.onStatus?.('This Humain version does not write templated notes yet; run `seashell ai install` with a newer engine.');
      }
      const analysis: MeetingAnalysis = {
        final: true,
        summary: output.summary,
        claims: output.claims,
        runId: result.runId,
        createdAt: new Date().toISOString(),
        ...(output.notes && instructions?.template ? { template: instructions.template.name, notes: output.notes } : {}),
        ...(older && written.length ? { ownerNotesUnread: true } : {}),
      };
      artifact = {
        ...artifact,
        analysis,
        // Fresh notes match the transcript again.
        notesOutdated: undefined,
        session: {
          ...artifact.session,
          reconciliationRunId: result.runId,
          stoppedReason: artifact.session.stoppedReason === 'budget-exhausted'
            ? 'budget-exhausted'
            : 'meeting-ended',
        },
      };
    } else {
      artifact = {
        ...artifact,
        analysis: {
          final: false,
          summary: artifact.provisionalClaims.length > 0
            ? 'Live observations are available; final reconciliation has not run.'
            : 'No live observations were produced.',
          claims: artifact.provisionalClaims,
          runId: artifact.session.observerRunIds.at(-1) ?? 'none',
          createdAt: new Date().toISOString(),
        },
      };
    }

    artifact = { ...artifact, status: 'ready', failure: undefined };
    saveMeetingArtifact(libraryDir, artifact);
    return artifact;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    artifact = {
      ...artifact,
      status: 'failed',
      failure: message,
      session: { ...artifact.session, stoppedReason: 'failed' },
    };
    // Preserve a concurrent transcript refresh rather than overwriting it with
    // this failed/stale operation's claims, cursor or error projection.
    const current = loadMeetingArtifact(libraryDir, transcriptId);
    if (current?.transcriptEvidence?.revision === artifact.transcriptEvidence?.revision) {
      saveMeetingArtifact(libraryDir, artifact);
    }
    throw error;
  }
}

/** A question about one meeting, as Humain's chat reads it, and its answer checked against the transcript. */
async function askHumain(
  libraryDir: string,
  transcriptId: string,
  question: string,
  route: HumainMeetingRoute,
  options: {
    onStatus?: ((message: string) => void) | undefined;
    runner: typeof runHumainMeeting;
    engine?: MeetingEngineCheck | undefined;
    /** Asked while the call is still being recorded: the transcript so far, nothing saved. */
    partial?: boolean;
    signal?: AbortSignal | undefined;
  },
): Promise<{ record: TranscriptRecord; artifact: MeetingArtifact | undefined; answer: string; evidenceSegmentIds: string[]; runId: string }> {
  const { record, path } = findTranscriptRecord(libraryDir, transcriptId);
  const directory = dirname(path);
  // A meeting.json that can't be read might have said AI is off, so it counts as private.
  if (meetingIsPrivateAt(directory)) throw new MeetingAiOffError();
  // A question during the call saves nothing, so it reads the meeting without writing.
  const artifact = options.partial ? readMeetingArtifact(directory, record) : loadMeetingArtifact(libraryDir, transcriptId);
  if (!artifact && !options.partial) throw new Error('Create the meeting artifact before using meeting chat');
  if (artifact?.ai?.off) throw new MeetingAiOffError();
  const trimmed = question.trim();
  if (!trimmed) throw new Error('Meeting question cannot be empty');
  const segments = meetingSegments(record);
  if (options.partial && !segments.length) throw new Error('Nothing has been said yet.');
  const validIds = new Set(segments.map((segment) => segment.id));
  const approvedContext = {
    calendar: artifact?.calendar ?? null,
    attendees: artifact?.attendees ?? [],
    priorConversation: options.partial || !artifact ? [] : conversationForHumain(artifact.chat.slice(-10), validIds),
  };
  const older = await olderThanRevision4(engineCheck(options));
  const { instructions } = artifact ? ownerInstructions(libraryDir, artifact, {}, 'chat', { vocabulary: !older }) : {};
  const finalClaims = claimsForHumain(artifact?.analysis?.claims ?? artifact?.provisionalClaims ?? [], validIds);
  const idempotencyKey = stableKey([
    transcriptId,
    'chat',
    trimmed,
    segments,
    finalClaims,
    route,
    approvedContext,
    ...(instructions ? [instructions] : []),
    ...(options.partial ? ['partial'] : []),
  ]);
  const storeDir = join(directory, '.humain');
  const { runId, idempotencyKey: attemptKey } = retryableRun(storeDir,
    runSafeId(`meeting-${transcriptId}-${options.partial ? 'live-question' : 'chat'}`, idempotencyKey), idempotencyKey);
  // Checking the engine can take 20 seconds: a meeting made private meanwhile is not sent.
  if (meetingIsPrivateAt(directory)) throw new MeetingAiOffError();
  const result = await options.runner('chat', {
    meetingId: artifact?.meetingId ?? record.id,
    ...humainRouteRequest(route),
    question: trimmed,
    segments,
    finalClaims,
    context: approvedContext,
    ...(instructions ? { instructions } : {}),
    // The call is still going: what has been said so far, not the whole meeting.
    ...(options.partial ? { partial: true } : {}),
    idempotencyKey: attemptKey,
  }, {
    storeDir,
    runId,
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: HUMAIN_ROLE_TIMEOUT_MS.chat,
  });
  if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) {
    throw new Error('Humain chat output must be an object');
  }
  const output = result.output as Record<string, unknown>;
  if (
    typeof output.answer !== 'string' ||
    !Array.isArray(output.evidenceSegmentIds) ||
    output.evidenceSegmentIds.some((id) => typeof id !== 'string' || !validIds.has(id))
  ) {
    throw new Error('Humain chat returned invalid answer evidence');
  }
  return { record, artifact, answer: output.answer.trim(), evidenceSegmentIds: output.evidenceSegmentIds as string[], runId: result.runId };
}

export async function chatWithMeeting(
  libraryDir: string,
  transcriptId: string,
  question: string,
  route: HumainMeetingRoute,
  onStatus?: (message: string) => void,
  /** Deterministic seam for tests and embedded hosts. */
  runner: typeof runHumainMeeting = runHumainMeeting,
  engine?: MeetingEngineCheck,
): Promise<MeetingArtifact> {
  const { artifact, answer, evidenceSegmentIds, runId } = await askHumain(libraryDir, transcriptId, question, route, { onStatus, runner, engine });
  const updated: MeetingArtifact = {
    ...artifact!,
    chat: [
      ...artifact!.chat,
      createChatMessage('user', question.trim()),
      createChatMessage('assistant', answer, { evidenceSegmentIds, runId }),
    ],
  };
  saveMeetingArtifact(libraryDir, updated);
  return updated;
}

/** A line of the call an answer rests on: when, who, and what they said. */
export interface CitedMoment {
  id: string;
  start: number;
  speakerId?: string;
  speaker?: string;
  text: string;
}

export interface LiveAnswer {
  question: string;
  answer: string;
  moments: CitedMoment[];
}

/** How far back "What did I miss?" looks when you were watching all along. */
export const CATCH_UP_SECONDS = 5 * 60;

/**
 * "What did I miss?", as a question about a stretch of the call: since you last
 * looked, or the last five minutes, whichever is longer.
 */
export function catchUpQuestion(nowSeconds: number, lastLookedSeconds?: number): { question: string; from: number } {
  const from = Math.max(0, Math.min(nowSeconds - CATCH_UP_SECONDS, lastLookedSeconds ?? Infinity));
  const clock = (seconds: number) => {
    const whole = Math.max(0, Math.floor(seconds));
    const minutes = `${Math.floor(whole % 3600 / 60)}`.padStart(whole >= 3600 ? 2 : 1, '0');
    return `${whole >= 3600 ? `${Math.floor(whole / 3600)}:` : ''}${minutes}:${String(whole % 60).padStart(2, '0')}`;
  };
  return {
    from,
    question: `What did I miss? Cover what was said from ${clock(from)} to ${clock(nowSeconds)} on the transcript clock: ` +
      'anything decided, anything asked of me or still waiting on me, and anything I should answer, most important first. Keep it short.',
  };
}

/**
 * A question during a call, over what has been said so far. Nothing is saved:
 * the transcript is still growing, and the final notes replace it all. A
 * private meeting is refused before anything is sent.
 */
export async function askDuringCall(
  libraryDir: string,
  transcriptId: string,
  question: string,
  route: HumainMeetingRoute,
  options: { onStatus?: (message: string) => void; runner?: typeof runHumainMeeting; engine?: MeetingEngineCheck; signal?: AbortSignal } = {},
): Promise<LiveAnswer> {
  const { record, answer, evidenceSegmentIds } = await askHumain(libraryDir, transcriptId, question, route,
    { onStatus: options.onStatus, runner: options.runner ?? runHumainMeeting, engine: options.engine, partial: true, signal: options.signal });
  const byId = new Map(meetingSegments(record).map((segment) => [segment.id, segment]));
  const moments = evidenceSegmentIds.flatMap((id) => {
    const segment = byId.get(id);
    return segment ? [{ id, start: segment.start, text: segment.text, ...(segment.speakerId ? { speakerId: segment.speakerId } : {}),
      ...(segment.speakerLabel ? { speaker: segment.speakerLabel } : {}) }] : [];
  }).toSorted((left, right) => left.start - right.start);
  return { question: question.trim(), answer, moments };
}
