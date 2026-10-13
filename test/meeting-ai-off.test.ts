import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AutomaticMeetingWatchService } from '../src/automatic-meeting-watch.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { parseCliArgs } from '../src/cli-args.ts';
import {
  createMeetingArtifact,
  loadMeetingArtifact,
  MeetingAiOffError,
  readMeetingAiSettings,
  saveMeetingArtifact,
} from '../src/meeting-artifact.ts';
import { chatWithMeeting, enrichMeeting } from '../src/meeting-enrichment.ts';
import { meetingViewLines } from '../src/meeting-tui.ts';
import { getMeeting, getTranscript, listActionItems, listMeetings, searchTranscripts } from '../src/meetings-mcp.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function library() {
  const home = mkdtempSync(join(tmpdir(), 'seashell-ai-off-test-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const save = (id: string, title: string, text: string) => {
    const record = createTranscriptRecord({ transcript: [{ start: 0, end: 2, text }], speakers: [] },
      { id, title, now: new Date('2026-10-01T10:00:00Z') });
    saveTranscriptRecord(root, record);
    const artifact = createMeetingArtifact(record);
    artifact.analysis = { final: true, summary: `Summary of ${title}`, runId: 'r', createdAt: record.createdAt,
      claims: [{ id: 'c', type: 'action_item', text: `Follow up on ${title}`, evidenceSegmentIds: ['s000001'], confidence: .9 }] };
    saveMeetingArtifact(root, artifact);
    return record;
  };
  const open = save('open-1', 'Roadmap sync', 'We agreed on the budget.');
  const closed = save('private-1', 'HR conversation', 'The budget is confidential.');
  saveMeetingArtifact(root, { ...loadMeetingArtifact(root, closed.id)!, ai: { off: true } });
  return { home, root, open, closed };
}

const route = { backend: 'codex' as const, model: 'fixture' };

describe('AI off for one meeting', () => {
  test('no model is called for it: notes and chat refuse before any run', async () => {
    const { root, closed } = library();
    let calls = 0;
    await expect(enrichMeeting(root, closed.id, { mode: 'post-session', route,
      runner: async () => { calls++; throw new Error('should not run'); } })).rejects.toBeInstanceOf(MeetingAiOffError);
    await expect(chatWithMeeting(root, closed.id, 'What was said?', route)).rejects.toBeInstanceOf(MeetingAiOffError);
    expect(calls).toBe(0);
  });

  test('agents can see it exists, but get none of its content', () => {
    const { root, open, closed } = library();
    expect(listMeetings(root).meetings).toContainEqual({ id: closed.id, title: 'HR conversation', startedAt: closed.createdAt, private: true });
    expect(() => getMeeting(root, { id: closed.id })).toThrow('private');
    expect(() => getTranscript(root, { id: closed.id })).toThrow('private');
    expect(searchTranscripts(root, { query: 'budget' }).matches.map((match) => match.meetingId)).toEqual([open.id]);
    expect(listActionItems(root).items.map((item) => item.meetingId)).toEqual([open.id]);
    expect(listMeetings(root, { query: 'confidential' }).meetings).toEqual([]);
  });

  test('the Notes tab says so instead of offering to write notes', () => {
    const { root, closed } = library();
    expect(meetingViewLines(loadMeetingArtifact(root, closed.id)!, 'notes')[0]).toBe('AI is off for this meeting.');
  });

  test('a background meeting keeps choices made while it ran, and gets no notes when AI is off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-ai-off-watch-'));
    roots.push(root);
    let enriched = 0;
    const service = new AutomaticMeetingWatchService({
      config: { libraryDir: root, meeting: { mode: 'hybrid',
        routes: { observer: route, reconciliation: route, chat: route },
        automation: { enabled: true, mode: 'automatic', confirmationPolls: 2 } } },
      dependencies: {
        now: () => new Date(1_000),
        readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: 1_000, supported: true,
          inputProcesses: [{ pid: 42, bundleId: 'us.zoom.xos', name: 'Zoom' }] }),
        startCapture: () => {
          const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'private-call', startedAtUnixMs: 1_000 });
          return { store, sessionId: 'private-call', manifestPath: store.manifestPath,
            async stop() { return store.setStatus('captured', 'test'); } };
        },
        finalizeCapture: async () => createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'Private matter.' }], speakers: [] },
          { id: 'private-call', now: new Date(1_000) }),
        enrich: async (libraryDir, id) => { enriched++; return loadMeetingArtifact(libraryDir, id)!; },
      },
    });
    await service.pollOnce();
    await service.pollOnce();
    // The owner opens the live meeting and turns AI off, with a note for later.
    saveMeetingArtifact(root, { ...loadMeetingArtifact(root, 'private-call')!, ai: { off: true, note: 'Sensitive' } });
    await service.shutdown();
    expect(enriched).toBe(0);
    expect(readMeetingAiSettings(root, 'private-call')).toEqual({ note: 'Sensitive', off: true });
  });

  test('parses as a meeting command', () => {
    expect(parseCliArgs(['meeting', 'ai', 'm-1', 'off'])).toMatchObject({ action: { kind: 'meeting-ai', id: 'm-1', off: true } });
    expect(parseCliArgs(['meeting', 'ai', 'm-1'])).toMatchObject({ action: { kind: 'meeting-ai', id: 'm-1' } });
    expect(() => parseCliArgs(['meeting', 'ai', 'm-1', 'maybe'])).toThrow('Usage: seashell meeting ai');
  });
});
