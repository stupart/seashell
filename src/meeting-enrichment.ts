import { createHash } from 'crypto';
import { dirname, join } from 'path';
import {
  appendProvisionalOverlay,
  createChatMessage,
  createMeetingArtifact,
  loadMeetingArtifact,
  MEETING_CLAIM_TYPES,
  parseMeetingClaim,
  saveMeetingArtifact,
  transcriptSegmentId,
  type MeetingAnalysis,
  type MeetingArtifact,
  type MeetingClaim,
  type MeetingEnrichmentMode,
} from './meeting-artifact.ts';
import {
  humainRouteRequest,
  runHumainMeeting,
  type HumainMeetingRoute,
} from './humain-client.ts';
import { findTranscriptRecord } from './transcript-library.ts';
import { speakerLabel } from './transcript-renderer.ts';
import type { TranscriptRecord } from './transcript-types.ts';

interface HumainEnrichmentOutput {
  summary: string;
  claims: MeetingClaim[];
}

export interface MeetingEnrichmentOptions {
  mode?: MeetingEnrichmentMode;
  route: HumainMeetingRoute;
  context?: unknown;
  minimumNewSegments?: number;
  maximumNewSegments?: number;
  overlapSegments?: number;
  maxObserverRuns?: number;
  onStatus?: (message: string) => void;
  /** Deterministic seam for tests and embedded hosts. */
  runner?: typeof runHumainMeeting;
}

function stableKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function runSafeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 96);
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

function parseEnrichmentOutput(
  value: unknown,
  validEvidenceIds: Set<string>,
): HumainEnrichmentOutput {
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
    const missing = parsed.evidenceSegmentIds.find((id) => !validEvidenceIds.has(id));
    if (missing) throw new Error(`Humain claim ${index} cites missing segment ${missing}`);
    return parsed;
  });
  return { summary: output.summary.trim(), claims };
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
  let artifact = baseArtifact(record, loadMeetingArtifact(libraryDir, transcriptId), options);
  const mode = options.mode ?? artifact.mode;
  const minimum = options.minimumNewSegments ?? 3;
  const maximum = options.maximumNewSegments ?? 12;
  const overlap = options.overlapSegments ?? artifact.session.overlapSegments;
  const storeDir = join(dirname(found.path), '.humain');
  const runner = options.runner ?? runHumainMeeting;

  try {
    if (mode === 'streaming' || mode === 'hybrid') {
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
        const idempotencyKey = stableKey([
          transcriptId,
          'observe',
          window.fromCursor,
          window.toCursor,
          options.route,
          approvedContext,
          artifact.provisionalClaims,
        ]);
        const runId = runSafeId(`meeting-${transcriptId}-observe-${window.fromCursor}-${window.toCursor}`);
        const result = await runner('observe', {
          meetingId: artifact.meetingId,
          ...humainRouteRequest(options.route),
          segments: window.segments,
          priorClaims: artifact.provisionalClaims,
          context: approvedContext,
          idempotencyKey,
        }, { storeDir, runId, onStatus: options.onStatus });
        const output = parseEnrichmentOutput(result.output, validIds);
        appendProvisionalOverlay(libraryDir, transcriptId, {
          schemaVersion: 1,
          runId: result.runId,
          observedAt: new Date().toISOString(),
          fromCursor: window.fromCursor,
          toCursor: window.toCursor,
          summary: output.summary,
          claims: output.claims,
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
      artifact = { ...artifact, status: 'reconciling', mode };
      saveMeetingArtifact(libraryDir, artifact);
      options.onStatus?.('Reconciling complete meeting…');
      const approvedContext = options.context ?? {
        calendar: artifact.calendar ?? null,
        attendees: artifact.attendees,
      };
      const idempotencyKey = stableKey([
        transcriptId,
        'reconcile',
        segments,
        artifact.provisionalClaims,
        options.route,
        approvedContext,
      ]);
      const runId = runSafeId(`meeting-${transcriptId}-reconcile-${idempotencyKey.slice(0, 10)}`);
      const result = await runner('reconcile', {
        meetingId: artifact.meetingId,
        ...humainRouteRequest(options.route),
        segments,
        provisionalClaims: artifact.provisionalClaims,
        context: approvedContext,
        idempotencyKey,
      }, { storeDir, runId, onStatus: options.onStatus });
      const output = parseEnrichmentOutput(result.output, validIds);
      const analysis: MeetingAnalysis = {
        final: true,
        summary: output.summary,
        claims: output.claims,
        runId: result.runId,
        createdAt: new Date().toISOString(),
      };
      artifact = {
        ...artifact,
        analysis,
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
    saveMeetingArtifact(libraryDir, artifact);
    throw error;
  }
}

export async function chatWithMeeting(
  libraryDir: string,
  transcriptId: string,
  question: string,
  route: HumainMeetingRoute,
  onStatus?: (message: string) => void,
): Promise<MeetingArtifact> {
  const { record, path } = findTranscriptRecord(libraryDir, transcriptId);
  const artifact = loadMeetingArtifact(libraryDir, transcriptId);
  if (!artifact) throw new Error('Create the meeting artifact before using meeting chat');
  const trimmed = question.trim();
  if (!trimmed) throw new Error('Meeting question cannot be empty');
  const segments = meetingSegments(record);
  const validIds = new Set(segments.map((segment) => segment.id));
  const approvedContext = {
    calendar: artifact.calendar ?? null,
    attendees: artifact.attendees,
    priorConversation: artifact.chat.slice(-10),
  };
  const idempotencyKey = stableKey([
    transcriptId,
    'chat',
    trimmed,
    artifact.analysis?.claims ?? artifact.provisionalClaims,
    route,
    approvedContext,
  ]);
  const runId = runSafeId(`meeting-${transcriptId}-chat-${idempotencyKey.slice(0, 12)}`);
  const result = await runHumainMeeting('chat', {
    meetingId: artifact.meetingId,
    ...humainRouteRequest(route),
    question: trimmed,
    segments,
    finalClaims: artifact.analysis?.claims ?? artifact.provisionalClaims,
    context: approvedContext,
    idempotencyKey,
  }, {
    storeDir: join(dirname(path), '.humain'),
    runId,
    onStatus,
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
  const updated: MeetingArtifact = {
    ...artifact,
    chat: [
      ...artifact.chat,
      createChatMessage('user', trimmed),
      createChatMessage('assistant', output.answer, {
        evidenceSegmentIds: output.evidenceSegmentIds as string[],
        runId: result.runId,
      }),
    ],
  };
  saveMeetingArtifact(libraryDir, updated);
  return updated;
}
