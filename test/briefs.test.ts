import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  briefDue,
  briefKey,
  findBrief,
  makeBrief,
  NoBriefHistoryError,
  ownerKeys,
  readNextMeeting,
  recordBriefAttempt,
  relevantMeetings,
  writeNextMeeting,
  type UpcomingMeeting,
} from '../src/briefs.ts';
import { draftFollowUp, draftText, mailtoUrl } from '../src/drafts.ts';
import type { runHumainMeeting } from '../src/humain-client.ts';
import { createMeetingArtifact, MeetingAiOffError, saveMeetingArtifact, type MeetingAttendee } from '../src/meeting-artifact.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const route = { backend: 'codex' as const, model: 'fixture' };
const rev4 = async () => new Set(['observe', 'reconcile', 'chat', 'extract', 'brief', 'draft']);
const rev3 = async () => new Set(['observe', 'reconcile', 'chat', 'extract']);
const you: MeetingAttendee = { name: 'Sam Owner', email: 'sam@example.com' };
const dana: MeetingAttendee = { name: 'Dana Whitfield', email: 'dana@acme.example' };
const lee: MeetingAttendee = { name: 'Lee', email: 'lee@other.example' };

function library() {
  const home = mkdtempSync(join(tmpdir(), 'seashell-briefs-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const env = { SEASHELL_BRIEFS_DIR: join(home, 'Briefs') } as NodeJS.ProcessEnv;
  /** A finished meeting with notes, made up. */
  const add = (id: string, title: string, day: number, attendees: MeetingAttendee[], options: { notes?: boolean; private?: boolean; eventId?: string } = {}) => {
    const record = createTranscriptRecord({ transcript: [
      { start: 0, end: 4, speaker: 'REMOTE_00', text: 'Can you send the security summary?' },
      { start: 4, end: 8, speaker: 'LOCAL', text: 'Yes, by Friday.' },
    ], speakers: [{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_00', label: 'Remote speaker 1' }] },
    { id, title, now: new Date(Date.UTC(2026, 10, day, 15)) });
    saveTranscriptRecord(root, record);
    const artifact = createMeetingArtifact(record, { calendar: { provider: 'macos-eventkit', eventId: options.eventId ?? `event-${id}`, title,
      startAt: record.createdAt, endAt: record.createdAt, attendees, calendar: 'sam@example.com' } });
    saveMeetingArtifact(root, { ...artifact, ...(options.private ? { ai: { off: true } } : {}),
      ...(options.notes === false ? {} : { status: 'ready' as const, analysis: { final: true, summary: `${title} notes.`, runId: 'r', createdAt: record.createdAt,
        claims: [{ id: 'c1', type: 'action_item' as const, text: 'Send the security summary.', person: 'Sam', due: 'Friday',
          evidenceSegmentIds: ['s000002'], confidence: 0.9 }] } }) });
  };
  return { home, root, env, add };
}

const upcoming = (title: string, attendees: MeetingAttendee[], eventId?: string): UpcomingMeeting =>
  ({ title, startsAt: '2026-11-20T15:00:00.000Z', attendees: [you, ...attendees], calendar: 'sam@example.com', ...(eventId ? { eventId } : {}) });

test('a brief reads the same series and anyone in common but you, newest first, never a private one', () => {
  const { root, add } = library();
  add('older-sync', 'Weekly Sync', 3, [you, lee]);
  add('acme-call', 'Acme discovery call', 5, [you, dana]);
  add('newer-sync', 'Weekly sync', 10, [you]);
  add('just-you', 'Planning', 11, [you, lee]);
  add('private', 'Acme pricing', 12, [you, dana], { private: true });
  add('no-notes', 'Acme follow-up', 13, [you, dana], { notes: false });
  add('after', 'Weekly sync', 21, [you]);
  expect(ownerKeys(root, { calendar: 'sam@example.com' })).toContain('sam@example.com');
  const chosen = relevantMeetings(root, upcoming('Weekly sync', [dana]));
  expect(chosen.map((meeting) => [meeting.id, meeting.why, meeting.shared])).toEqual([
    ['newer-sync', 'series', []],
    ['acme-call', 'people', ['Dana Whitfield']],
    ['older-sync', 'series', []],
  ]);
  // A recurring event's occurrences share an id, whatever their titles say.
  add('renamed', 'Sync (moved)', 14, [you], { eventId: 'series-1' });
  expect(relevantMeetings(root, upcoming('Something else', [], 'series-1')).map((meeting) => meeting.id)).toEqual(['renamed']);
  // A title that says nothing about which meeting it is makes no series.
  add('generic', 'Meeting', 15, [you]);
  expect(relevantMeetings(root, upcoming('Meeting', []))).toEqual([]);
  expect(relevantMeetings(root, upcoming('Weekly sync', [dana]), 2)).toHaveLength(2);
});

/** A fake Humain that writes a brief citing the first meeting it was given. */
function fakeBrief() {
  const requests: any[] = [];
  const runner: typeof runHumainMeeting = async (action, request: any) => {
    requests.push({ action, ...request });
    const first = request.meetings[0];
    return { runId: 'r', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: {
      summary: 'You owe them the security summary.',
      sections: [{ heading: 'Still open', items: [{ text: 'Send the security summary.', sources: [{ meetingId: first.meetingId, evidenceSegmentIds: ['s000002'] }] }] }],
    } };
  };
  return { requests, runner };
}

test('a brief is asked for with the contract\'s shape, saved as Markdown with citations, and found again', async () => {
  const { root, env, add } = library();
  add('acme-call', 'Acme discovery call', 5, [you, dana]);
  const humain = fakeBrief();
  const next = upcoming('Acme pilot kickoff', [dana], 'kickoff');
  const brief = await makeBrief(root, next, { route, runner: humain.runner, engine: rev4, env, now: new Date('2026-11-20T14:45:00Z') });
  const request = humain.requests[0];
  expect(request.action).toBe('brief');
  expect(request.briefId).toBe(briefKey(next));
  expect(request.idempotencyKey).toBeString();
  expect(request.upcoming).toEqual({ title: 'Acme pilot kickoff', startsAt: next.startsAt, attendees: [{ name: 'Sam Owner', email: 'sam@example.com' }, { name: 'Dana Whitfield', email: 'dana@acme.example' }] });
  expect(request.meetings).toEqual([{ meetingId: 'acme-call', title: 'Acme discovery call', startedAt: '2026-11-05T15:00:00.000Z',
    summary: 'Acme discovery call notes.', claims: [expect.objectContaining({ id: 'c1', evidenceSegmentIds: ['s000002'] })],
    // Only the lines the notes cite are sent.
    segments: [expect.objectContaining({ id: 's000002', text: 'Yes, by Friday.' })] }]);
  // Route fields sit at the top level, as on every meeting request.
  expect(request).toMatchObject({ backend: 'codex', model: 'fixture' });
  expect(request.route).toBeUndefined();
  expect(brief.path).toBe(join(env.SEASHELL_BRIEFS_DIR!, `${new Date(next.startsAt).getFullYear()}-11-20 ${String(new Date(next.startsAt).getHours()).padStart(2, '0')}00 Acme pilot kickoff.md`));
  const markdown = readFileSync(brief.path, 'utf8');
  expect(markdown).toContain('# Brief: Acme pilot kickoff');
  expect(markdown).toContain('- Send the security summary. _(Acme discovery call, Nov 5, 00:04)_');
  expect(markdown).toContain('(acme-call)');
  expect(findBrief(root, next, env)?.path).toBe(brief.path);
});

test('nothing to read is said plainly, and an older engine is told to update before anything is sent', async () => {
  const { root, env, add } = library();
  await expect(makeBrief(root, upcoming('Lunch', [lee]), { route, runner: fakeBrief().runner, engine: rev4, env })).rejects.toThrow(NoBriefHistoryError);
  add('acme-call', 'Acme discovery call', 5, [you, dana]);
  const humain = fakeBrief();
  await expect(makeBrief(root, upcoming('Acme pilot', [dana]), { route, runner: humain.runner, engine: rev3, env }))
    .rejects.toThrow('This AI engine cannot write briefs yet. Install a newer AI engine: seashell ai install <humain-package.tgz>');
  expect(humain.requests).toEqual([]);
  // An engine that cannot say prints its usage instead: the same plain answer.
  const usage: typeof runHumainMeeting = async () => { throw new Error('Humain failed: Usage: humain meeting observe|reconcile|chat|extract <request.json>'); };
  await expect(makeBrief(root, upcoming('Acme pilot', [dana]), { route, runner: usage, env })).rejects.toThrow('cannot write briefs yet');
});

test('a brief citing a meeting or moment it was not given is refused', async () => {
  const { root, env, add } = library();
  add('acme-call', 'Acme discovery call', 5, [you, dana]);
  const invented: typeof runHumainMeeting = async () => ({ runId: 'r', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: {
    summary: 'S', sections: [{ heading: 'H', items: [{ text: 'T', sources: [{ meetingId: 'acme-call', evidenceSegmentIds: ['s000001'] }] }] }] } });
  await expect(makeBrief(root, upcoming('Acme', [dana]), { route, runner: invented, engine: rev4, env })).rejects.toThrow('was not given');
});

test('the recorder makes a brief once, about 15 minutes ahead, and the app learns of the next meeting', () => {
  const { root, env } = library();
  const event = (minutes: number, title = 'Weekly sync') => ({ provider: 'macos-eventkit', eventId: `e-${title}`, title, attendees: [],
    startAt: new Date(Date.parse('2026-11-20T15:00:00Z') + minutes * 60_000).toISOString(), endAt: '2026-11-20T16:00:00.000Z' });
  const now = new Date('2026-11-20T15:00:00Z');
  expect(briefDue([event(30)], root, now, env)).toBeUndefined();
  const due = briefDue([event(30), event(12), event(14, 'Later')], root, now, env);
  expect(due?.title).toBe('Weekly sync');
  recordBriefAttempt(root, briefKey(due!), { at: now.toISOString(), outcome: 'no-history' }, env, now);
  expect(briefDue([event(12)], root, now, env)).toBeUndefined();
  writeNextMeeting(root, { upcoming: due!, history: 2 }, now.getTime());
  expect(readNextMeeting(root, now)).toMatchObject({ history: 2, upcoming: { title: 'Weekly sync' } });
  // Stale once the recorder stops saying it, or long after it started.
  expect(readNextMeeting(root, new Date(now.getTime() + 20 * 60_000))).toBeUndefined();
});

/** A fake Humain that drafts a short follow-up citing the meeting. */
function fakeDraft() {
  const requests: any[] = [];
  const runner: typeof runHumainMeeting = async (action, request: any) => {
    requests.push({ action, ...request });
    return { runId: 'r', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: {
      subject: 'Security summary',
      paragraphs: [
        { kind: 'greeting', text: 'Hi Dana,', evidenceSegmentIds: [] },
        { kind: 'body', text: 'I will send the security summary by Friday.', evidenceSegmentIds: ['s000002'] },
        { kind: 'closing', text: 'Thanks & talk soon,', evidenceSegmentIds: [] },
      ],
    } };
  };
  return { requests, runner };
}

test('a follow-up is the chat request plus a draft, addressed to everyone but you, and is never sent', async () => {
  const { root, add } = library();
  add('older', 'Weekly sync', 2, [you, lee]);
  add('acme-call', 'Acme discovery call', 5, [you, dana]);
  add('more', 'Planning', 6, [you, lee]);
  const humain = fakeDraft();
  const draft = await draftFollowUp(root, 'acme-call', 'email', route, { ask: 'keep it  to three bullets', runner: humain.runner, engine: rev4 });
  const request = humain.requests[0];
  expect(request.action).toBe('draft');
  expect(request).toMatchObject({ meetingId: 'acme-call', backend: 'codex', model: 'fixture',
    draft: { kind: 'email', audience: 'Dana Whitfield', ask: 'keep it to three bullets' } });
  expect(request.segments).toHaveLength(2);
  expect(request.question).toBeUndefined();
  expect(draft.to).toEqual(['dana@acme.example']);
  expect(draft.moments).toEqual({ s000002: 4 });
  expect(draftText(draft)).toBe('Subject: Security summary\n\nHi Dana,\n\nI will send the security summary by Friday.\n\nThanks & talk soon,');
  expect(mailtoUrl(draft)).toBe('mailto:dana@acme.example?subject=Security%20summary&body=' +
    encodeURIComponent('Hi Dana,\r\n\r\nI will send the security summary by Friday.\r\n\r\nThanks & talk soon,'));
  // Slack has no subject and no To line.
  const slack = await draftFollowUp(root, 'acme-call', 'slack', route, { runner: fakeDraft().runner, engine: rev4 });
  expect(slack.subject).toBeUndefined();
  expect(slack.to).toEqual([]);
});

test('a follow-up from a private meeting, or with an older engine, sends nothing and says why', async () => {
  const { root, add } = library();
  add('private', 'Acme pricing', 5, [you, dana], { private: true });
  add('acme-call', 'Acme discovery call', 6, [you, dana]);
  const humain = fakeDraft();
  await expect(draftFollowUp(root, 'private', 'email', route, { runner: humain.runner, engine: rev4 })).rejects.toThrow(MeetingAiOffError);
  await expect(draftFollowUp(root, 'acme-call', 'email', route, { runner: humain.runner, engine: rev3 }))
    .rejects.toThrow('This AI engine cannot write follow-ups yet. Install a newer AI engine');
  expect(humain.requests).toEqual([]);
});
