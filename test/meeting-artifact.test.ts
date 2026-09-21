import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
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

function fixture(id = 'meeting-1') {
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
  }, { id, title: 'Launch review', now: new Date('2026-08-10T14:00:00Z') });
  const saved = saveTranscriptRecord(root, record);
  return { root, record, saved };
}

describe('meeting artifact bundle', () => {
  test('damaged optional meeting metadata cannot prevent saving the base transcript', () => {
    const { root, record, saved } = fixture();
    writeFileSync(join(saved.directory, 'meeting.json'), '{incomplete');
    const next = { ...record, transcript: [{ start: 0, end: 1, text: 'Still captured.' }] };
    expect(saveTranscriptRecord(root, next).meetingWarning).toContain('Transcript saved');
    expect(JSON.parse(readFileSync(saved.jsonPath, 'utf8')).transcript[0].text).toBe('Still captured.');
    expect(() => loadMeetingArtifact(root, record.id)).toThrow('malformed JSON');
  });
  for (const change of ['text', 'insert', 'remove', 'merge', 'split', 'speaker'] as const) {
    test(`a ${change} revision retires old claims and restarts observation without resetting its budget`, async () => {
      const { root, record, saved } = fixture();
      const before = createMeetingArtifact(record, { mode: 'hybrid' });
      before.session.cursor = record.transcript.length;
      before.session.observerRunIds = ['prior-observer'];
      before.provisionalClaims = [{ id: 'old', type: 'decision', text: 'Ship Friday', evidenceSegmentIds: ['s000002'], confidence: .9 }];
      before.analysis = { final: true, summary: 'Old summary', claims: before.provisionalClaims, runId: 'prior-final', createdAt: record.createdAt };
      saveMeetingArtifact(root, before);
      const next = structuredClone(record);
      if (change === 'text') next.transcript[1]!.text = 'We should ship Monday.';
      if (change === 'insert') next.transcript.unshift({ start: 0, end: 0, text: 'Welcome.' });
      if (change === 'remove') next.transcript.splice(1, 1);
      if (change === 'merge') next.transcript.splice(1, 2, { start: 2, end: 7, text: 'We should ship Friday. Agreed.' });
      if (change === 'split') next.transcript.splice(1, 1, { start: 2, end: 3, text: 'We should' }, { start: 3, end: 5, text: 'ship Friday.' });
      if (change === 'speaker') next.speakers[1]!.label = 'Someone else';
      saveTranscriptRecord(root, next);
      const refreshed = loadMeetingArtifact(root, record.id)!;
      expect(refreshed.session.cursor).toBe(0);
      expect(refreshed.session.observerRunIds).toEqual(['prior-observer']);
      expect(refreshed.provisionalClaims).toEqual([]);
      expect(refreshed.analysis).toBeUndefined();
      expect(existsSync(join(saved.directory, 'overlays', 'final.json'))).toBe(false);
      expect(readFileSync(join(saved.directory, 'documents', 'summary.md'), 'utf8')).not.toContain('Old summary');
      const history = readdirSync(join(saved.directory, 'history', 'meeting-revisions')).map((name) =>
        JSON.parse(readFileSync(join(saved.directory, 'history', 'meeting-revisions', name), 'utf8')));
      expect(history.some((entry) => entry.transcript?.transcript[1]?.text === record.transcript[1]!.text && entry.meeting.analysis?.summary === 'Old summary')).toBe(true);
      const actions: string[] = [];
      await enrichMeeting(root, record.id, { mode: 'hybrid', route: { backend: 'codex', model: 'fixture' },
        runner: async (action, request) => {
          actions.push(action);
          const input = request as { priorClaims?: unknown[]; provisionalClaims?: unknown[] };
          expect(input.priorClaims ?? input.provisionalClaims).toEqual([]);
          return { runId: `new-${action}`, compiledRunId: 'new', status: 'succeeded', receipt: {}, output: { summary: 'Fresh summary', claims: [] } };
        } });
      expect(actions).toEqual(['observe', 'reconcile']);
    });
  }

  test('ordinary append retains observed evidence and cursor, while retiring a completed summary', () => {
    const { root, record } = fixture();
    const artifact = createMeetingArtifact(record);
    artifact.session.cursor = 4;
    artifact.session.observerRunIds = ['observed'];
    artifact.provisionalClaims = [{ id: 'kept', type: 'note', text: 'Ada introduced herself', evidenceSegmentIds: ['s000001'], confidence: .9 }];
    artifact.analysis = { final: true, summary: 'Earlier complete record', claims: [], runId: 'final', createdAt: record.createdAt };
    saveMeetingArtifact(root, artifact);
    saveTranscriptRecord(root, { ...record, transcript: [...record.transcript, { id: 'later', start: 10, end: 12, text: 'A new topic.' }] });
    const loaded = loadMeetingArtifact(root, record.id)!;
    expect(loaded.session.cursor).toBe(4);
    expect(loaded.provisionalClaims).toEqual(artifact.provisionalClaims);
    expect(loaded.analysis).toBeUndefined();
  });

  test('an in-flight model result cannot reattach evidence after a transcript replacement', async () => {
    const { root, record } = fixture();
    await expect(enrichMeeting(root, record.id, { mode: 'post-session', route: { backend: 'codex', model: 'fixture' },
      runner: async () => {
        saveTranscriptRecord(root, { ...record, transcript: record.transcript.map((segment) => ({ ...segment, text: 'Changed evidence.' })) });
        return { runId: 'stale-result', compiledRunId: 'stale', status: 'succeeded', receipt: {},
          output: { summary: 'Stale summary', claims: [{ id: 'stale', type: 'note', text: 'Wrong meaning', evidenceSegmentIds: ['s000001'], confidence: .9 }] } };
      } })).rejects.toThrow('Transcript changed');
    const loaded = loadMeetingArtifact(root, record.id)!;
    expect(loaded.status).toBe('base-only');
    expect(loaded.analysis).toBeUndefined();
    expect(loaded.provisionalClaims).toEqual([]);
  });

  test('legacy and interrupted replacements are repaired on load before chat or enrichment', () => {
    const { root, record, saved } = fixture();
    const artifact = createMeetingArtifact(record);
    artifact.session.cursor = 4;
    artifact.session.observerRunIds = ['old'];
    artifact.provisionalClaims = [{ id: 'unknown', type: 'note', text: 'Unbound legacy evidence', evidenceSegmentIds: ['s000001'], confidence: .9 }];
    delete artifact.transcriptEvidence;
    writeFileSync(join(saved.directory, 'meeting.json'), JSON.stringify(artifact));
    const loaded = loadMeetingArtifact(root, record.id)!;
    expect(loaded.provisionalClaims).toEqual([]);
    expect(loaded.session.cursor).toBe(0);
    expect(loaded.session.observerRunIds).toEqual(['old']);
    // Simulate a crash after transcript.json was replaced but before meeting refresh.
    loaded.provisionalClaims = [{ id: 'bound', type: 'note', text: 'Prior evidence', evidenceSegmentIds: ['s000001'], confidence: .9 }];
    saveMeetingArtifact(root, loaded);
    writeFileSync(saved.jsonPath, JSON.stringify({ ...record, transcript: [] }));
    expect(loadMeetingArtifact(root, record.id)!.provisionalClaims).toEqual([]);
  });

  test('long transcript IDs preserve distinct reconciliation identities', async () => {
    const { root, record } = fixture('meeting.notes-' + 'a'.repeat(120));
    const ids: string[] = [];
    const runner: NonNullable<Parameters<typeof enrichMeeting>[2]['runner']> = async (_action, _request, options) => {
      ids.push(options.runId);
      return { runId: options.runId, compiledRunId: 'compiled', status: 'succeeded',
        output: { summary: 'Done.', claims: [] }, receipt: {} };
    };
    for (const revision of [1, 1, 2]) {
      await enrichMeeting(root, record.id, { mode: 'post-session',
        route: { backend: 'codex', model: 'fixture' }, context: { revision }, runner });
    }
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[2]);
    expect(ids.every((id) => id.length <= 96)).toBe(true);
    expect(ids.every((id) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))).toBe(true);
  });

  for (const change of ['route', 'transcript'] as const) {
    test(`changed ${change} after observer failure gets a distinct durable request`, async () => {
      const { root, record } = fixture();
      const identities: Array<{ key: unknown; runId: string }> = [];
      const runner: NonNullable<Parameters<typeof enrichMeeting>[2]['runner']> = async (_action, request, options) => {
        identities.push({ key: (request as { idempotencyKey: string }).idempotencyKey, runId: options.runId });
        if (identities.length === 1) throw new Error('provider failure');
        return { runId: options.runId, compiledRunId: 'compiled', status: 'succeeded',
          output: { summary: 'Done.', claims: [] }, receipt: {} };
      };
      const options = { mode: 'streaming' as const, route: { backend: 'codex' as const, model: 'fixture/first' }, runner };
      await expect(enrichMeeting(root, record.id, options)).rejects.toThrow('provider failure');
      if (change === 'transcript') saveTranscriptRecord(root, { ...record,
        transcript: record.transcript.map((segment) => ({ ...segment, text: segment.text + ' Revised.' })) });
      await enrichMeeting(root, record.id, { ...options,
        ...(change === 'route' ? { route: { ...options.route, model: 'fixture/second' } } : {}),
      });
      expect(identities).toHaveLength(2);
      expect(identities[0]!.key).not.toBe(identities[1]!.key);
      expect(identities[0]!.runId).not.toBe(identities[1]!.runId);
    });
  }

  test('an observer cannot cite evidence outside its supplied window', async () => {
    const { root, record } = fixture();
    await expect(enrichMeeting(root, record.id, { mode: 'streaming',
      route: { backend: 'codex', model: 'fixture' }, maximumNewSegments: 2, overlapSegments: 1,
      maxObserverRuns: 1,
      runner: async () => ({ runId: 'observer', compiledRunId: 'compiled', status: 'succeeded', receipt: {},
        output: { summary: 'Unsupported future evidence.', claims: [{ id: 'future', type: 'note',
          text: 'Notes will be written.', evidenceSegmentIds: ['s000004'], confidence: 0.9 }] } }),
    })).rejects.toThrow('missing segment s000004');
  });

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
