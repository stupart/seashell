import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendProvisionalOverlay,
  createMeetingArtifact,
  loadMeetingArtifact,
  saveMeetingArtifact,
} from '../src/meeting-artifact.ts';
import { enrichMeeting } from '../src/meeting-enrichment.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seashell-meeting-test-'));
  roots.push(root);
  const record = createTranscriptRecord({
    transcript: [
      { start: 0, end: 2, speaker: 'speaker-1', text: "Hi, I'm Ada." },
      { start: 2, end: 5, speaker: 'speaker-2', text: 'We should ship Friday.' },
      { start: 5, end: 7, speaker: 'speaker-1', text: 'Agreed.' },
      { start: 7, end: 10, speaker: 'speaker-2', text: 'I will write the notes.' },
    ],
    speakers: [
      { id: 'speaker-1', label: 'Ada' },
      { id: 'speaker-2', label: 'Charles' },
    ],
  }, { id: 'meeting-1', title: 'Launch review', now: new Date('2026-08-10T14:00:00Z') });
  const saved = saveTranscriptRecord(root, record);
  return { root, record, saved };
}

describe('meeting artifact bundle', () => {
  test('saves a companion manifest, readable documents, subtitles, and append-only overlays', () => {
    const { root, record, saved } = fixture();
    const artifact = createMeetingArtifact(record, { mode: 'hybrid' });
    saveMeetingArtifact(root, artifact);
    appendProvisionalOverlay(root, record.id, {
      schemaVersion: 1,
      runId: 'observer-1',
      observedAt: '2026-08-10T14:01:00Z',
      fromCursor: 0,
      toCursor: 2,
      summary: 'A possible launch decision appeared.',
      claims: [{
        id: 'decision-1',
        type: 'decision',
        text: 'Ship Friday.',
        evidenceSegmentIds: ['s000002'],
        confidence: 0.8,
      }],
    });

    expect(loadMeetingArtifact(root, record.id)?.status).toBe('base-only');
    expect(readFileSync(join(saved.directory, 'meeting.json'), 'utf8')).toContain('Launch review');
    expect(readFileSync(join(saved.directory, 'transcript.vtt'), 'utf8')).toStartWith('WEBVTT');
    expect(readFileSync(join(saved.directory, 'documents', 'summary.md'), 'utf8'))
      .toContain('No final summary yet');
    expect(readFileSync(join(saved.directory, 'overlays', 'provisional.jsonl'), 'utf8'))
      .toContain('observer-1');
  });

  test('hybrid mode observes bounded deltas then reconciles the frozen record', async () => {
    const { root, record, saved } = fixture();
    const calls: Array<{ action: string; request: Record<string, unknown> }> = [];
    const artifact = await enrichMeeting(root, record.id, {
      mode: 'hybrid',
      route: { backend: 'openrouter', model: 'test/cheap' },
      minimumNewSegments: 2,
      maximumNewSegments: 2,
      maxObserverRuns: 4,
      runner: async (action, request) => {
        calls.push({ action, request: request as Record<string, unknown> });
        const segments = (request as { segments: Array<{ id: string }> }).segments;
        const output = action === 'reconcile'
          ? {
              summary: 'The team decided to ship Friday and Charles owns the notes.',
              claims: [{
                id: 'decision-final',
                type: 'decision',
                text: 'Ship Friday.',
                evidenceSegmentIds: ['s000002', 's000003'],
                confidence: 0.96,
              }],
            }
          : {
              summary: 'Provisional observation.',
              claims: [{
                id: `note-${segments.at(-1)?.id}`,
                type: 'note',
                text: 'A relevant statement was made.',
                evidenceSegmentIds: [segments.at(-1)!.id],
                confidence: 0.7,
              }],
            };
        return {
          runId: `${action}-${calls.length}`,
          compiledRunId: `compiled-${calls.length}`,
          status: 'succeeded',
          output,
          receipt: {},
        };
      },
    });

    expect(calls.map((call) => call.action)).toEqual(['observe', 'observe', 'reconcile']);
    expect((calls[1]!.request.segments as unknown[]).length).toBe(4);
    expect(artifact.status).toBe('ready');
    expect(artifact.session.cursor).toBe(4);
    expect(artifact.analysis?.final).toBe(true);
    expect(artifact.analysis?.claims[0]?.evidenceSegmentIds).toEqual(['s000002', 's000003']);
    expect(readFileSync(join(saved.directory, 'documents', 'decisions.md'), 'utf8'))
      .toContain('Ship Friday');
    expect(readFileSync(join(saved.directory, 'enriched', 'transcript.json'), 'utf8'))
      .toContain('decision-final');
  });

  test('hybrid mode sends each product job to its selected exact route', async () => {
    const { root, record } = fixture();
    const calls: Array<{ action: string; backend?: string; model?: string }> = [];
    await enrichMeeting(root, record.id, {
      mode: 'hybrid',
      routes: {
        observer: { backend: 'openrouter', model: 'vendor/cheap' },
        reconciliation: { backend: 'codex', model: 'gpt-strong' },
      },
      minimumNewSegments: 4,
      runner: async (action, request) => {
        const route = request as { backend?: string; model?: string };
        calls.push({ action, backend: route.backend, model: route.model });
        return {
          runId: `${action}-route`,
          compiledRunId: `${action}-compiled`,
          status: 'succeeded',
          output: { summary: 'Done.', claims: [] },
          receipt: {},
        };
      },
    });
    expect(calls).toEqual([
      { action: 'observe', backend: 'openrouter', model: 'vendor/cheap' },
      { action: 'reconcile', backend: 'codex', model: 'gpt-strong' },
    ]);
  });

  test('streaming and post-session modes require only the route they execute', async () => {
    const streaming = fixture();
    const streamingCalls: string[] = [];
    await enrichMeeting(streaming.root, streaming.record.id, {
      mode: 'streaming',
      routes: { observer: { backend: 'openrouter', model: 'vendor/cheap' } },
      minimumNewSegments: 4,
      runner: async (action) => {
        streamingCalls.push(action);
        return {
          runId: 'observe-only', compiledRunId: 'compiled-observe', status: 'succeeded',
          output: { summary: 'Live only.', claims: [] }, receipt: {},
        };
      },
    });
    expect(streamingCalls).toEqual(['observe']);

    const post = fixture();
    const postCalls: string[] = [];
    await enrichMeeting(post.root, post.record.id, {
      mode: 'post-session',
      routes: { reconciliation: { backend: 'codex', model: 'gpt-strong' } },
      runner: async (action) => {
        postCalls.push(action);
        return {
          runId: 'reconcile-only', compiledRunId: 'compiled-reconcile', status: 'succeeded',
          output: { summary: 'Final only.', claims: [] }, receipt: {},
        };
      },
    });
    expect(postCalls).toEqual(['reconcile']);
  });

  test('a successful retry clears failed session state and returns persisted metadata', async () => {
    const { root, record } = fixture();
    const route = { backend: 'openrouter' as const, model: 'test/cheap' };
    await expect(enrichMeeting(root, record.id, {
      mode: 'post-session',
      route,
      runner: async () => { throw new Error('temporary provider failure'); },
    })).rejects.toThrow('temporary provider failure');
    expect(loadMeetingArtifact(root, record.id)?.session.stoppedReason).toBe('failed');

    const retried = await enrichMeeting(root, record.id, {
      mode: 'post-session',
      route,
      runner: async () => ({
        runId: 'reconcile-retry',
        compiledRunId: 'compiled-retry',
        status: 'succeeded',
        output: {
          summary: 'The retry succeeded.',
          claims: [{
            id: 'retry-note',
            type: 'note',
            text: 'The retry produced a final artifact.',
            evidenceSegmentIds: ['s000001'],
            confidence: 0.9,
          }],
        },
        receipt: {},
      }),
    });
    const persisted = loadMeetingArtifact(root, record.id);
    expect(retried.status).toBe('ready');
    expect(retried.failure).toBeUndefined();
    expect(retried.session.stoppedReason).toBe('meeting-ended');
    expect(persisted).toBeDefined();
    expect(retried.updatedAt).toBe(persisted!.updatedAt);
  });

  test('approved context participates in the durable meeting identity', async () => {
    const { root, record } = fixture();
    const keys: string[] = [];
    const runner = async (_action: string, request: unknown) => {
      keys.push((request as { idempotencyKey: string }).idempotencyKey);
      return {
        runId: `run-${keys.length}`,
        compiledRunId: `compiled-${keys.length}`,
        status: 'succeeded' as const,
        output: { summary: 'Done.', claims: [] },
        receipt: {},
      };
    };
    const route = { backend: 'openrouter' as const, model: 'test/cheap' };
    await enrichMeeting(root, record.id, {
      mode: 'post-session', route, context: { projectRevision: 1 }, runner,
    });
    await enrichMeeting(root, record.id, {
      mode: 'post-session', route, context: { projectRevision: 2 }, runner,
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
