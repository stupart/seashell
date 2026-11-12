import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  createExtractor,
  deleteExtractor,
  ensureExtractorsDirectory,
  extractorMatches,
  loadExtractors,
  parseExtractor,
  runAutomaticExtractors,
  runExtractor,
  updateExtractor,
} from '../src/extractors.ts';
import type { runHumainMeeting } from '../src/humain-client.ts';
import { createMeetingArtifact, loadMeetingArtifact, MeetingAiOffError, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { enrichMeeting } from '../src/meeting-enrichment.ts';
import { getInsights, listActionItems, queryNotes } from '../src/meeting-memory.ts';
import { meetingViewLines } from '../src/meeting-tui.ts';
import { editTranscriptSegment } from '../src/transcript-edits.ts';
import { findTranscriptRecord, saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const route = { backend: 'codex' as const, model: 'fixture' };

function library(title = 'Acme discovery call') {
  const home = mkdtempSync(join(tmpdir(), 'seashell-extractors-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const record = createTranscriptRecord({
    transcript: [
      { start: 0, end: 3, speaker: 'REMOTE_SPEAKER_00', text: 'Onboarding takes us a week.' },
      { start: 3, end: 6, speaker: 'REMOTE_SPEAKER_00', text: 'We use spreadsheets for now.' },
      { start: 6, end: 9, speaker: 'LOCAL', text: 'I will send a proposal.' },
    ],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' }],
  }, { id: 'acme-call', title, now: new Date('2026-10-04T15:00:00Z') });
  saveTranscriptRecord(root, record);
  saveMeetingArtifact(root, { ...createMeetingArtifact(record), status: 'ready', attendees: [{ name: 'Jo', email: 'jo@acme.example' }],
    analysis: { final: true, summary: 'Discovery with Acme.', runId: 'r', createdAt: '2026-10-04T16:00:00Z', claims: [] } });
  const env = { SEASHELL_EXTRACTORS_DIR: join(home, 'Extractors') } as NodeJS.ProcessEnv;
  return { home, root, record, env };
}

const PAINS = `---
name: Customer pains
when: always
fields:
  Pains: What is hard for them today
  Tools: Products they use now
  Budget:
---
<!-- not sent -->
Their words, not our pitch.
`;

/** A fake Humain that answers each requested field in order and records what it was sent. */
function fakeHumain(answers: Record<string, Array<{ text: string; evidenceSegmentIds: string[] }>>) {
  const requests: any[] = [];
  const runner: typeof runHumainMeeting = async (action, request) => {
    requests.push({ action, ...(request as object) });
    const fields = (request as { extractor: { fields: Array<{ name: string }> } }).extractor.fields;
    return { runId: `run-${requests.length}`, compiledRunId: 'c', status: 'succeeded', receipt: {},
      output: { summary: 'They lose a week onboarding.', fields: fields.map((field) => ({ name: field.name, items: answers[field.name] ?? [] })) } };
  };
  return { requests, runner };
}

test('an extractor file names its fields, when it runs and what to look for', () => {
  const parsed = parseExtractor(PAINS, '/x/customer-pains.md');
  expect(parsed).toEqual({ name: 'Customer pains', when: { kind: 'always' }, path: '/x/customer-pains.md', prompt: 'Their words, not our pitch.',
    fields: [{ name: 'Pains', description: 'What is hard for them today' }, { name: 'Tools', description: 'Products they use now' }, { name: 'Budget' }] });
  const matched = parseExtractor('---\nwhen:\n  title: [discovery, demo]\n  app: [Zoom]\nfields:\n  Next steps: What happens next\n---\n', '/x/next.md');
  expect(matched.name).toBe('next');
  expect(matched.when).toEqual({ kind: 'match', title: ['discovery', 'demo'], attendee: [], app: ['Zoom'] });
  expect(parseExtractor('---\nfields:\n  A: a\n---\n', '/x/a.md').when).toEqual({ kind: 'manual' });
  expect(() => parseExtractor('---\nname: Empty\n---\nNo fields here.', '/x/e.md')).toThrow('has no fields');
  expect(() => parseExtractor('---\nwhen: sometimes\nfields:\n  A: a\n---\n', '/x/w.md')).toThrow('when must be');
  expect(() => parseExtractor(`---\nfields:\n${Array.from({ length: 21 }, (_, index) => `  F${index}: x`).join('\n')}\n---\n`, '/x/many.md')).toThrow('the most is 20');
});

test('the folder starts with one example that only runs by hand; a broken file is reported, not fatal', () => {
  const { root, env } = library();
  const directory = ensureExtractorsDirectory(root, env);
  writeFileSync(join(directory, 'broken.md'), '---\nname: Broken\n---\n');
  const { extractors, problems } = loadExtractors(root, env);
  expect(extractors.map((extractor) => [extractor.name, extractor.when.kind])).toEqual([['Customer pains', 'manual']]);
  expect(problems).toEqual([{ path: join(directory, 'broken.md'), message: expect.stringContaining('has no fields') }]);
});

test('running an extractor sends its fields and prompt, and saves cited results to the meeting and insights/', async () => {
  const { root, record, env } = library();
  writeFileSync(join(ensureExtractorsDirectory(root, env), 'customer-pains.md'), PAINS);
  const { requests, runner } = fakeHumain({ Pains: [{ text: 'Onboarding takes a week.', evidenceSegmentIds: ['s000001'] }],
    Tools: [{ text: 'Spreadsheets.', evidenceSegmentIds: ['s000002'] }] });
  const insight = await runExtractor(root, record.id, 'customer pains', { route, runner, env });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ action: 'extract', meetingId: record.id, backend: 'codex', model: 'fixture',
    extractor: { name: 'Customer pains', prompt: 'Their words, not our pitch.',
      fields: [{ name: 'Pains', description: 'What is hard for them today' }, { name: 'Tools', description: 'Products they use now' }, { name: 'Budget' }] } });
  expect(requests[0].segments.map((segment: { id: string }) => segment.id)).toEqual(['s000001', 's000002', 's000003']);
  expect(requests[0].instructions?.template).toBeUndefined();
  expect(insight.fields.map((field) => [field.name, field.items.length])).toEqual([['Pains', 1], ['Tools', 1], ['Budget', 0]]);

  const directory = dirname(findTranscriptRecord(root, record.id).path);
  const saved = JSON.parse(readFileSync(join(directory, 'insights', 'customer-pains.json'), 'utf8'));
  expect(saved).toMatchObject({ schemaVersion: 1, meetingId: record.id, extractor: 'Customer pains', summary: 'They lose a week onboarding.',
    fields: [{ name: 'Pains', items: [{ text: 'Onboarding takes a week.', evidenceSegmentIds: ['s000001'] }] }, { name: 'Tools' }, { name: 'Budget', items: [] }] });
  expect(readFileSync(join(directory, 'insights', 'customer-pains.md'), 'utf8')).toContain('## Budget\n\n- Not covered.');
  const lines = meetingViewLines(loadMeetingArtifact(root, record.id)!, 'notes', record);
  expect(lines.slice(lines.indexOf('# Insights'))).toEqual([
    // "Customer pains" already says what Pains are; Tools keeps its label.
    '# Insights', '## Customer pains', '- Onboarding takes a week.\t\t00:00', '- Tools: Spreadsheets.\t\t00:03']);

  // Running it again replaces its result; deleting the extractor's insight file set stays in sync with meeting.json.
  await runExtractor(root, record.id, 'Customer pains', { route, runner: fakeHumain({}).runner, env });
  expect(loadMeetingArtifact(root, record.id)!.insights).toHaveLength(1);
  expect(meetingViewLines(loadMeetingArtifact(root, record.id)!, 'notes', record)).toContain('Customer pains: nothing found.');
});

test('output that skips a field or cites a line the meeting does not have is refused', async () => {
  const { root, record, env } = library();
  writeFileSync(join(ensureExtractorsDirectory(root, env), 'customer-pains.md'), PAINS);
  const answer = (fields: unknown) => (async () => ({ runId: 'r', compiledRunId: 'c', status: 'succeeded', receipt: {},
    output: { summary: 'S', fields } })) as unknown as typeof runHumainMeeting;
  await expect(runExtractor(root, record.id, 'Customer pains', { route, env, runner: answer([{ name: 'Tools', items: [] }]) }))
    .rejects.toThrow('does not answer "Pains" in order');
  await expect(runExtractor(root, record.id, 'Customer pains', { route, env, runner: answer([
    { name: 'Pains', items: [{ text: 'Invented', evidenceSegmentIds: ['s999999'] }] }, { name: 'Tools', items: [] }, { name: 'Budget', items: [] }]) }))
    .rejects.toThrow('cites missing segment s999999');
  // It reads only the transcript: a point resting on your notes, or on a removed line, cites nothing it was given.
  for (const item of [{ text: 'From a note', evidenceSegmentIds: [], ownerNoteIds: ['n1'] },
    { text: 'From a removed line', evidenceSegmentIds: [], removedEvidenceSegmentIds: ['s000001'] }]) {
    await expect(runExtractor(root, record.id, 'Customer pains', { route, env, runner: answer([
      { name: 'Pains', items: [item] }, { name: 'Tools', items: [] }, { name: 'Budget', items: [] }]) }))
      .rejects.toThrow('has a point that cites no line it was given');
  }
  const older = (async () => { throw new Error('Humain failed: Usage: humain meeting observe|reconcile|chat <request.json>'); }) as unknown as typeof runHumainMeeting;
  await expect(runExtractor(root, record.id, 'Customer pains', { route, env, runner: older })).rejects.toThrow('cannot run extractors yet');
  expect(loadMeetingArtifact(root, record.id)!.insights).toBeUndefined();
});

test('after final notes, only extractors whose "when" fits run, and never for a private meeting', async () => {
  const { root, record, env } = library();
  const directory = ensureExtractorsDirectory(root, env);
  writeFileSync(join(directory, 'customer-pains.md'), PAINS);
  writeFileSync(join(directory, 'by-title.md'), '---\nname: Demo notes\nwhen:\n  title: [demo]\nfields:\n  Asks: Requests\n---\n');
  writeFileSync(join(directory, 'by-attendee.md'), '---\nname: Acme\nwhen:\n  attendee: [acme.example]\nfields:\n  Asks: Requests\n---\n');
  writeFileSync(join(directory, 'by-app.md'), '---\nname: Zoom only\nwhen:\n  app: [zoom]\nfields:\n  Asks: Requests\n---\n');
  const fake = fakeHumain({});
  const result = await runAutomaticExtractors(root, record.id, { route, runner: fake.runner, env });
  expect(result.ran.map((insight) => insight.extractor).sort()).toEqual(['Acme', 'Customer pains']);
  const artifact = loadMeetingArtifact(root, record.id)!;
  const zoom = loadExtractors(root, env).extractors.find((extractor) => extractor.name === 'Zoom only')!;
  expect(extractorMatches(zoom, artifact, record, 'Zoom')).toBeTrue();
  expect(extractorMatches(zoom, { ...artifact, app: 'zoom.us' }, record)).toBeTrue();
  expect(extractorMatches(zoom, artifact, record)).toBeFalse();

  saveMeetingArtifact(root, { ...artifact, ai: { off: true } });
  fake.requests.length = 0;
  expect(await runAutomaticExtractors(root, record.id, { route, runner: fake.runner, env })).toEqual({ ran: [], failed: [] });
  await expect(runExtractor(root, record.id, 'Customer pains', { route, runner: fake.runner, env })).rejects.toBeInstanceOf(MeetingAiOffError);
  expect(fake.requests).toEqual([]);
});

test('extractors can be created, changed and deleted as files', () => {
  const { root, env } = library();
  const created = createExtractor(root, { name: 'Objections', when: { title: ['demo'] },
    fields: [{ name: 'Objection', description: 'What they pushed back on' }], prompt: 'Their words.' }, env);
  expect(readFileSync(created.path, 'utf8')).toBe('---\nname: Objections\nwhen:\n  title: [demo]\nfields:\n  Objection: What they pushed back on\n---\nTheir words.\n');
  expect(() => createExtractor(root, { name: 'objections', fields: { A: 'a' } }, env)).toThrow('already exists');
  const updated = updateExtractor(root, 'Objections', { when: 'always', fields: { Objection: 'Pushback', Answer: 'How we replied' } }, env);
  expect(updated).toMatchObject({ name: 'Objections', when: { kind: 'always' }, prompt: 'Their words.',
    fields: [{ name: 'Objection', description: 'Pushback' }, { name: 'Answer', description: 'How we replied' }] });
  expect(deleteExtractor(root, 'objections', env)).toBe(created.path);
  expect(existsSync(created.path)).toBeFalse();
  expect(() => updateExtractor(root, 'Objections', {}, env)).toThrow('No extractor named "Objections"');
});

test('an insight found on an older transcript is never saved as current', async () => {
  const { root, record, env } = library();
  writeFileSync(join(ensureExtractorsDirectory(root, env), 'customer-pains.md'), PAINS);
  const { runner: answer } = fakeHumain({ Pains: [{ text: 'Onboarding takes a week.', evidenceSegmentIds: ['s000001'] }] });
  // A line is corrected while the extractor is still reading the old one.
  const runner: typeof runHumainMeeting = async (...args) => {
    editTranscriptSegment(root, record.id, 's000001', 'Onboarding takes us a month.');
    return answer(...args);
  };
  await expect(runExtractor(root, record.id, 'Customer pains', { route, runner, env }))
    .rejects.toThrow('The transcript changed while Customer pains ran, so what it found was not saved. Run it again.');
  expect(loadMeetingArtifact(root, record.id)!.insights).toBeUndefined();
});

test('each insight says it may be out of date until it runs again, even after the notes are rewritten', async () => {
  const { root, record, env } = library();
  saveMeetingArtifact(root, { ...loadMeetingArtifact(root, record.id)!, analysis: { final: true, summary: 'Discovery with Acme.', runId: 'r',
    createdAt: '2026-10-04T16:00:00Z', claims: [{ id: 'a', type: 'action_item', text: 'Send a proposal.', person: 'You', evidenceSegmentIds: ['s000003'], confidence: 0.9 }] } });
  writeFileSync(join(ensureExtractorsDirectory(root, env), 'customer-pains.md'), PAINS.replace('when: always', 'when: manual'));
  await runExtractor(root, record.id, 'Customer pains', { route, env,
    runner: fakeHumain({ Pains: [{ text: 'Onboarding takes a week.', evidenceSegmentIds: ['s000001'] }] }).runner });
  editTranscriptSegment(root, record.id, 's000001', 'Onboarding takes us a month.');
  // The notes and the insight are both marked, and agents are told so with each note.
  expect(queryNotes(root, { kind: 'actions' }).items[0]!.possiblyOutOfDate).toBe('A transcript line was corrected');
  expect(listActionItems(root).items[0]!.possiblyOutOfDate).toBe('A transcript line was corrected');

  // Rewriting the notes clears their mark, but not the insight's: a manual extractor did not run.
  await enrichMeeting(root, record.id, { mode: 'post-session', route, instructions: null,
    runner: async () => ({ runId: 'n', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: { summary: 'S', claims: [
      { id: 'b', type: 'action_item', text: 'Send a proposal.', person: 'You', evidenceSegmentIds: ['s000003'], confidence: 0.9 }] } }) });
  const rewritten = loadMeetingArtifact(root, record.id)!;
  expect(rewritten.notesOutdated).toBeUndefined();
  expect(rewritten.insights![0]!.outdated?.reason).toBe('A transcript line was corrected');
  const lines = meetingViewLines(rewritten, 'notes', findTranscriptRecord(root, record.id).record);
  expect(lines).toContain('## Customer pains (may be out of date)');
  expect(lines.some((line) => line.includes('may be out of date. Press g'))).toBeFalse();
  expect(getInsights(root, { id: record.id }).insights[0]!.possiblyOutOfDate).toBe('A transcript line was corrected');
  expect(readFileSync(join(dirname(findTranscriptRecord(root, record.id).path), 'insights', 'customer-pains.md'), 'utf8'))
    .toContain('_A transcript line was corrected after this was found, so it may be out of date._');
  expect(queryNotes(root, { kind: 'actions' }).items.map((item) => [item.text, item.possiblyOutOfDate])).toEqual([['Send a proposal.', undefined]]);

  // Running it again clears its mark.
  await runExtractor(root, record.id, 'Customer pains', { route, env, runner: fakeHumain({}).runner });
  expect(loadMeetingArtifact(root, record.id)!.insights![0]!.outdated).toBeUndefined();
  expect(getInsights(root, { id: record.id }).insights[0]!.possiblyOutOfDate).toBeUndefined();
});

test('insights saved before each kept its own mark take the meeting\'s, when they are older than it', () => {
  const { root, record } = library();
  const directory = dirname(findTranscriptRecord(root, record.id).path);
  const stored = JSON.parse(readFileSync(join(directory, 'meeting.json'), 'utf8'));
  const insight = (extractor: string, createdAt: string) => ({ extractor, createdAt, runId: 'x', fields: [{ name: 'A', items: [] }] });
  writeFileSync(join(directory, 'meeting.json'), JSON.stringify({ ...stored,
    notesOutdated: { at: '2026-10-05T10:00:00.000Z', reason: 'Lines heard in silence were removed' },
    insights: [insight('Before', '2026-10-05T09:00:00.000Z'), insight('After', '2026-10-05T11:00:00.000Z')] }));
  expect(loadMeetingArtifact(root, record.id)!.insights!.map((item) => [item.extractor, item.outdated?.reason])).toEqual([
    ['Before', 'Lines heard in silence were removed'], ['After', undefined]]);
});
