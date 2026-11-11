import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { runExtractor } from '../src/extractors.ts';
import type { runHumainMeeting } from '../src/humain-client.ts';
import { createMeetingArtifact, loadMeetingArtifact, saveMeetingArtifact, type MeetingArtifact } from '../src/meeting-artifact.ts';
import { meetingEvidence } from '../src/meeting-evidence.ts';
import { chatWithMeeting, enrichMeeting } from '../src/meeting-enrichment.ts';
import { getInsights, getMeeting, queryNotes } from '../src/meeting-memory.ts';
import { meetingViewLines } from '../src/meeting-tui.ts';
import { findTranscriptRecord, saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import type { TranscriptRecord } from '../src/transcript-types.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const route = { backend: 'codex' as const, model: 'fixture' };

/**
 * A made-up standup whose notes, live claims, insights and chat all cite line
 * s000001, "Thank you.", which Whisper heard in silence.
 */
function library() {
  const home = mkdtempSync(join(tmpdir(), 'seashell-removed-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const record = createTranscriptRecord({
    transcript: [
      { start: 1, end: 2, text: 'Thank you.', speaker: 'LOCAL' },
      { start: 6, end: 8, text: 'We ship on Friday.', speaker: 'LOCAL' },
      { start: 9, end: 11, text: 'I will send the deck.', speaker: 'REMOTE_SPEAKER_00' },
    ],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' }],
  }, { id: 'standup', now: new Date('2026-10-02T09:00:00Z'), title: 'Standup' });
  saveTranscriptRecord(root, record);
  const artifact: MeetingArtifact = { ...createMeetingArtifact(record), status: 'ready',
    provisionalClaims: [
      { id: 'p1', type: 'note', text: 'Thanks were said.', evidenceSegmentIds: ['s000001'], confidence: 0.5 },
      { id: 'p2', type: 'decision', text: 'Ship Friday.', evidenceSegmentIds: ['s000001', 's000002'], confidence: 0.8 },
    ],
    analysis: { final: true, summary: 'Ship Friday.', runId: 'r', createdAt: '2026-10-02T09:30:00Z',
      claims: [
        { id: 'c1', type: 'decision', text: 'Ship on Friday.', evidenceSegmentIds: ['s000001', 's000002'], confidence: 0.9 },
        { id: 'c2', type: 'highlight', text: 'Everyone was grateful.', evidenceSegmentIds: ['s000001'], confidence: 0.4 },
        { id: 'c3', type: 'action_item', text: 'Send the deck.', person: 'Remote speaker 1', evidenceSegmentIds: ['s000003'], confidence: 0.9 },
      ],
      template: 'Standup', notes: [{ heading: 'Mood', items: [{ text: 'Grateful.', evidenceSegmentIds: ['s000001'] }] }] },
    insights: [{ extractor: 'Thanks', createdAt: '2026-10-02T09:40:00Z', runId: 'x',
      fields: [{ name: 'Thanks', items: [{ text: 'A thank you.', evidenceSegmentIds: ['s000001'] }] }] }],
    chat: [
      { id: 'q', role: 'user', text: 'Who thanked whom?', createdAt: '2026-10-02T09:50:00Z' },
      { id: 'a', role: 'assistant', text: 'Someone said thank you.', createdAt: '2026-10-02T09:50:01Z', evidenceSegmentIds: ['s000001'], runId: 'c' },
    ] };
  saveMeetingArtifact(root, artifact);
  const directory = dirname(findTranscriptRecord(root, record.id).path);
  return { root, record, directory };
}

/** What `library clean-phantoms` saved: s000001 gone, the other lines keeping their IDs. */
function withoutFirstLine(record: TranscriptRecord): TranscriptRecord {
  return { ...record, updatedAt: '2026-10-03T09:00:00.000Z',
    transcript: record.transcript.slice(1).map((segment, index) => ({ ...segment, id: `s00000${index + 2}` })) };
}

/** A Humain that refuses, as the real one does, any claim citing a line it was not given. */
function strictHumain(sent: Array<{ role: string; request: any }>, output: (role: string) => unknown): typeof runHumainMeeting {
  return (async (role: string, request: any) => {
    sent.push({ role, request });
    const ids = new Set((request.segments as Array<{ id: string }>).map((segment) => segment.id));
    for (const field of ['provisionalClaims', 'finalClaims'] as const) {
      (request[field] ?? []).forEach((claim: any, index: number) => {
        if (Object.keys(claim).some((key) => !['id', 'type', 'text', 'evidenceSegmentIds', 'confidence', 'speakerId', 'person', 'due'].includes(key))) {
          throw new Error(`${field}[${index}] has an unknown field`);
        }
        const unknown = claim.evidenceSegmentIds.find((id: string) => !ids.has(id));
        if (unknown) throw new Error(`${field}[${index}] cites unknown segment ${unknown}`);
      });
    }
    for (const message of request.context?.priorConversation ?? []) {
      const unknown = (message.evidenceSegmentIds ?? []).find((id: string) => !ids.has(id));
      if (unknown || 'removedEvidenceSegmentIds' in message) throw new Error(`priorConversation cites unknown segment ${unknown}`);
    }
    return { runId: `run-${role}`, compiledRunId: 'c', status: 'succeeded', receipt: {}, output: output(role) };
  }) as typeof runHumainMeeting;
}

const answers = (role: string) => role === 'chat' ? { answer: 'Friday.', evidenceSegmentIds: ['s000002'] }
  : role === 'extract' ? { fields: [{ name: 'Thanks', items: [] }] }
  : { summary: 'Ship Friday.', claims: [{ id: 'n1', type: 'decision', text: 'Ship Friday.', evidenceSegmentIds: ['s000002'], confidence: 0.9 }] };

test('removing a phantom line moves every citation of it aside, marked, and nothing that cited it disappears', () => {
  const { root, record } = library();
  saveTranscriptRecord(root, withoutFirstLine(record), { keepNotes: 'Lines heard in silence were removed' });
  const raw = JSON.parse(readFileSync(join(dirname(findTranscriptRecord(root, record.id).path), 'meeting.json'), 'utf8')) as MeetingArtifact;
  expect(JSON.stringify(raw)).not.toContain('"evidenceSegmentIds":["s000001"');
  expect(raw.provisionalClaims.map((claim) => [claim.evidenceSegmentIds, claim.removedEvidenceSegmentIds])).toEqual([
    [[], ['s000001']], [['s000002'], ['s000001']]]);
  expect(raw.analysis!.claims.map((claim) => [claim.id, claim.evidenceSegmentIds, claim.removedEvidenceSegmentIds])).toEqual([
    ['c1', ['s000002'], ['s000001']], ['c2', [], ['s000001']], ['c3', ['s000003'], undefined]]);
  expect(raw.analysis!.notes![0]!.items[0]).toEqual({ text: 'Grateful.', evidenceSegmentIds: [], removedEvidenceSegmentIds: ['s000001'] });
  expect(raw.insights![0]!.fields[0]!.items[0]!.removedEvidenceSegmentIds).toEqual(['s000001']);
  expect(raw.chat[1]).toMatchObject({ evidenceSegmentIds: [], removedEvidenceSegmentIds: ['s000001'] });
  expect(raw.notesOutdated?.reason).toBe('Lines heard in silence were removed');

  // People and agents see the point, and that its line is gone, never a line at 00:00.
  const artifact = loadMeetingArtifact(root, record.id)!;
  const lines = meetingViewLines(artifact, 'notes', findTranscriptRecord(root, record.id).record);
  expect(lines).toContain('- Everyone was grateful. (source line removed)');
  expect(lines).toContain('- Grateful. (source line removed)');
  const meeting = getMeeting(root, { id: record.id });
  expect(meeting.notes.items.find((item) => item.text === 'Everyone was grateful.')!.evidence).toEqual(['s000001 (no longer in the transcript)']);
  expect(meeting.notes.items[0]!.evidence).toEqual(['s000002 00:06', 's000001 (no longer in the transcript)']);
  expect(getInsights(root, { id: record.id }).insights[0]!.fields[0]!.items[0]!.evidence).toEqual(['s000001 (no longer in the transcript)']);
  const documents = join(dirname(findTranscriptRecord(root, record.id).path), 'documents');
  expect(readFileSync(join(documents, 'meeting-notes.md'), 'utf8')).toContain('- Grateful. _(source line removed)_');

  // Restoring the line brings its citations back.
  saveTranscriptRecord(root, { ...record, updatedAt: '2026-10-04T09:00:00.000Z' }, { keepNotes: 'The transcript was restored from history' });
  const restored = loadMeetingArtifact(root, record.id)!;
  expect(restored.analysis!.claims.map((claim) => [claim.evidenceSegmentIds, claim.removedEvidenceSegmentIds])).toEqual([
    [['s000002', 's000001'], undefined], [['s000001'], undefined], [['s000003'], undefined]]);
});

test('after clean-phantoms, rewriting notes, chat and extractors send Humain only lines it has', async () => {
  const { root, record } = library();
  saveTranscriptRecord(root, withoutFirstLine(record), { keepNotes: 'Lines heard in silence were removed' });
  const sent: Array<{ role: string; request: any }> = [];
  const runner = strictHumain(sent, answers);
  await chatWithMeeting(root, record.id, 'When do we ship?', route, undefined, runner);
  await runExtractor(root, record.id, { name: 'Thanks', when: { kind: 'manual' }, fields: [{ name: 'Thanks' }], prompt: '', path: '/x/thanks.md' }, { route, runner });
  await enrichMeeting(root, record.id, { mode: 'hybrid', route, instructions: null, runner });
  expect(sent.map((call) => call.role)).toEqual(['chat', 'extract', 'observe', 'reconcile']);
  // A claim whose only line is gone is left out; one with a line left cites only that.
  expect(sent[0]!.request.finalClaims.map((claim: any) => [claim.id, claim.evidenceSegmentIds])).toEqual([['c1', ['s000002']], ['c3', ['s000003']]]);
  expect(sent[1]!.request.finalClaims.map((claim: any) => claim.id)).toEqual(['c1', 'c3']);
  expect(sent[2]!.request.priorClaims.map((claim: any) => [claim.id, claim.evidenceSegmentIds])).toEqual([['p2', ['s000002']]]);
  expect(sent[3]!.request.provisionalClaims.map((claim: any) => [claim.id, claim.evidenceSegmentIds])).toEqual([['p2', ['s000002']], ['n1', ['s000002']]]);
});

test('meetings cleaned before this fix heal as they are read, with no migration', async () => {
  const { root, record, directory } = library();
  // Exactly what rc33 left: the line gone, every citation of it still in meeting.json.
  const cleaned = withoutFirstLine(record);
  writeFileSync(join(directory, 'transcript.json'), `${JSON.stringify(cleaned, null, 2)}\n`);
  const path = join(directory, 'meeting.json');
  const stored = JSON.parse(readFileSync(path, 'utf8')) as MeetingArtifact;
  writeFileSync(path, `${JSON.stringify({ ...stored, transcriptEvidence: meetingEvidence(cleaned),
    notesOutdated: { at: '2026-10-03T09:00:00.000Z', reason: 'Lines heard in silence were removed' } }, null, 2)}\n`);
  const before = statSync(path).mtimeMs;

  const meeting = getMeeting(root, { id: record.id });
  expect(JSON.stringify(meeting)).not.toContain('s000001 00:00');
  expect(meeting.notes.items[1]!.evidence).toEqual(['s000001 (no longer in the transcript)']);
  expect(queryNotes(root, { kind: 'decisions' }).items[0]!.evidence).toEqual(['s000002 00:06', 's000001 (no longer in the transcript)']);
  expect(meetingViewLines(loadMeetingArtifact(root, record.id)!, 'notes', cleaned)).toContain('- Everyone was grateful. (source line removed)');
  expect(statSync(path).mtimeMs).toBe(before);

  const sent: Array<{ role: string; request: any }> = [];
  const runner = strictHumain(sent, answers);
  await chatWithMeeting(root, record.id, 'When do we ship?', route, undefined, runner);
  await runExtractor(root, record.id, { name: 'Thanks', when: { kind: 'manual' }, fields: [{ name: 'Thanks' }], prompt: '', path: '/x/thanks.md' }, { route, runner });
  const notes = await enrichMeeting(root, record.id, { mode: 'hybrid', route, instructions: null, runner });
  expect(notes.status).toBe('ready');
  // The first save also wrote the healed citations back.
  const healed = JSON.parse(readFileSync(path, 'utf8')) as MeetingArtifact;
  expect(healed.provisionalClaims[0]).toMatchObject({ evidenceSegmentIds: [], removedEvidenceSegmentIds: ['s000001'] });
  expect(healed.chat[1]).toMatchObject({ evidenceSegmentIds: [], removedEvidenceSegmentIds: ['s000001'] });
});
