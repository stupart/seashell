import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createMeetingArtifact, loadMeetingArtifact, saveMeetingArtifact, type MeetingClaim } from '../src/meeting-artifact.ts';
import { enrichMeeting } from '../src/meeting-enrichment.ts';
import { getMeeting, listActionItems, queryNotes } from '../src/meeting-memory.ts';
import { meetingViewLines } from '../src/meeting-tui.ts';
import { findTranscriptRecord, saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const claim = (id: string, type: MeetingClaim['type'], text: string, segment: string, extra: Partial<MeetingClaim> = {}): MeetingClaim =>
  ({ id, type, text, evidenceSegmentIds: [segment], confidence: 0.9, ...extra });

/** Two made-up meetings: a pricing sync and a hiring sync, a week apart. */
function library() {
  const home = mkdtempSync(join(tmpdir(), 'seashell-analysis-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const pricing = createTranscriptRecord({
    transcript: [
      { start: 1, end: 4, text: 'We will ship the pricing page on Friday.', speaker: 'LOCAL' },
      { start: 65, end: 70, text: 'Dana will write the launch email by Thursday.', speaker: 'REMOTE_SPEAKER_00' },
      { start: 80, end: 84, text: 'Legal might block the new copy.', speaker: 'REMOTE_SPEAKER_00' },
      { start: 90, end: 93, text: 'Do we discount annual plans?', speaker: 'LOCAL' },
      { start: 95, end: 99, text: 'I will send Sam the numbers next week.', speaker: 'LOCAL' },
    ],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Dana' }],
  }, { id: 'pricing-sync', now: new Date('2026-10-01T09:00:00Z'), title: 'Pricing sync' });
  saveTranscriptRecord(root, pricing);
  saveMeetingArtifact(root, { ...createMeetingArtifact(pricing), status: 'ready', analysis: {
    final: true, summary: 'Pricing page ships Friday.', runId: 'r1', createdAt: '2026-10-01T10:00:00Z', claims: [
      claim('c1', 'decision', 'Ship the pricing page on Friday.', 's000001'),
      claim('c2', 'action_item', 'Write the launch email.', 's000002', { person: 'Dana', due: 'by Thursday' }),
      claim('c3', 'risk', 'Legal may block the copy.', 's000003'),
      claim('c4', 'open_question', 'Do annual plans get a discount?', 's000004'),
      claim('c5', 'follow_up', 'Send Sam the numbers.', 's000005', { person: 'You', due: 'next week' }),
      claim('c6', 'fact', 'Annual plans exist.', 's000004'),
    ],
  } });
  const hiring = createTranscriptRecord({
    transcript: [{ start: 3, end: 6, text: 'We hire two designers this quarter.', speaker: 'LOCAL' },
      { start: 7, end: 9, text: 'Dana books the interviews.', speaker: 'LOCAL' }],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }],
  }, { id: 'hiring-sync', now: new Date('2026-10-08T09:00:00Z'), title: 'Hiring sync' });
  saveTranscriptRecord(root, hiring);
  saveMeetingArtifact(root, { ...createMeetingArtifact(hiring), status: 'ready', analysis: {
    final: true, summary: 'Two designers.', runId: 'r2', createdAt: '2026-10-08T10:00:00Z', claims: [
      claim('h1', 'decision', 'Hire two designers this quarter.', 's000001'),
      claim('h2', 'action_item', 'Book the interviews.', 's000002', { person: 'Dana' }),
    ],
  } });
  return { root, pricing, hiring };
}

test('risks, open questions, follow-ups and due dates are stored, saved and read back', async () => {
  const { root, pricing } = library();
  const saved = loadMeetingArtifact(root, pricing.id)!;
  expect(saved.analysis!.claims.map((item) => item.type)).toEqual(['decision', 'action_item', 'risk', 'open_question', 'follow_up', 'fact']);
  expect(saved.analysis!.claims[1]).toMatchObject({ person: 'Dana', due: 'by Thursday' });
  const documents = join(dirname(findTranscriptRecord(root, pricing.id).path), 'documents');
  expect(readFileSync(join(documents, 'actions.md'), 'utf8')).toContain('- Write the launch email. (Dana · by Thursday) _(s000002)_');
  expect(readFileSync(join(documents, 'risks.md'), 'utf8')).toContain('- Legal may block the copy.');
  expect(readFileSync(join(documents, 'open-questions.md'), 'utf8')).toContain('- Do annual plans get a discount?');
  expect(readFileSync(join(documents, 'follow-ups.md'), 'utf8')).toContain('- Send Sam the numbers. (You · next week)');

  // Final notes from Humain carry the new types straight through.
  await enrichMeeting(root, pricing.id, {
    mode: 'post-session', route: { backend: 'codex', model: 'fixture' }, instructions: null,
    runner: async () => ({ runId: 'r3', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: { summary: 'S', claims: [
      claim('n1', 'follow_up', 'Check the legal review.', 's000003', { due: 'Monday' }),
    ] } }),
  });
  expect(loadMeetingArtifact(root, pricing.id)!.analysis!.claims[0]).toMatchObject({ type: 'follow_up', due: 'Monday' });
});

test('Notes lead with decisions, actions, risks, open questions and follow-ups, then the template, then the rest', () => {
  const { root, pricing } = library();
  const artifact = loadMeetingArtifact(root, pricing.id)!;
  artifact.analysis!.notes = [{ heading: 'Pricing', items: [{ text: 'Monthly stays the same.', evidenceSegmentIds: ['s000001'] }] }];
  const lines = meetingViewLines(artifact, 'notes', pricing);
  const headings = lines.filter((line) => line.startsWith('# '));
  expect(headings).toEqual(['# Decisions', '# Actions', '# Risks', '# Open questions', '# Follow-ups', '# Pricing', '# Facts and feedback']);
  expect(lines).toContain('- Write the launch email. (Dana · by Thursday)  01:05');
  expect(lines).toContain('- Send Sam the numbers. (You · next week)  01:35');
  expect(lines).toContain('- Legal may block the copy.  01:20');
});

test('agents read owners and due dates, and query notes across meetings by kind, person, topic and date', () => {
  const { root, pricing, hiring } = library();
  const meeting = getMeeting(root, { id: pricing.id });
  expect(meeting.notes.items[1]).toEqual({ type: 'action_item', text: 'Write the launch email.', person: 'Dana', due: 'by Thursday', evidence: ['s000002 01:05'] });
  expect(listActionItems(root).items.map((item) => [item.meetingId, item.due ?? null])).toEqual([[hiring.id, null], [pricing.id, 'by Thursday']]);

  // Open action items for a person, newest first, each with a quote of what was said.
  const dana = queryNotes(root, { kind: 'actions', person: 'dana' });
  expect(dana.items.map((item) => item.text)).toEqual(['Book the interviews.', 'Write the launch email.']);
  expect(dana.items[1]).toMatchObject({ due: 'by Thursday', quote: 'Dana will write the launch email by Thursday.', evidence: ['s000002 01:05'] });
  // Decisions about a topic since a date: the topic can be in the cited words, not only the note.
  expect(queryNotes(root, { kind: 'decisions', about: 'pricing', since: '2026-09-01' }).items.map((item) => item.meetingId)).toEqual([pricing.id]);
  expect(queryNotes(root, { kind: 'decisions', since: '2026-10-05' }).items.map((item) => item.text)).toEqual(['Hire two designers this quarter.']);
  expect(queryNotes(root, { kind: ['risks', 'questions'] }).items.map((item) => item.type)).toEqual(['risk', 'open_question']);
  expect(queryNotes(root, { meeting: 'hiring' }).items.map((item) => item.type)).toEqual(['decision', 'action_item']);
  // Facts are not one of the queried kinds; a made-up kind is a readable error.
  expect(queryNotes(root).items.some((item) => item.type === 'fact')).toBeFalse();
  expect(() => queryNotes(root, { kind: 'gossip' })).toThrow('kind must be one of');

  // Private meetings are never part of an answer.
  saveMeetingArtifact(root, { ...loadMeetingArtifact(root, hiring.id)!, ai: { off: true } });
  expect(queryNotes(root, { person: 'dana' }).items.map((item) => item.meetingId)).toEqual([pricing.id]);
});
