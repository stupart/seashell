import { expect, test } from 'bun:test';
import { createMeetingArtifact } from '../src/meeting-artifact.ts';
import { META, meetingViewLines, plainMeetingLines, SUBHEADING, whosWhoNames } from '../src/meeting-tui.ts';
import { wrappedMeetingRows } from '../src/transcript-viewport.ts';
import { stripVTControlCharacters } from 'util';
import { readFileSync } from 'fs';
import { createTranscriptRecord } from '../src/transcript-record.ts';

test('meeting views stay concise and show only relevant artifact layers', () => {
  const record = createTranscriptRecord({ transcript: [], speakers: [] }, {
    id: 'meeting-1',
    title: 'Planning',
  });
  const artifact = createMeetingArtifact(record);
  artifact.analysis = {
    final: true,
    summary: 'The team picked the launch date.',
    runId: 'run-1',
    createdAt: new Date().toISOString(),
    claims: [{
      id: 'decision-1',
      type: 'decision',
      text: 'Launch Friday.',
      evidenceSegmentIds: ['s1'],
      confidence: 0.9,
    }],
  };
  expect(meetingViewLines(artifact, 'notes')[0]).toBe('The team picked the launch date.');
  expect(meetingViewLines(artifact, 'notes')).toContain('- Launch Friday.');
  expect(meetingViewLines(artifact, 'chat')[0]).toContain('Ask about this meeting');
});

test('meeting answers and claims expose the exact cited passage, without unrelated or stale text', () => {
  const record = createTranscriptRecord({ transcript: [
    { id: 's1', start: 5, end: 7, text: 'We agreed to release' },
    { id: 's2', start: 7, end: 9, text: 'on Monday.' },
    { id: 's3', start: 20, end: 22, text: 'Unrelated private detail.' },
  ], speakers: [] }, { id: 'cited-meeting' });
  const artifact = createMeetingArtifact(record);
  artifact.chat = [{ id: 'a1', role: 'assistant', text: 'Monday.',
    evidenceSegmentIds: ['s2', 's1'], createdAt: new Date().toISOString() }];
  const chat = meetingViewLines(artifact, 'chat', record).join('\n');
  expect(chat).toContain('Source 0:05–0:09: “We agreed to release on Monday.”');
  expect(chat).not.toContain('Unrelated');
  artifact.provisionalClaims = [{ id: 'd1', type: 'decision', text: 'Release Monday.',
    evidenceSegmentIds: ['s1', 's2'], confidence: 0.9 }];
  // Notes point at the moment rather than repeating the quote.
  expect(meetingViewLines(artifact, 'notes', record)).toContain(`- Release Monday.${META}${META}00:05`);
  artifact.chat[0]!.evidenceSegmentIds = ['missing'];
  expect(meetingViewLines(artifact, 'chat', record).join('\n')).toContain('cited passages are unavailable');
  artifact.chat[0]!.evidenceSegmentIds = ['s1'];
  record.transcript[0]!.text = 'Changed source must not masquerade as old evidence.';
  const stale = meetingViewLines(artifact, 'chat', record).join('\n');
  expect(stale).toContain('Source text changed');
  expect(stale).not.toContain('masquerade');
});

test('notes keep every decision and action, and drop only what a template section already says', () => {
  const record = createTranscriptRecord({ transcript: [{ id: 's1', start: 5, end: 7, text: 'We settled it.' }], speakers: [] }, { id: 'kept' });
  const artifact = createMeetingArtifact(record);
  const claim = (id: string, type: 'decision' | 'action_item', text: string) => ({ id, type, text, evidenceSegmentIds: ['s000001'], confidence: 0.9 });
  artifact.analysis = {
    final: true, summary: 'Settled.', runId: 'r', createdAt: new Date().toISOString(),
    claims: [
      claim('a', 'decision', 'Ship on Friday.'),
      claim('b', 'action_item', 'Send the security summary.'),
      claim('c', 'action_item', 'Book the kickoff room.'),
      { ...claim('d', 'action_item', 'Dana reviews the security summary by Friday.'), evidenceSegmentIds: ['s000002'] },
    ],
    notes: [{ heading: 'Next steps', items: [{ text: 'You send the security summary by Friday.', evidenceSegmentIds: ['s000001'] }] }],
  };
  const lines = meetingViewLines(artifact, 'notes');
  // Citing the same passage as a note is not repeating it.
  expect(lines).toContain('- Ship on Friday.');
  expect(lines).toContain('- Book the kickoff room.');
  // Nor is using the same words about a different moment.
  expect(lines).toContain('- Dana reviews the security summary by Friday.');
  expect(lines).not.toContain('- Send the security summary.');
  // The template's next steps join the actions: one heading, before what was decided.
  expect(lines).not.toContain('# Next steps');
  expect(lines.slice(lines.indexOf('# Actions'), lines.indexOf('# Decisions'))).toEqual(['# Actions',
    '- You send the security summary by Friday.', '- Book the kickoff room.', '- Dana reviews the security summary by Friday.', '']);
});

test('actions lead in the order they were said, follow-ups among them, then decisions, open questions and risks', () => {
  const record = createTranscriptRecord({ transcript: [10, 20, 30, 40, 50].map((start) => ({ start, end: start + 5, text: `Line at ${start}.` })),
    speakers: [] }, { id: 'ordered' });
  const artifact = createMeetingArtifact(record);
  const claim = (id: string, type: string, text: string, segment: number) =>
    ({ id, type, text, evidenceSegmentIds: [`s00000${segment}`], confidence: 0.9 }) as never;
  artifact.analysis = {
    final: true, summary: 'Ordered.', runId: 'r', createdAt: new Date().toISOString(),
    claims: [claim('r', 'risk', 'Legal may block it.', 2), claim('q', 'open_question', 'Which region?', 3),
      claim('d', 'decision', 'Pilot in November.', 4), claim('a', 'action_item', 'Draft the plan.', 9), claim('f', 'follow_up', 'Hand onboarding over.', 5)],
    notes: [{ heading: 'Where they stand', items: [{ text: 'Pricing works.', evidenceSegmentIds: ['s000001'] }] },
      { heading: 'Next steps', items: [{ text: 'Book the kickoff.', evidenceSegmentIds: ['s000001'] }] }],
  };
  const headings = meetingViewLines(artifact, 'notes', record).filter((line) => line.startsWith('# '));
  expect(headings).toEqual(['# Actions', '# Decisions', '# Open questions', '# Risks', '# Where they stand']);
  const lines = meetingViewLines(artifact, 'notes', record);
  // A line Seashell cannot place in the transcript keeps its place at the end.
  expect(plainMeetingLines(lines.slice(lines.indexOf('# Actions') + 1, lines.indexOf('# Decisions') - 1)))
    .toEqual(['- Book the kickoff.  00:10', '- Hand onboarding over.  00:50', '- Draft the plan.']);
});

test("a template's wording of an action keeps the action's owner and due date", () => {
  const record = createTranscriptRecord({ transcript: [{ start: 35, end: 40, text: 'I will send the security summary by Friday.' }], speakers: [] }, { id: 'owned' });
  const artifact = createMeetingArtifact(record);
  artifact.analysis = {
    final: true, summary: 'Settled.', runId: 'r', createdAt: new Date().toISOString(),
    claims: [{ id: 'a', type: 'action_item', text: 'Send the security summary.', person: 'You', due: 'Fri', evidenceSegmentIds: ['s000001'], confidence: 0.9 }],
    notes: [{ heading: 'Next steps', items: [{ text: 'Send the security summary.', evidenceSegmentIds: ['s000001'] }] }],
  };
  const lines = meetingViewLines(artifact, 'notes', record);
  expect(lines).toContain(`- Send the security summary.${META}You · Fri${META}00:35`);
  expect(lines).toContain('# Actions');
  expect(lines).not.toContain('# Next steps');
  // On screen the owner and time sit against the right edge, only the time dim; copied, they follow the line.
  const wide = wrappedMeetingRows(lines, 70);
  expect(wide.map((row) => stripVTControlCharacters(row))).toContain(`- Send the security summary.${' '.repeat(70 - 28 - 16)}You · Fri  00:35`);
  expect(wide.find((row) => row.includes('security'))).toContain(`You · Fri  ${'\x1b[2m'}00:35`);
  expect(plainMeetingLines(lines)).toContain('- Send the security summary.  You · Fri  00:35');
  // Narrow, the same layout: the text, then the owner, then the time.
  const narrow = wrappedMeetingRows(lines, 54).map((row) => stripVTControlCharacters(row));
  expect(narrow).toContain(`- Send the security summary.${' '.repeat(54 - 28 - 16)}You · Fri  00:35`);
});

test('a long bullet wraps under itself, keeps its owner and time on its first row, and strands no word', () => {
  const lines = [`- Hand onboarding to the support team after two weeks.${META}You${META}01:10`,
    `- Kickoff the week of the tenth.${META}${META}01:17`, `- Not placed.${META}You · Fri${META}`];
  const rows = wrappedMeetingRows(lines, 54).map((row) => stripVTControlCharacters(row));
  expect(rows).toEqual([
    `- Hand onboarding to the support team${' '.repeat(54 - 37 - 10)}You  01:10`,
    '  after two weeks.',
    `- Kickoff the week of the tenth.${' '.repeat(54 - 32 - 5)}01:17`,
    // Without a time, the owner still ends where the others do.
    `- Not placed.${' '.repeat(54 - 13 - 16)}You · Fri`,
  ]);
  // Too narrow for a column beside the text: owner and time go on the row under it, indented.
  const narrow = wrappedMeetingRows(lines.slice(0, 1), 34).map((row) => stripVTControlCharacters(row));
  expect(narrow).toEqual(['- Hand onboarding to the support', '  team after two weeks.', '  You  01:10']);
  expect(narrow.some((row) => /^\s*\S+$/u.test(row) && !row.includes(':'))).toBe(false);
});

test('insights name each extractor once, label their fields, and leave out what the notes already say', () => {
  const record = createTranscriptRecord({ transcript: [
    { start: 7, end: 9, text: 'The per-seat price works.' },
    { start: 14, end: 16, text: 'Legal needs it in writing.' },
  ], speakers: [] }, { id: 'insightful' });
  const artifact = createMeetingArtifact(record);
  artifact.analysis = { final: true, summary: 'Priced.', runId: 'r', createdAt: new Date().toISOString(), claims: [],
    notes: [{ heading: 'Where they stand', items: [{ text: 'Per-seat pricing works for them.', evidenceSegmentIds: ['s000001'] }] }] };
  artifact.insights = [{ extractor: 'Customer pains', createdAt: new Date().toISOString(), runId: 'i', fields: [
    { name: 'Pains', items: [{ text: 'Legal needs it in writing.', evidenceSegmentIds: ['s000002'] }] },
    { name: 'Budget', items: [{ text: 'The per-seat pricing works for them.', evidenceSegmentIds: ['s000001'] }] },
  ] }];
  const lines = meetingViewLines(artifact, 'notes', record);
  // The only field left needs no label of its own.
  expect(lines.slice(lines.indexOf('# Insights'))).toEqual(['# Insights', `${SUBHEADING}Customer pains`, `- Legal needs it in writing.${META}${META}00:14`]);
});

test('a template line never hides a different action, nor lends it the wrong owner', () => {
  const record = createTranscriptRecord({ transcript: [
    { start: 12, end: 18, text: 'Sam, send the contract to Globex by Monday, and I will send the signed contract to Acme.' }], speakers: [] }, { id: 'contracts' });
  const artifact = createMeetingArtifact(record);
  const action = (id: string, text: string, person: string, due?: string) =>
    ({ id, type: 'action_item' as const, text, person, ...(due ? { due } : {}), evidenceSegmentIds: ['s000001'], confidence: 0.9 });
  artifact.analysis = { final: true, summary: 'Contracts.', runId: 'r', createdAt: new Date().toISOString(),
    claims: [action('g', 'Send the contract to Globex.', 'Sam', 'Monday'), action('a', 'Send the contract to Acme.', 'You')],
    notes: [{ heading: 'Next steps', items: [{ text: 'Send the contract to Acme.', evidenceSegmentIds: ['s000001'] }] }] };
  const actions = (lines: string[]) => plainMeetingLines(lines.slice(lines.indexOf('# Actions') + 1));
  // "the" and "to" are not what makes two actions the same: Globex stays, with Sam's owner and date.
  expect(actions(meetingViewLines(artifact, 'notes', record))).toEqual([
    '- Send the contract to Acme.  You  00:12', '- Send the contract to Globex.  Sam · Monday  00:12']);

  // A line that matches two actions stands in for neither, and takes no owner.
  artifact.analysis.notes = [{ heading: 'Next steps', items: [{ text: 'Send the signed contract.', evidenceSegmentIds: ['s000001'] }] }];
  artifact.analysis.claims = [action('g', 'Send the signed contract to Globex.', 'Sam', 'Monday'), action('a', 'Send the signed contract to Acme.', 'You')];
  expect(actions(meetingViewLines(artifact, 'notes', record))).toEqual([
    '- Send the signed contract.  00:12', '- Send the signed contract to Globex.  Sam · Monday  00:12',
    '- Send the signed contract to Acme.  You  00:12']);
});

test('an insight that says more than a line of the notes is not left out as a repeat', () => {
  const record = createTranscriptRecord({ transcript: [{ start: 7, end: 12, text: 'Budget is the main question for Acme; it is tight.' }], speakers: [] }, { id: 'budget' });
  const artifact = createMeetingArtifact(record);
  artifact.analysis = { final: true, summary: 'Budget.', runId: 'r', createdAt: new Date().toISOString(), claims: [],
    notes: [{ heading: 'Where they stand', items: [{ text: 'The budget for Acme is the main question.', evidenceSegmentIds: ['s000001'] }] }] };
  artifact.insights = [{ extractor: 'Customer pains', createdAt: new Date().toISOString(), runId: 'i', fields: [
    { name: 'Budget', items: [{ text: 'Acme budget is tight.', evidenceSegmentIds: ['s000001'] }] }] }];
  const lines = meetingViewLines(artifact, 'notes', record);
  expect(lines.slice(lines.indexOf('# Insights'))).toEqual(['# Insights', `${SUBHEADING}Customer pains`, `- Acme budget is tight.${META}${META}00:07`]);
});

test('the AI\'s loose points are "Also said" and who is who is "Who\'s who": "Notes" names only the tab', () => {
  const record = createTranscriptRecord({ transcript: [], speakers: [] }, { id: 'headings', title: 'Planning' });
  const artifact = createMeetingArtifact(record);
  artifact.analysis = { final: true, summary: 'S', runId: 'r', createdAt: new Date().toISOString(), claims: [
    { id: 'n1', type: 'note', text: 'Admin controls are on by default.', evidenceSegmentIds: ['s1'], confidence: 0.7 },
    { id: 'p1', type: 'speaker_identity', text: 'Speaker 2 is Priya from Acme.', evidenceSegmentIds: ['s2'], confidence: 0.7 },
  ] };
  const lines = meetingViewLines(artifact, 'notes');
  expect(lines).toContain('# Also said');
  expect(lines).toContain("# Who's who");
  expect(lines).not.toContain('# Notes');
});

test('Who\'s who names the speakers who have no name yet, only when it is unambiguous', () => {
  const speakers = [
    { id: 'LOCAL', label: 'Microphone' },
    { id: 'REMOTE_00', label: 'Remote speaker 1' },
    { id: 'REMOTE_01', label: 'Remote speaker 2' },
    { id: 'REMOTE_02', label: 'Priya', suggestion: { source: 'voice', previous: 'Remote speaker 3', similarity: 0.8 } },
  ];
  const who = (text: string, extra: object = {}) => ({ type: 'speaker_identity' as const, text, ...extra });
  expect([...whosWhoNames([
    who('Speaker 1 is Dana Whitfield, their head of operations.'),
    who('Remote speaker 2 is probably Sam, who joined late.'),
    // Not about anyone still unnamed, or no name in it.
    who('Speaker 3 is Priya, who runs IT at Acme.'),
    who('You are the account lead.'),
    { type: 'note' as const, text: 'Speaker 1 is Dana.' },
  ], speakers)]).toEqual([['REMOTE_00', 'Dana Whitfield'], ['REMOTE_01', 'Sam']]);
  // A claim that says whom it is about is read as that.
  expect(whosWhoNames([who('Runs IT at Acme.', { speakerId: 'REMOTE_01', person: 'Alex Kim' })], speakers).get('REMOTE_01')).toBe('Alex Kim');
  // A role is not a name.
  expect(whosWhoNames([who('Speaker 1 is the host.'), who('Speaker 2 is IT at Acme.')], speakers).size).toBe(0);
  // Two names for one speaker, one name for two, or a name someone already has: nothing is suggested.
  expect(whosWhoNames([who('Speaker 1 is Dana.'), who('Speaker 1 is Sam.')], speakers).size).toBe(0);
  expect(whosWhoNames([who('Speaker 1 is Dana.'), who('Speaker 2 is Dana.')], speakers).size).toBe(0);
  expect(whosWhoNames([who('Speaker 1 is Priya.')], speakers).size).toBe(0);
});

/** The made-up Acme kickoff from the rc35 acceptance run, as the real AI wrote its notes with the Customer call template. */
function acmeKickoff() {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/acme-kickoff-notes.json', import.meta.url), 'utf8'));
  const record = createTranscriptRecord({ transcript: fixture.transcript, speakers: fixture.speakers }, { id: '20261103T150000-acmekick', title: 'Acme pilot kickoff' });
  const artifact = createMeetingArtifact(record);
  artifact.analysis = { final: true, summary: fixture.summary, runId: 'r', createdAt: '2026-11-03T21:00:00Z',
    template: fixture.template, claims: fixture.claims, notes: fixture.notes };
  artifact.ownerNotes = fixture.ownerNotes.map((note: object) => ({ ...note, addedAt: '2026-11-03T20:40:00Z' }));
  return { record, artifact, lines: meetingViewLines(artifact, 'notes', record) };
}
const section = (lines: string[], heading: string) => {
  const start = lines.indexOf(`# ${heading}`);
  const end = lines.indexOf('', start);
  return plainMeetingLines(lines.slice(start + 1, end === -1 ? undefined : end));
};

test("an action the template's next steps say again is one row: the one that says who and by when, ✎ if either came from your notes", () => {
  const { lines, artifact } = acmeKickoff();
  expect(section(lines, 'Actions')).toEqual([
    // The template said "Us: send … by Friday, November 6"; the AI's action has the date in its column, and your note.
    '- Send the completed security questionnaire to Marcus.  by this Friday, November 6  ✎ 01:24',
    '- Put together the list of pilot users and share it.  Dana Whitfield · by Monday  01:48',
    // The template's line names an owner the AI's action left out, so the line is kept.
    '- Us: check with engineering on the Salesforce integration.  03:12',
    '- Ask legal whether a separate data processing agreement is needed for the pilot.  03:48',
    '- Set up and run a training session of about 30 minutes for the support team.  the week of the 17th  04:00',
    '- Us: create an admin account on the Seashell dashboard for Marcus.  04:36',
    // "Next week, same time" says when; "Send the invite for the weekly sync" does not.
    '- Weekly sync next week, same time. We send the invite.  05:00',
    '- Confirm the IT approval timeline once the security questionnaire comes in.  Marcus Okafor  05:24',
    "- Owner's note: Ask Dana whether Acme's Berlin office should join the pilot later.  ✎",
  ]);
  // Every action the AI found is there, once, in its words or the template's.
  const actions = artifact.analysis!.claims.filter((claim) => claim.type === 'action_item' || claim.type === 'follow_up');
  expect(actions).toHaveLength(8);
  expect(section(lines, 'Actions')).toHaveLength(9);
});

test('decisions and open questions always show what the notes found, and a template line may say one again where it fits', () => {
  const { lines } = acmeKickoff();
  expect(section(lines, 'Decisions')).toEqual([
    '- The pilot starts on November 17 with the twenty support people.  01:00',
    '- Meet again next week at the same time for a weekly progress sync.  05:00',
  ]);
  expect(section(lines, 'Open questions')).toEqual([
    '- Is the Salesforce integration in scope for the pilot? Left open for now.  03:00',
    '- Is a separate data processing agreement needed for the pilot? Nobody on the call could answer.  03:36',
  ]);
  // The template's own headings still say them in context.
  expect(section(lines, 'Budget, timeline and decision')[0]).toBe('- Pilot starts November 17 with the twenty support people (agreed).  01:00');
  expect(section(lines, 'Concerns')).toContain('- Not yet known if the Salesforce integration is in scope. Left open for now.  03:00');
});

test('a line and an action with a different owner or due date are two points, however alike', () => {
  const record = createTranscriptRecord({ transcript: [{ start: 12, end: 18, text: 'Dana sends the list by Monday; Marcus checks it.' }], speakers: [] }, { id: 'owners' });
  const artifact = createMeetingArtifact(record);
  const action = (person: string, due: string) => ({ id: person, type: 'action_item' as const, text: 'Send the pilot user list.', person, due,
    evidenceSegmentIds: ['s000001'], confidence: 0.9 });
  const notes = (text: string) => [{ heading: 'Next steps', items: [{ text, evidenceSegmentIds: ['s000001'] }] }];
  artifact.analysis = { final: true, summary: 'Lists.', runId: 'r', createdAt: new Date().toISOString(),
    claims: [action('Dana Whitfield', 'by Monday')], notes: notes('Marcus: send the pilot user list.') };
  expect(section(meetingViewLines(artifact, 'notes', record), 'Actions')).toEqual([
    '- Marcus: send the pilot user list.  00:12', '- Send the pilot user list.  Dana Whitfield · by Monday  00:12']);
  artifact.analysis.notes = notes('Dana: send the pilot user list by Wednesday.');
  expect(section(meetingViewLines(artifact, 'notes', record), 'Actions')).toHaveLength(2);
  // The same owner, in fewer words, and the same day: one point.
  artifact.analysis.notes = notes('Dana: send the pilot user list by Monday.');
  expect(section(meetingViewLines(artifact, 'notes', record), 'Actions')).toEqual(['- Send the pilot user list.  Dana Whitfield · by Monday  00:12']);
});
