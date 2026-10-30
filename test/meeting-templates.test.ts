import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { parseCliArgs } from '../src/cli-args.ts';
import { createMeetingArtifact, loadMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { enrichMeeting } from '../src/meeting-enrichment.ts';
import {
  ensureTemplatesDirectory,
  findMeetingTemplate,
  loadMeetingTemplates,
  loadProfile,
  meetingInstructions,
  parseMeetingTemplate,
  PROFILE_FILE,
  selectMeetingTemplate,
} from '../src/meeting-templates.ts';
import { meetingViewLines } from '../src/meeting-tui.ts';
import { getMeeting } from '../src/meetings-mcp.ts';
import { findTranscriptRecord, saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A library inside its own scratch folder, so its Templates sibling is private to the test. */
function library(title = 'Acme discovery call') {
  const home = mkdtempSync(join(tmpdir(), 'seashell-templates-test-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const record = createTranscriptRecord({
    transcript: [
      { start: 0, end: 3, speaker: 'speaker-1', text: 'We need onboarding to take a day, not a week.' },
      { start: 3, end: 6, speaker: 'speaker-2', text: 'Budget is ten thousand for the quarter.' },
      { start: 6, end: 9, speaker: 'speaker-1', text: 'I will send the proposal on Friday.' },
    ],
    speakers: [{ id: 'speaker-1', label: 'Microphone' }, { id: 'speaker-2', label: 'Remote speaker 1' }],
  }, { id: 'meeting-1', title, now: new Date('2026-08-10T14:00:00Z') });
  saveTranscriptRecord(root, record);
  return { home, root, record, env: { SEASHELL_TEMPLATES_DIR: join(home, 'Templates') } as NodeJS.ProcessEnv };
}

describe('meeting templates', () => {
  test('frontmatter names, matches and defaults a template; the body is its sections', () => {
    const template = parseMeetingTemplate(`---
name: "Sales call"
match: [discovery, 'demo', kick-off]
default: false
---
<!-- for the editor, not the AI -->
## Pain points
What hurts today.
`, '/x/sales.md')!;
    expect(template).toMatchObject({ name: 'Sales call', match: ['discovery', 'demo', 'kick-off'], default: false });
    expect(template.body).toBe('## Pain points\nWhat hurts today.');
    expect(parseMeetingTemplate('---\nname: Empty\n---\n<!-- nothing yet -->\n', '/x/empty.md')).toBeUndefined();
    expect(parseMeetingTemplate('## Only a body\n', '/x/plain-notes.md')!.name).toBe('plain-notes');
  });

  test('the calendar title picks the template by its most specific whole-word match', () => {
    const templates = loadMeetingTemplates('/nonexistent/Transcripts', { SEASHELL_TEMPLATES_DIR: '/nonexistent/Templates' });
    const pick = (title: string) => selectMeetingTemplate(templates, title)?.name;
    expect(pick('Weekly 1:1 with Sam')).toBe('One-on-one');
    expect(pick('Acme discovery call')).toBe('Customer call');
    expect(pick('Daily standup')).toBe('Standup');
    expect(pick('Q3 roadmap planning')).toBe('Planning');
    expect(pick('Candidate interview: Jo')).toBe('Interview');
    expect(pick('Coffee')).toBe('General');
    expect(pick('Planetary science')).toBe('General');
    expect(findMeetingTemplate(templates, 'customer-call')?.name).toBe('Customer call');
    expect(findMeetingTemplate(templates, 'one-on-one')?.name).toBe('One-on-one');
  });

  test('the folder is seeded once, and an edited or deleted template stays the user\'s', () => {
    const { root, env } = library();
    const directory = ensureTemplatesDirectory(root, env);
    expect(existsSync(join(directory, 'general.md'))).toBeTrue();
    expect(loadProfile(root, env)).toBeUndefined();
    writeFileSync(join(directory, 'general.md'), '---\nname: General\ndefault: true\n---\n## Just this\n');
    rmSync(join(directory, 'interview.md'));
    ensureTemplatesDirectory(root, env);
    expect(readFileSync(join(directory, 'general.md'), 'utf8')).toContain('## Just this');
    expect(existsSync(join(directory, 'interview.md'))).toBeFalse();
    writeFileSync(join(directory, PROFILE_FILE), 'I run a design studio. Keep notes terse.\n');
    expect(loadProfile(root, env)).toBe('I run a design studio. Keep notes terse.');
  });

  test('a meeting\'s own choice wins over its title; "none" turns templated notes off', () => {
    const { root, env } = library('Weekly 1:1');
    expect(meetingInstructions(root, { title: 'Weekly 1:1' }, env).template?.name).toBe('One-on-one');
    expect(meetingInstructions(root, { title: 'Weekly 1:1', template: 'Planning' }, env).template?.name).toBe('Planning');
    expect(meetingInstructions(root, { title: 'Weekly 1:1', template: 'none' }, env).instructions).toBeUndefined();
    expect(meetingInstructions(root, { title: 'x', template: 'none', note: ' Focus on pricing. ' }, env).instructions)
      .toEqual({ note: 'Focus on pricing.' });
    expect(() => meetingInstructions(root, { title: 'x', template: 'Nope' }, env)).toThrow('No template named "Nope"');
  });
});

describe('templated meeting notes', () => {
  test('the owner\'s template, profile and note reach every run, and the notes come back cited', async () => {
    const { root, record, env } = library();
    const directory = ensureTemplatesDirectory(root, env);
    writeFileSync(join(directory, PROFILE_FILE), 'I sell design retainers.');
    const artifact = createMeetingArtifact(record, { mode: 'hybrid' });
    saveMeetingArtifact(root, { ...artifact, ai: { note: 'Capture the budget.' } });
    const requests: Array<{ action: string; instructions?: { profile?: string; note?: string; template?: { name: string; body: string } } }> = [];
    const previous = process.env.SEASHELL_TEMPLATES_DIR;
    process.env.SEASHELL_TEMPLATES_DIR = env.SEASHELL_TEMPLATES_DIR;
    try {
      await enrichMeeting(root, record.id, {
        mode: 'hybrid',
        route: { backend: 'codex', model: 'fixture' },
        runner: async (action, request) => {
          requests.push({ action, ...(request as { instructions?: never }) });
          const notes = action === 'reconcile' ? {
            notes: [
              { heading: 'Goals and pain points', items: [{ text: 'Onboarding should take a day.', evidenceSegmentIds: ['s000001'] }] },
              { heading: 'Budget, timeline and decision', items: [{ text: '$10k for the quarter.', evidenceSegmentIds: ['s000002'] }] },
              { heading: 'Concerns', items: [] },
            ],
          } : {};
          return { runId: `run-${action}`, compiledRunId: 'c', status: 'succeeded', receipt: {}, output: { summary: 'Discovery with Acme.', claims: [], ...notes } };
        },
      });
    } finally {
      if (previous === undefined) delete process.env.SEASHELL_TEMPLATES_DIR;
      else process.env.SEASHELL_TEMPLATES_DIR = previous;
    }
    expect(requests.map((request) => request.action)).toEqual(['observe', 'reconcile']);
    for (const request of requests) {
      expect(request.instructions?.template?.name).toBe('Customer call');
      expect(request.instructions?.template?.body).toContain('## Goals and pain points');
      expect(request.instructions?.profile).toBe('I sell design retainers.');
      expect(request.instructions?.note).toBe('Capture the budget.');
    }
    const saved = loadMeetingArtifact(root, record.id)!;
    expect(saved.analysis?.template).toBe('Customer call');
    expect(saved.analysis?.notes?.[1]).toEqual({ heading: 'Budget, timeline and decision', items: [{ text: '$10k for the quarter.', evidenceSegmentIds: ['s000002'] }] });
    expect(saved.ai).toEqual({ note: 'Capture the budget.' });

    const markdown = readFileSync(join(dirname(findTranscriptRecord(root, record.id).path), 'documents', 'meeting-notes.md'), 'utf8');
    expect(markdown).toContain('## Goals and pain points\n\n- Onboarding should take a day. _(s000001)_');
    expect(markdown).toContain('## Concerns\n\n- Not discussed.');

    const lines = meetingViewLines(saved, 'notes', record);
    expect(lines).toContain('# Budget, timeline and decision');
    expect(lines.some((line) => line.startsWith('- $10k for the quarter.'))).toBe(true);

    const mcp = getMeeting(root, { id: record.id }) as { notes: { template?: string; sections?: Array<{ heading: string; items: Array<{ evidence: string[] }> }> } };
    expect(mcp.notes.template).toBe('Customer call');
    expect(mcp.notes.sections?.[0]?.items[0]?.evidence).toEqual(['s000001 00:00']);
  });

  test('notes that cite a segment the meeting does not have are refused', async () => {
    const { root, record } = library();
    await expect(enrichMeeting(root, record.id, {
      mode: 'post-session',
      route: { backend: 'codex', model: 'fixture' },
      instructions: { template: { name: 'T', body: '## Risks' } },
      runner: async () => ({ runId: 'r', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: {
        summary: 'S', claims: [], notes: [{ heading: 'Risks', items: [{ text: 'Invented', evidenceSegmentIds: ['s999999'] }] }],
      } }),
    })).rejects.toThrow('cite missing segment s999999');
  });

  test('an engine from before templates still produces plain notes', async () => {
    const { root, record } = library();
    const status: string[] = [];
    await enrichMeeting(root, record.id, {
      mode: 'post-session',
      route: { backend: 'codex', model: 'fixture' },
      instructions: { template: { name: 'T', body: '## Risks' } },
      onStatus: (message) => status.push(message),
      runner: async () => ({ runId: 'r', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: { summary: 'S', claims: [] } }),
    });
    const saved = loadMeetingArtifact(root, record.id)!;
    expect(saved.analysis?.summary).toBe('S');
    expect(saved.analysis?.notes).toBeUndefined();
    expect(status.some((message) => message.includes('does not write templated notes yet'))).toBeTrue();
  });
});

test('templates, template and note parse as commands', () => {
  expect(parseCliArgs(['templates'])).toEqual({ kind: 'templates', json: false });
  expect(parseCliArgs(['meeting', 'template', 'meeting-1', 'Customer call'])).toMatchObject({
    kind: 'meeting', action: { kind: 'template', id: 'meeting-1', template: 'Customer call' },
  });
  expect(parseCliArgs(['meeting', 'template', 'meeting-1'])).toMatchObject({ action: { kind: 'template', id: 'meeting-1' } });
  expect(parseCliArgs(['meeting', 'note', 'meeting-1', 'Focus', 'on', 'pricing'])).toMatchObject({
    action: { kind: 'note', id: 'meeting-1', note: 'Focus on pricing' },
  });
  expect(() => parseCliArgs(['meeting', 'template'])).toThrow('Usage: seashell meeting template');
});
