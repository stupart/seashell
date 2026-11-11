import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  afterMeetingReady,
  automationApprovalsPath,
  createAutomation,
  ensureAutomationsDirectory,
  loadAutomations,
  parseAutomation,
  readAutomationRuns,
  runAutomations,
  runFailure,
  runShellAction,
  updateAutomation,
  type AutomationApprovalRequest,
} from '../src/automations.ts';
import { ensureExtractorsDirectory } from '../src/extractors.ts';
import type { runHumainMeeting } from '../src/humain-client.ts';
import { createMeetingArtifact, loadMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function library() {
  const home = mkdtempSync(join(tmpdir(), 'seashell-automations-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const record = createTranscriptRecord({
    transcript: [{ start: 0, end: 3, speaker: 'LOCAL', text: 'We ship on Friday.' }],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }],
  }, { id: 'weekly-sync', title: 'Weekly sync', now: new Date('2026-10-05T09:00:00Z') });
  saveTranscriptRecord(root, record);
  saveMeetingArtifact(root, { ...createMeetingArtifact(record, { calendar: { provider: 'mac', eventId: 'e', calendar: 'Work', title: 'Weekly sync',
    startAt: '2026-10-05T09:00:00Z', endAt: '2026-10-05T09:30:00Z', attendees: [{ name: 'Dana', email: 'dana@acme.example' }] } }),
  status: 'ready', analysis: { final: true, summary: 'Ship Friday.', runId: 'r', createdAt: '2026-10-05T09:31:00Z',
    claims: [{ id: 'd', type: 'decision', text: 'Ship on Friday.', evidenceSegmentIds: ['s000001'], confidence: 0.9 }] } });
  const env = { SEASHELL_AUTOMATIONS_DIR: join(home, 'Automations'), SEASHELL_EXTRACTORS_DIR: join(home, 'Extractors'),
    SEASHELL_CONFIG: join(home, 'Support', 'config.json') } as NodeJS.ProcessEnv;
  return { home, root, record, env };
}

function automation(env: NodeJS.ProcessEnv, file: string, text: string) {
  mkdirSync(env.SEASHELL_AUTOMATIONS_DIR!, { recursive: true });
  writeFileSync(join(env.SEASHELL_AUTOMATIONS_DIR!, file), text);
}

test('an automation file names its trigger, its filters and its actions', () => {
  const parsed = parseAutomation(`---
name: File customer calls
when: meeting ready
title: [discovery, demo]
calendar: Work
---
<!-- comments are ignored -->
- extract: Customer pains
- write: ~/Documents/Calls
- shell: ./file.sh --today
- webhook: https://hooks.example.com/x
`, '/x/file.md');
  expect(parsed).toMatchObject({ name: 'File customer calls', enabled: true,
    filters: { title: ['discovery', 'demo'], attendee: [], app: [], calendar: ['Work'] },
    actions: [{ kind: 'extract', extractor: 'Customer pains' }, { kind: 'write', target: '~/Documents/Calls' },
      { kind: 'shell', command: './file.sh --today' }, { kind: 'webhook', url: 'https://hooks.example.com/x' }] });
  expect(() => parseAutomation('---\nwhen: daily\n---\n- write: x', '/x/a.md')).toThrow('only trigger');
  expect(() => parseAutomation('---\n---\nsend it somewhere', '/x/a.md')).toThrow('line 1 is not an action');
  expect(() => parseAutomation('---\n---\n- webhook: file:///etc/passwd', '/x/a.md')).toThrow('http or https');
  expect(() => parseAutomation('---\nname: Nothing\n---\n', '/x/a.md')).toThrow('has no actions');
});

test('the example is off; filters must all match; write saves the notes as Markdown', async () => {
  const { home, root, record, env } = library();
  ensureAutomationsDirectory(root, env);
  expect(loadAutomations(root, env).automations.map((item) => [item.name, item.enabled])).toEqual([['Save notes to a folder', false]]);
  expect(await runAutomations(root, record.id, { env })).toEqual([]);
  const folder = join(home, 'Notes');
  automation(env, 'save.md', `---\nname: Save\ncalendar: [work]\nattendee: [acme.example]\n---\n- write: ${folder}\n`);
  automation(env, 'other.md', `---\nname: Other\ncalendar: [work]\napp: [Zoom]\n---\n- write: ${folder}/{id}.md\n`);
  const runs = await runAutomations(root, record.id, { env });
  expect(runs.map((run) => [run.automation, run.status])).toEqual([['Save', 'ok']]);
  const file = join(folder, '2026-10-05 Weekly sync.md');
  expect(runs[0]!.actions).toEqual([{ kind: 'write', target: folder, status: 'ok', detail: file }]);
  const markdown = readFileSync(file, 'utf8');
  expect(markdown).toContain('# Weekly sync');
  expect(markdown).toContain('## Decisions\n- Ship on Friday.  00:00');
  expect(markdown).toContain('## Transcript');
  expect(markdown).not.toContain('Press g');
  // Once per meeting: notes written again do not run it again. The app filter fits when the recorder saw Zoom.
  expect((await runAutomations(root, record.id, { env, app: 'zoom.us' })).map((run) => run.automation)).toEqual(['Other']);
  expect(readAutomationRuns(root).map((run) => run.automation)).toEqual(['Save', 'Other']);
});

test('shell and webhook actions ask first, once per version of the file, and remember the answer', async () => {
  const { root, record, env } = library();
  automation(env, 'send.md', '---\nname: Send\n---\n- shell: ./file.sh\n- webhook: https://hooks.example.com/x\n');
  const asked: AutomationApprovalRequest[] = [];
  const shellRuns: Array<{ command: string; payload: any; env: Record<string, string> }> = [];
  const posts: Array<{ url: string; body: any }> = [];
  const options = (answer: 'allow' | 'deny' | undefined) => ({
    env, trigger: 'manual' as const,
    ask: async (request: AutomationApprovalRequest) => { asked.push(request); return answer; },
    shell: async (command: string, payload: string, variables: Record<string, string>) => {
      shellRuns.push({ command, payload: JSON.parse(payload), env: variables }); return { code: 0 };
    },
    fetch: (async (url: string, init: RequestInit) => { posts.push({ url, body: JSON.parse(String(init.body)) }); return new Response('', { status: 204 }); }) as unknown as typeof fetch,
  });

  // No answer: nothing leaves, and it asks again next time.
  expect((await runAutomations(root, record.id, options(undefined)))[0]!.actions.map((action) => action.status)).toEqual(['skipped', 'skipped']);
  expect(asked).toEqual([{ automation: 'Send', meeting: 'Weekly sync', actions: ['Run: ./file.sh', 'Send to: https://hooks.example.com/x'] }]);
  expect(shellRuns).toEqual([]);

  // Allowed once, it runs from then on without asking.
  await runAutomations(root, record.id, options('allow'));
  await runAutomations(root, record.id, options(undefined));
  expect(asked).toHaveLength(2);
  expect(shellRuns).toHaveLength(2);
  expect(shellRuns[0]!.env).toMatchObject({ SEASHELL_MEETING_ID: record.id });
  expect(shellRuns[0]!.payload).toMatchObject({ id: record.id, title: 'Weekly sync',
    notes: { status: 'final', items: [{ type: 'decision', text: 'Ship on Friday.', evidenceSegmentIds: ['s000001'] }] },
    transcript: [{ id: 's000001', speaker: 'Microphone', text: 'We ship on Friday.' }] });
  expect(posts.map((post) => post.url)).toEqual(['https://hooks.example.com/x', 'https://hooks.example.com/x']);
  expect(JSON.parse(readFileSync(automationApprovalsPath(env), 'utf8')).approvals).toHaveProperty(loadAutomations(root, env).automations[0]!.hash);

  // Any edit to the file asks again; a "no" is remembered and nothing is sent.
  updateAutomation(root, 'Send', { actions: [{ kind: 'shell', command: './other.sh' }] }, env);
  await runAutomations(root, record.id, options('deny'));
  await runAutomations(root, record.id, options('allow'));
  expect(asked).toHaveLength(3);
  expect(shellRuns.map((run) => run.command)).toEqual(['./file.sh', './file.sh']);
  expect(readAutomationRuns(root).at(-1)!.actions[0]!.detail).toContain('chose not to allow');
});

test('a private meeting runs no automation, and the skip is logged', async () => {
  const { root, record, env } = library();
  automation(env, 'save.md', '---\nname: Save\n---\n- shell: ./file.sh\n');
  saveMeetingArtifact(root, { ...loadMeetingArtifact(root, record.id)!, ai: { off: true } });
  let asked = 0;
  const runs = await runAutomations(root, record.id, { env, ask: async () => { asked++; return 'allow'; } });
  expect(runs.map((run) => [run.status, run.detail])).toEqual([['skipped', 'This meeting is private.']]);
  expect(asked).toBe(0);
  expect(readAutomationRuns(root)).toHaveLength(1);
});

test('when a meeting is ready: its app is remembered, fitting extractors run, then automations', async () => {
  const { root, record, env } = library();
  writeFileSync(join(ensureExtractorsDirectory(root, env), 'customer-pains.md'), '---\nname: Asks\nwhen:\n  app: [zoom]\nfields:\n  Asks: Requests\n---\n');
  automation(env, 'zoom.md', '---\nname: Zoom calls\napp: [zoom]\n---\n- extract: Asks\n');
  const actions: string[] = [];
  const runner: typeof runHumainMeeting = async (action, request) => {
    actions.push(action);
    return { runId: `r${actions.length}`, compiledRunId: 'c', status: 'succeeded', receipt: {}, output: { summary: 'S',
      fields: (request as { extractor: { fields: Array<{ name: string }> } }).extractor.fields.map((field) => ({ name: field.name, items: [] })) } };
  };
  const result = await afterMeetingReady(root, record.id, { app: 'zoom.us', route: { backend: 'codex', model: 'fixture' }, runner, env });
  expect(result.extracted).toEqual(['Asks']);
  expect(result.automations.map((run) => [run.automation, run.status])).toEqual([['Zoom calls', 'ok']]);
  expect(actions).toEqual(['extract', 'extract']);
  expect(loadMeetingArtifact(root, record.id)!.app).toBe('zoom.us');
  // Without an AI route, extract actions say what is missing instead of failing silently.
  const later = await runAutomations(root, record.id, { env, trigger: 'manual' });
  expect(later[0]!.actions[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('seashell ai setup') });
});

test('a shell action gets the meeting JSON on stdin and its exit code decides the result', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'seashell-shell-'));
  roots.push(scratch);
  const out = join(scratch, 'got.json');
  expect(await runShellAction(`cat > ${JSON.stringify(out)}`, '{"id":"x"}', { SEASHELL_MEETING_ID: 'x' }, scratch)).toEqual({ code: 0 });
  expect(readFileSync(out, 'utf8')).toBe('{"id":"x"}');
  expect(await runShellAction('echo nope >&2; exit 3', '{}', {}, scratch)).toEqual({ code: 3, detail: 'nope' });
  expect(existsSync(out)).toBeTrue();
});

test('automations can be created as files', () => {
  const { root, env } = library();
  const created = createAutomation(root, { name: 'Post it', filters: { title: ['demo'] }, actions: [{ kind: 'webhook', url: 'https://hooks.example.com/y' }] }, env);
  expect(readFileSync(created.path, 'utf8')).toBe('---\nname: Post it\nwhen: meeting ready\ntitle: [demo]\n---\n- webhook: https://hooks.example.com/y\n');
});

test('a failed run says why in plain words, and whether trying again could help', () => {
  const run = (automation: string, detail: string, kind: 'webhook' | 'shell' = 'webhook') => ({ at: '', automation, hash: 'h', meetingId: 'm',
    trigger: 'meeting-ready' as const, status: 'failed' as const,
    actions: [{ kind, target: kind === 'webhook' ? 'https://crm.example.com/hooks' : 'exit 1', status: 'failed' as const, detail }] });
  expect(runFailure(run('Post to the CRM', 'the server failed (502)'))).toEqual({ text: "The CRM didn't answer.", retry: true });
  expect(runFailure(run('Archive', 'The operation timed out.'))).toEqual({ text: "The server at crm.example.com didn't answer.", retry: true });
  expect(runFailure(run('Post to the CRM', 'the server refused it (403)'))).toEqual({ text: 'The CRM refused it (403).', retry: false });
  expect(runFailure(run('Script', 'exit 1', 'shell'))).toEqual({ text: 'exit 1', retry: false });
});
