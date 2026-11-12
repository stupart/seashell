import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  briefDue,
  briefKey,
  findBrief,
  makeBrief,
  newestSource,
  NoBriefHistoryError,
  ownerKeys,
  readComingUp,
  readNextMeeting,
  recordBriefAttempt,
  relevantMeetings,
  upcomingForBrief,
  upcomingFromEvent,
  writeNextMeeting,
  type Brief,
  type UpcomingMeeting,
} from '../src/briefs.ts';
import { draftAsk, draftFollowUp, draftText, mailtoUrl } from '../src/drafts.ts';
import { addMeetingNote } from '../src/owner-notes.ts';
import { OlderEngineError, withNewerEngine, type runHumainMeeting } from '../src/humain-client.ts';
import { createMeetingArtifact, MeetingAiOffError, saveMeetingArtifact, type MeetingAttendee } from '../src/meeting-artifact.ts';
import { findTranscriptRecord, saveTranscriptRecord } from '../src/transcript-library.ts';
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
  expect(markdown).toContain('- Send the security summary. _(Acme discovery call, Nov 5, 0:04)_');
  expect(markdown).toContain('(acme-call)');
  expect(findBrief(root, next, env)?.path).toBe(brief.path);
  // Coming up says it is ready at once, before the recorder next looks at the calendar.
  writeNextMeeting(root, { upcoming: next, history: 1 });
  expect(readComingUp(root, new Date(), env)[0]?.brief).toBe(brief.path);
});

test('nothing to read is said plainly, and an older engine is told to update before anything is sent', async () => {
  const { root, env, add } = library();
  await expect(makeBrief(root, upcoming('Lunch', [lee]), { route, runner: fakeBrief().runner, engine: rev4, env })).rejects.toThrow(NoBriefHistoryError);
  add('acme-call', 'Acme discovery call', 5, [you, dana]);
  const humain = fakeBrief();
  await expect(makeBrief(root, upcoming('Acme pilot', [dana]), { route, runner: humain.runner, engine: rev3, env }))
    .rejects.toThrow(new OlderEngineError('This AI engine cannot write briefs yet.'));
  // The command line and agents are told how to install a newer one; the app never shows a command.
  const refused = await makeBrief(root, upcoming('Acme pilot', [dana]), { route, runner: humain.runner, engine: rev3, env }).catch((error) => error);
  expect(refused).toBeInstanceOf(OlderEngineError);
  expect(withNewerEngine(refused)).toBe('This AI engine cannot write briefs yet. Install a newer AI engine: seashell ai install <humain-package.tgz>');
  expect(humain.requests).toEqual([]);
  // An engine that cannot say prints its usage instead: the same plain answer.
  const usage: typeof runHumainMeeting = async () => { throw new Error('Humain failed: Usage: humain meeting observe|reconcile|chat|extract <request.json>'); };
  await expect(makeBrief(root, upcoming('Acme pilot', [dana]), { route, runner: usage, env })).rejects.toThrow('cannot write briefs yet');
});

test('a point citing several meetings is shown at the newest, which supersedes the rest', () => {
  // Newest first, as a brief lists them; the model may cite them in any order.
  const brief: Pick<Brief, 'meetings'> = { meetings: [
    { id: 'sync', title: 'Acme weekly sync', startedAt: '2026-11-10T20:00:00Z', moments: { s000006: 60 } },
    { id: 'kickoff', title: 'Acme pilot kickoff', startedAt: '2026-11-03T20:00:00Z', moments: { s000010: 108 } },
  ] };
  const kickoff = { meetingId: 'kickoff', evidenceSegmentIds: ['s000010'] };
  const sync = { meetingId: 'sync', evidenceSegmentIds: ['s000006'] };
  expect(newestSource(brief, { sources: [kickoff, sync] })).toEqual(sync);
  expect(newestSource(brief, { sources: [sync, kickoff] })).toEqual(sync);
  expect(newestSource(brief, { sources: [kickoff] })).toEqual(kickoff);
  // A meeting the brief does not list never wins over one it does.
  expect(newestSource(brief, { sources: [{ meetingId: 'gone', evidenceSegmentIds: ['s1'] }, kickoff] })).toEqual(kickoff);
  expect(newestSource(brief, { sources: [] })).toBeUndefined();
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
  // Later meetings follow the nearest, soonest first; one that has started long since drops off.
  const later = (title: string, minutes: number) => ({ upcoming: { ...due!, title, startsAt: new Date(now.getTime() + minutes * 60_000).toISOString() }, history: 0 });
  writeNextMeeting(root, { upcoming: due!, history: 2, later: [later('Tomorrow', 20 * 60), later('Long started', -11), later('Tonight', 6 * 60)] }, now.getTime());
  expect(readComingUp(root, now).map((meeting) => meeting.upcoming.title)).toEqual(['Weekly sync', 'Tonight', 'Tomorrow']);
  expect(readNextMeeting(root, now)?.later?.map((meeting) => meeting.upcoming.title)).toEqual(['Tonight', 'Tomorrow']);
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
  expect(draft.names).toEqual(['Dana Whitfield']);
  expect(draft.moments).toEqual({ s000002: 4 });
  // About me gives no name, so a sign-off waiting for one is left off.
  expect(draftText(draft)).toBe('Subject: Security summary\n\nHi Dana,\n\nI will send the security summary by Friday.');
  expect(mailtoUrl(draft)).toBe('mailto:dana@acme.example?subject=Security%20summary&body=' +
    encodeURIComponent('Hi Dana,\r\n\r\nI will send the security summary by Friday.'));
  // Slack has no subject and no To line.
  const slack = await draftFollowUp(root, 'acme-call', 'slack', route, { runner: fakeDraft().runner, engine: rev4 });
  expect(slack.subject).toBeUndefined();
  expect(slack.to).toEqual([]);
});

test('a follow-up reads what you typed about the meeting, and signs off with your name from About me', async () => {
  const { home, root, add } = library();
  add('acme-call', 'Acme discovery call', 5, [you, dana]);
  addMeetingNote(root, 'acme-call', 'Send Priya the admin guide', { at: 6 });
  const humain = fakeDraft();
  const draft = await draftFollowUp(root, 'acme-call', 'email', route, { ask: 'keep it short', runner: humain.runner, engine: rev4 });
  // Humain's draft takes no owner notes of its own, so they travel in the ask.
  expect(humain.requests[0].draft.ask).toBe('keep it short My notes: Send Priya the admin guide');
  expect(humain.requests[0].ownerNotes).toBeUndefined();
  expect(draft.paragraphs.map((paragraph) => paragraph.kind)).toEqual(['greeting', 'body']);
  mkdirSync(join(home, 'Templates'), { recursive: true });
  writeFileSync(join(home, 'Templates', 'About me.md'), "I'm Sam Owner. I run a two-person design studio.\n");
  const signed = await draftFollowUp(root, 'acme-call', 'email', route, { runner: fakeDraft().runner, engine: rev4 });
  expect(signed.paragraphs.at(-1)).toMatchObject({ kind: 'closing', text: 'Thanks & talk soon, Sam' });
  // However much was typed, the ask stays within Humain's limit, whole notes first.
  expect(draftAsk('a'.repeat(1_000), [{ text: 'b'.repeat(900) }, { text: 'c'.repeat(900) }])!.length).toBeLessThanOrEqual(2_000);
  expect(draftAsk(undefined, [{ text: 'one' }, { text: 'two' }])).toBe('My notes: one; two');
  expect(draftAsk('as is', [])).toBe('as is');
});

test('a follow-up from a private meeting, or with an older engine, sends nothing and says why', async () => {
  const { root, add } = library();
  add('private', 'Acme pricing', 5, [you, dana], { private: true });
  add('acme-call', 'Acme discovery call', 6, [you, dana]);
  const humain = fakeDraft();
  await expect(draftFollowUp(root, 'private', 'email', route, { runner: humain.runner, engine: rev4 })).rejects.toThrow(MeetingAiOffError);
  await expect(draftFollowUp(root, 'acme-call', 'email', route, { runner: humain.runner, engine: rev3 }))
    .rejects.toThrow(new OlderEngineError('This AI engine cannot write follow-ups yet.'));
  expect(humain.requests).toEqual([]);
});

/** The folder a made-up meeting was saved in. */
const folderOf = (root: string, id: string) => dirname(findTranscriptRecord(root, id).path);

/** An engine check that, while it runs (it can take 20 seconds), sees the owner turn AI off for a meeting. */
const madePrivateDuringCheck = (root: string, id: string) => async () => {
  const path = join(folderOf(root, id), 'meeting.json');
  writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ai: { off: true } }, null, 2)}\n`);
  return rev4();
};

test('a brief never reads a meeting whose settings cannot be read, and choosing its meetings writes nothing', async () => {
  const { root, env, add } = library();
  add('acme-call', 'Acme discovery call', 5, [you, dana]);
  add('damaged', 'Acme pricing', 6, [you, dana]);
  add('changed', 'Acme legal', 7, [you, dana]);
  // Half-written, or damaged: it might have said AI is off.
  writeFileSync(join(folderOf(root, 'damaged'), 'meeting.json'), '{"schemaVersion":1,"ai":{"off":tr');
  // A transcript changed since its notes: loading it the writing way would rewrite meeting.json.
  const changed = join(folderOf(root, 'changed'), 'transcript.json');
  const record = JSON.parse(readFileSync(changed, 'utf8'));
  writeFileSync(changed, `${JSON.stringify({ ...record, transcript: [...record.transcript, { start: 9, end: 10, speaker: 'LOCAL', text: 'One more thing.' }] }, null, 2)}\n`);
  const meetingJson = join(folderOf(root, 'changed'), 'meeting.json');
  const before = { text: readFileSync(meetingJson, 'utf8'), mtime: statSync(meetingJson).mtimeMs };

  expect(relevantMeetings(root, upcoming('Acme pilot', [dana])).map((meeting) => meeting.id)).toEqual(['acme-call']);
  const humain = fakeBrief();
  await makeBrief(root, upcoming('Acme pilot', [dana]), { route, runner: humain.runner, engine: rev4, env });
  expect(humain.requests[0].meetings.map((meeting: any) => meeting.meetingId)).toEqual(['acme-call']);
  expect(readFileSync(meetingJson, 'utf8')).toBe(before.text);
  expect(statSync(meetingJson).mtimeMs).toBe(before.mtime);
});

test('a meeting made private while the engine is checked is left out of the brief before anything is sent', async () => {
  const { root, env, add } = library();
  add('acme-call', 'Acme discovery call', 5, [you, dana]);
  add('acme-pricing', 'Acme pricing', 6, [you, dana]);
  const humain = fakeBrief();
  await makeBrief(root, upcoming('Acme pilot', [dana]), { route, runner: humain.runner, engine: madePrivateDuringCheck(root, 'acme-pricing'), env });
  expect(humain.requests[0].meetings.map((meeting: any) => meeting.meetingId)).toEqual(['acme-call']);
  // With nothing left to read, nothing is sent at all.
  const none = fakeBrief();
  await expect(makeBrief(root, upcoming('Acme pilot', [dana]), { route, runner: none.runner, engine: madePrivateDuringCheck(root, 'acme-call'), env, now: new Date() }))
    .rejects.toThrow(NoBriefHistoryError);
  expect(none.requests).toEqual([]);
});

test('a follow-up refuses a meeting whose settings cannot be read or that turns private while the engine is checked, and writes nothing', async () => {
  const { root, add } = library();
  add('acme-call', 'Acme discovery call', 5, [you, dana]);
  add('damaged', 'Acme pricing', 6, [you, dana]);
  writeFileSync(join(folderOf(root, 'damaged'), 'meeting.json'), '{"schemaVersion":1,"ai":{"off":tr');
  const humain = fakeDraft();
  await expect(draftFollowUp(root, 'damaged', 'email', route, { runner: humain.runner, engine: rev4 })).rejects.toThrow(MeetingAiOffError);
  // Drafting reads the meeting without writing it, even when its transcript changed since the notes.
  const transcript = join(folderOf(root, 'acme-call'), 'transcript.json');
  const record = JSON.parse(readFileSync(transcript, 'utf8'));
  writeFileSync(transcript, `${JSON.stringify({ ...record, transcript: [...record.transcript, { start: 9, end: 10, speaker: 'LOCAL', text: 'One more thing.' }] }, null, 2)}\n`);
  const meetingJson = join(folderOf(root, 'acme-call'), 'meeting.json');
  const before = readFileSync(meetingJson, 'utf8');
  await draftFollowUp(root, 'acme-call', 'email', route, { runner: humain.runner, engine: rev4 });
  expect(readFileSync(meetingJson, 'utf8')).toBe(before);
  expect(humain.requests).toHaveLength(1);
  await expect(draftFollowUp(root, 'acme-call', 'email', route, { runner: humain.runner, engine: madePrivateDuringCheck(root, 'acme-call') }))
    .rejects.toThrow(MeetingAiOffError);
  expect(humain.requests).toHaveLength(1);
});

test('"brief next" means the meeting the app lists as next: what the recorder published, the calendar only while it says nothing', async () => {
  const { root, env } = library();
  const now = new Date('2026-11-11T22:00:00Z');
  const event = (title: string, hours: number) => ({ provider: 'macos-eventkit' as const, eventId: title, title, attendees: [dana],
    startAt: new Date(now.getTime() + hours * 3_600_000).toISOString(), endAt: new Date(now.getTime() + (hours + 0.5) * 3_600_000).toISOString() });
  let reads = 0;
  const calendar = async () => { reads += 1; return [event('Dentist', 1), event('Acme weekly sync', 3)]; };
  // The recorder lists what the app shows; the calendar is not read again.
  writeNextMeeting(root, { upcoming: upcomingFromEvent(event('Acme weekly sync', 12)), history: 2,
    later: [{ upcoming: upcomingFromEvent(event('Design review', 20)), history: 0 }] }, now.getTime());
  expect((await upcomingForBrief(root, undefined, calendar, now, env))?.title).toBe('Acme weekly sync');
  expect((await upcomingForBrief(root, 'design', calendar, now, env))?.title).toBe('Design review');
  expect(reads).toBe(0);
  // A title the recorder has not listed is looked for on the calendar, a week ahead.
  expect((await upcomingForBrief(root, 'dentist', calendar, now, env))?.title).toBe('Dentist');
  expect(reads).toBe(1);
  // The recorder has said nothing for a while: it is not running, so the calendar answers.
  expect((await upcomingForBrief(root, undefined, calendar, new Date(now.getTime() + 20 * 60_000), env))?.title).toBe('Dentist');
  expect(await upcomingForBrief(root, 'standup', async () => [], now, env)).toBeUndefined();
});
