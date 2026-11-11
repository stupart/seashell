import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { chatWithMeeting, enrichMeeting } from '../src/meeting-enrichment.ts';
import { PROFILE_FILE } from '../src/meeting-templates.ts';
import { ensurePromptsDirectory, listPrompts, loadPrompt, promptsDirectory, resetPrompt, writePrompt } from '../src/prompts.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A library in its own scratch folder, so its Prompts and Templates siblings are private to the test. */
function library() {
  const home = mkdtempSync(join(tmpdir(), 'seashell-prompts-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const record = createTranscriptRecord({ transcript: [
    { start: 0, end: 3, text: 'We agreed on the blue logo.' },
    { start: 3, end: 6, text: 'Kim sends the files tomorrow.' },
    { start: 6, end: 9, text: 'That is all for today.' },
  ], speakers: [] }, { id: 'logo-review', title: 'Logo review', now: new Date('2026-10-03T09:00:00Z') });
  saveTranscriptRecord(root, record);
  saveMeetingArtifact(root, createMeetingArtifact(record, { mode: 'hybrid' }));
  return { home, root, record };
}

test('the folder is written once with live, notes and chat; edits and deletions stay; reset brings one back', () => {
  const { home, root } = library();
  expect(promptsDirectory(root, {})).toBe(join(home, 'Prompts'));
  // Before the folder exists, the defaults as shipped apply.
  expect(existsSync(join(home, 'Prompts'))).toBeFalse();
  expect(loadPrompt(root, 'notes', {})).toContain('Write short, plain bullets');
  const directory = ensurePromptsDirectory(root, {});
  expect(listPrompts(root, {}).map((prompt) => [prompt.name, prompt.role, prompt.state])).toEqual([
    ['live', 'observer', 'default'], ['notes', 'reconciliation', 'default'], ['chat', 'chat', 'default']]);
  // The comment explains the fixed rules and is never sent.
  expect(readFileSync(join(directory, 'notes.md'), 'utf8')).toContain('cite the\ntranscript lines behind every point');
  expect(loadPrompt(root, 'notes', {})).not.toContain('<!--');

  writeFileSync(join(directory, 'notes.md'), 'Use British spelling.\n');
  writeFileSync(join(directory, 'chat.md'), '<!-- nothing for chat -->\n');
  rmSync(join(directory, 'live.md'));
  ensurePromptsDirectory(root, {});
  expect(loadPrompt(root, 'notes', {})).toBe('Use British spelling.');
  expect(loadPrompt(root, 'chat', {})).toBeUndefined();
  expect(loadPrompt(root, 'live', {})).toBeUndefined();
  expect(listPrompts(root, {}).map((prompt) => prompt.state)).toEqual(['empty', 'edited', 'empty']);

  resetPrompt(root, 'Live.md', {});
  expect(loadPrompt(root, 'live', {})).toContain('one short line each');
  expect(() => resetPrompt(root, 'summary', {})).toThrow('No prompt named "summary"');
  writePrompt(root, 'chat', 'Answer in Spanish.', {});
  expect(readFileSync(join(directory, 'chat.md'), 'utf8')).toBe('Answer in Spanish.\n');
});

test('each role gets its own prompt after "About me"; the template and note are unchanged', async () => {
  const { home, root, record } = library();
  const previous = { prompts: process.env.SEASHELL_PROMPTS_DIR, templates: process.env.SEASHELL_TEMPLATES_DIR };
  process.env.SEASHELL_PROMPTS_DIR = join(home, 'Prompts');
  process.env.SEASHELL_TEMPLATES_DIR = join(home, 'Templates');
  try {
    const prompts = ensurePromptsDirectory(root);
    writeFileSync(join(prompts, 'live.md'), 'LIVE: only decisions.');
    writeFileSync(join(prompts, 'notes.md'), 'NOTES: British spelling.');
    writeFileSync(join(prompts, 'chat.md'), 'CHAT: one sentence.');
    mkdirSync(join(home, 'Templates'));
    writeFileSync(join(home, 'Templates', PROFILE_FILE), 'I run a design studio.');
    const requests: Array<{ action: string; instructions?: { profile?: string; template?: unknown } }> = [];
    const runner = async (action: string, request: unknown) => {
      requests.push({ action, ...(request as { instructions?: never }) });
      return { runId: `run-${action}`, compiledRunId: 'c', status: 'succeeded' as const, receipt: {},
        output: action === 'chat' ? { answer: 'Blue.', evidenceSegmentIds: ['s000001'] } : { summary: 'Logo picked.', claims: [] } };
    };
    await enrichMeeting(root, record.id, { mode: 'hybrid', route: { backend: 'codex', model: 'fixture' }, runner });
    await chatWithMeeting(root, record.id, 'Which logo?', { backend: 'codex', model: 'fixture' }, undefined, runner);
    expect(requests.map((request) => [request.action, request.instructions?.profile])).toEqual([
      ['observe', 'I run a design studio.\n\nLIVE: only decisions.'],
      ['reconcile', 'I run a design studio.\n\nNOTES: British spelling.'],
      ['chat', 'I run a design studio.\n\nCHAT: one sentence.'],
    ]);

    // Too much standing guidance for one call is refused before anything is sent.
    writeFileSync(join(prompts, 'notes.md'), 'x'.repeat(16_000));
    requests.length = 0;
    await expect(enrichMeeting(root, record.id, { mode: 'post-session', route: { backend: 'codex', model: 'fixture' }, runner }))
      .rejects.toThrow('the limit is 16,000');
    expect(requests).toEqual([]);
  } finally {
    for (const [key, value] of [['SEASHELL_PROMPTS_DIR', previous.prompts], ['SEASHELL_TEMPLATES_DIR', previous.templates]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
