import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { PassThrough } from 'stream';
import { createMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { handleMeetingsMcpMessage, MEETINGS_MCP_INSTRUCTIONS, runMeetingsMcpServer, type MeetingsMcpDependencies } from '../src/meetings-mcp.ts';
import { installMeetingsMcp } from '../src/mcp-install.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { findTranscriptRecord, saveTranscriptRecord } from '../src/transcript-library.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function library() {
  const root = mkdtempSync(join(tmpdir(), 'seashell-mcp-'));
  roots.push(root);
  const record = createTranscriptRecord({
    transcript: [
      { start: 1, end: 4, text: 'We will ship the pricing page on Friday.', speaker: 'LOCAL' },
      { start: 65, end: 70, text: 'Dana owns the launch email.', speaker: 'REMOTE_SPEAKER_00' },
    ],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' }],
  }, { id: 'weekly-sync', now: new Date('2026-10-01T00:00:00Z'), title: 'Weekly sync',
    source: { filename: 'Live capture session', duration: 120 } });
  saveTranscriptRecord(root, record);
  saveMeetingArtifact(root, { ...createMeetingArtifact(record), analysis: {
    final: true, summary: 'Pricing page ships Friday.', runId: 'r', createdAt: '2026-10-01T00:05:00Z',
    claims: [
      { id: 'c1', type: 'decision', text: 'Ship the pricing page on Friday.', evidenceSegmentIds: ['s000001'], confidence: 0.9 },
      { id: 'c2', type: 'action_item', text: 'Write the launch email.', person: 'Dana', evidenceSegmentIds: ['s000002'], confidence: 0.8 },
    ] } });
  saveTranscriptRecord(root, createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'Unrelated memo.' }], speakers: [] },
    { id: 'memo', now: new Date('2026-09-01T00:00:00Z'), title: 'Voice memo' }));
  return root;
}
const call = async (root: string, name: string, args: object, deps: MeetingsMcpDependencies = {}) => {
  const response = await handleMeetingsMcpMessage(root, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 'test', deps) as any;
  return { error: response.result.isError === true, value: response.result.isError ? response.result.content[0].text : JSON.parse(response.result.content[0].text) };
};

test('agents can find a meeting, read its cited notes and page its transcript', async () => {
  const root = library();
  expect((await call(root, 'list_meetings', {})).value.meetings.map((m: any) => [m.id, m.notes])).toEqual([['weekly-sync', 'final'], ['memo', 'none']]);
  expect((await call(root, 'list_meetings', { query: 'pricing friday' })).value.meetings.map((m: any) => m.id)).toEqual(['weekly-sync']);
  expect((await call(root, 'list_meetings', { from: '2026-09-15' })).value.meetings.map((m: any) => m.id)).toEqual(['weekly-sync']);
  const meeting = (await call(root, 'get_meeting', { id: 'weekly-sync' })).value;
  expect(meeting.notes.summary).toBe('Pricing page ships Friday.');
  expect(meeting.notes.items[1]).toEqual({ type: 'action_item', text: 'Write the launch email.', person: 'Dana', evidence: ['s000002 01:05'] });
  const page = (await call(root, 'get_transcript', { id: 'weekly-sync', limit: 1 })).value;
  expect(page.segments[0]).toMatchObject({ id: 's000001', at: '00:01', speaker: 'Microphone' });
  expect(page.nextOffset).toBe(1);
  expect((await call(root, 'get_transcript', { id: 'weekly-sync', speaker: 'remote' })).value.segments.map((s: any) => s.text)).toEqual(['Dana owns the launch email.']);
  expect((await call(root, 'search_transcripts', { query: 'LAUNCH email' })).value.matches[0]).toMatchObject({ meetingId: 'weekly-sync', segmentId: 's000002', speaker: 'Remote speaker 1' });
  expect((await call(root, 'list_action_items', { since: '2026-09-15' })).value.items).toEqual([
    { meetingId: 'weekly-sync', title: 'Weekly sync', startedAt: '2026-10-01T00:00:00.000Z', text: 'Write the launch email.', person: 'Dana', evidence: ['s000002'], final: true }]);
  // Bad input is a readable tool error the agent can correct, not a protocol failure.
  expect(await call(root, 'get_meeting', { id: 'nope' })).toEqual({ error: true, value: 'Transcript not found: nope' });
  expect((await call(root, 'list_meetings', { from: 'last week' })).error).toBe(true);
});

test('the stdio server negotiates a protocol version and answers only requests', async () => {
  const root = library();
  const input = new PassThrough(); const output = new PassThrough();
  const lines: any[] = [];
  output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter(Boolean).map((line) => JSON.parse(line))));
  const done = runMeetingsMcpServer(root, '9.9.9', input, output);
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { jsonrpc: '2.0', id: 4, method: 'resources/list' },
  ]) input.write(`${JSON.stringify(message)}\n`);
  input.write('not json\n');
  input.end();
  await done;
  expect(lines.map((line) => line.id)).toEqual([1, 2, 3, 4, null]);
  expect(lines[0].result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'seashell', version: '9.9.9' } });
  expect(lines[0].result.instructions).toContain('never invent meeting IDs');
  expect(lines[1].result.protocolVersion).toBe('2026-07-28');
  expect(lines[2].result.tools.every((tool: any) => typeof tool.annotations.readOnlyHint === 'boolean' && !('run' in tool))).toBe(true);
  expect(lines[3].error.code).toBe(-32601);
  expect(lines[4].error.code).toBe(-32700);
});

test('install registers with each agent once and keeps the skill current', () => {
  const home = mkdtempSync(join(tmpdir(), 'seashell-mcp-home-'));
  roots.push(home);
  for (const dir of ['.claude', '.codex']) Bun.spawnSync(['mkdir', '-p', join(home, dir)]);
  const registered = new Set<string>();
  const calls: string[] = [];
  const runner = ((binary: string, args: string[]) => {
    calls.push([binary, ...args].join(' '));
    if (args[1] === 'get') return { status: registered.has(binary) ? 0 : 1, stdout: '', stderr: '' };
    registered.add(binary);
    return { status: 0, stdout: '', stderr: '' };
  }) as any;
  const which = (command: string) => command === 'seashell' ? '/opt/homebrew/bin/seashell' : `/usr/local/bin/${command}`;
  const first = installMeetingsMcp({ runner, which, home });
  expect(first.command).toEqual(['/opt/homebrew/bin/seashell', 'mcp']);
  expect(first.clients.map((client) => client.status)).toEqual(['installed', 'installed']);
  expect(calls).toContain('/usr/local/bin/claude mcp add --scope user seashell -- /opt/homebrew/bin/seashell mcp');
  expect(calls).toContain('/usr/local/bin/codex mcp add seashell -- /opt/homebrew/bin/seashell mcp');
  for (const path of first.skills) expect(readFileSync(path, 'utf8')).toContain('name: seashell-meetings');
  expect(installMeetingsMcp({ runner, which, home }).clients.map((client) => client.status)).toEqual(['already-installed', 'already-installed']);
  const missing = installMeetingsMcp({ runner, which: (command) => command === 'seashell' ? null : null, home });
  expect(missing.clients.map((client) => client.status)).toEqual(['not-found', 'not-found']);
  expect(existsSync(join(home, '.claude', 'skills', 'seashell-meetings', 'SKILL.md'))).toBe(true);
});

/** A library in its own scratch folder, with every editable folder inside it. */
function brainLibrary() {
  const home = mkdtempSync(join(tmpdir(), 'seashell-mcp-brain-'));
  roots.push(home);
  const root = join(home, 'Transcripts');
  mkdirSync(root);
  const record = createTranscriptRecord({
    transcript: [
      { start: 1, end: 4, text: 'We will ship the pricing page on Fryday.', speaker: 'LOCAL' },
      { start: 65, end: 70, text: 'Dana owns the launch email.', speaker: 'REMOTE_SPEAKER_00' },
    ],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }, { id: 'REMOTE_SPEAKER_00', label: 'Remote speaker 1' }],
  }, { id: 'weekly-sync', now: new Date('2026-10-01T00:00:00Z'), title: 'Weekly sync' });
  saveTranscriptRecord(root, record);
  saveMeetingArtifact(root, { ...createMeetingArtifact(record), status: 'ready', analysis: {
    final: true, summary: 'Remote speaker 1 writes the email.', runId: 'r', createdAt: '2026-10-01T00:05:00Z', claims: [
      { id: 'c1', type: 'decision', text: 'Ship the pricing page on Friday.', evidenceSegmentIds: ['s000001'], confidence: 0.9 },
      { id: 'c2', type: 'action_item', text: 'Write the launch email.', person: 'Dana', due: 'Thursday', evidenceSegmentIds: ['s000002'], confidence: 0.8 },
    ] } });
  const secret = createTranscriptRecord({ transcript: [{ start: 0, end: 2, text: 'Confidential.' }], speakers: [] },
    { id: 'hr-chat', now: new Date('2026-10-02T00:00:00Z'), title: 'HR chat' });
  saveTranscriptRecord(root, secret);
  saveMeetingArtifact(root, { ...createMeetingArtifact(secret), ai: { off: true } });
  const env = {
    SEASHELL_PROMPTS_DIR: join(home, 'Prompts'), SEASHELL_TEMPLATES_DIR: join(home, 'Templates'),
    SEASHELL_EXTRACTORS_DIR: join(home, 'Extractors'), SEASHELL_AUTOMATIONS_DIR: join(home, 'Automations'),
    SEASHELL_CONFIG: join(home, 'Support', 'config.json'),
  } as NodeJS.ProcessEnv;
  return { home, root, env, directory: dirname(findTranscriptRecord(root, record.id).path) };
}

test('write tools say so in their annotations, and the server no longer calls itself read-only', async () => {
  const tools = (await handleMeetingsMcpMessage('/nonexistent', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'test') as any).result.tools;
  const byName = new Map(tools.map((tool: any) => [tool.name, tool.annotations]));
  for (const name of ['list_meetings', 'get_meeting', 'get_transcript', 'search_transcripts', 'list_action_items', 'query_notes', 'get_insights',
    'get_video_moment', 'list_extractors', 'list_automations', 'list_prompts', 'list_templates']) {
    expect(byName.get(name)).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  }
  for (const name of ['create_extractor', 'update_extractor', 'delete_extractor', 'run_extractor', 'create_automation', 'update_automation',
    'delete_automation', 'update_prompt', 'update_template', 'edit_segment', 'rename_speaker']) {
    expect((byName.get(name) as any).readOnlyHint).toBe(false);
  }
  for (const name of ['delete_extractor', 'delete_automation', 'update_prompt', 'update_template', 'update_extractor', 'update_automation',
    'create_automation']) {
    expect((byName.get(name) as any).destructiveHint).toBe(true);
  }
  // An automation, once its owner turns it on, can replace files and send meetings outside.
  for (const name of ['create_automation', 'update_automation']) expect((byName.get(name) as any).openWorldHint).toBe(true);
  // A corrected line is kept in history, so editing is not destructive; an extractor talks to the AI provider.
  expect((byName.get('edit_segment') as any).destructiveHint).toBe(false);
  expect((byName.get('run_extractor') as any).openWorldHint).toBe(true);
  expect(MEETINGS_MCP_INSTRUCTIONS).not.toContain('read-only');
});

test('agents query notes, read insights and find a moment in the video', async () => {
  const { root, env, directory } = brainLibrary();
  const deps = { env };
  expect((await call(root, 'query_notes', { kind: 'actions', person: 'dana' }, deps)).value.items).toEqual([{
    meetingId: 'weekly-sync', title: 'Weekly sync', startedAt: '2026-10-01T00:00:00.000Z', type: 'action_item', text: 'Write the launch email.',
    person: 'Dana', due: 'Thursday', evidence: ['s000002 01:05'], quote: 'Dana owns the launch email.', final: true }]);
  expect((await call(root, 'get_insights', { id: 'weekly-sync' }, deps)).value.insights).toEqual([]);

  // No video.json: no video, and no error.
  expect((await call(root, 'get_video_moment', { id: 'weekly-sync', segmentId: 's000002' }, deps)).value.video).toBeNull();
  writeFileSync(join(directory, 'screen.mov'), 'not really a movie');
  writeFileSync(join(directory, 'video.json'), JSON.stringify({ file: join(directory, 'screen.mov'), startOffsetSeconds: -5 }));
  expect((await call(root, 'get_video_moment', { id: 'weekly-sync', segmentId: 's000002' }, deps)).value.video)
    .toEqual({ file: join(directory, 'screen.mov'), offsetSeconds: 60, at: '01:00' });
  // The video started 5 s into the transcript, so a moment that ended before then is not in it.
  expect((await call(root, 'get_video_moment', { id: 'weekly-sync', segmentId: 's000001' }, deps)).value.video).toBeNull();
  expect((await call(root, 'get_video_moment', { id: 'weekly-sync', segmentId: 's000404' }, deps)).value).toContain('not in this meeting');
});

test('agents add, change, run and delete extractors; runs go through the configured route only', async () => {
  const { root, env } = brainLibrary();
  const sent: any[] = [];
  const runner = (async (action: string, request: any) => {
    sent.push({ action, request });
    return { runId: 'run-x', compiledRunId: 'c', status: 'succeeded', receipt: {}, output: { summary: 'One owner.',
      fields: [{ name: 'Owners', items: [{ text: 'Dana writes the email.', evidenceSegmentIds: ['s000002'] }] }] } };
  }) as any;
  const deps: MeetingsMcpDependencies = { env, runner, route: () => ({ backend: 'codex', model: 'fixture' }) };
  const created = await call(root, 'create_extractor', { name: 'Owners', fields: [{ name: 'Owners', description: 'Who owns what' }], when: 'always' }, deps);
  expect(created.value).toMatchObject({ name: 'Owners', when: { kind: 'always' } });
  expect((await call(root, 'update_extractor', { extractor: 'Owners', prompt: 'Names as said.' }, deps)).value.prompt).toBe('Names as said.');
  // The first one made the folder, with its example beside it.
  expect((await call(root, 'list_extractors', {}, deps)).value.extractors.map((extractor: any) => extractor.name)).toEqual(['Customer pains', 'Owners']);

  const ran = await call(root, 'run_extractor', { id: 'weekly-sync', extractor: 'Owners' }, deps);
  expect(sent.map((item) => [item.action, item.request.extractor.name, item.request.model])).toEqual([['extract', 'Owners', 'fixture']]);
  expect(ran.value.insights[0]).toEqual({ extractor: 'Owners', createdAt: expect.any(String), summary: 'One owner.',
    fields: [{ name: 'Owners', items: [{ text: 'Dana writes the email.', evidence: ['s000002 01:05'] }] }] });
  expect((await call(root, 'get_meeting', { id: 'weekly-sync' }, deps)).value.insights).toEqual(['Owners']);

  expect(await call(root, 'run_extractor', { id: 'weekly-sync', extractor: 'Owners' }, { env })).toEqual({ error: true,
    value: 'Meeting AI is not set up, so extractors cannot run. The user can choose a provider with: seashell ai setup' });
  expect((await call(root, 'delete_extractor', { extractor: 'Owners' }, deps)).value.deleted).toEndWith('owners.md');
  expect((await call(root, 'create_extractor', { name: 'Bad', fields: [] }, deps)).error).toBe(true);
});

test('agents edit prompts, templates and automations as the user\'s files', async () => {
  const { root, env, home } = brainLibrary();
  const deps = { env };
  expect((await call(root, 'list_prompts', {}, deps)).value.prompts.map((prompt: any) => [prompt.name, prompt.state])).toEqual([
    ['live', 'default'], ['notes', 'default'], ['chat', 'default']]);
  expect((await call(root, 'update_prompt', { name: 'notes', text: 'Use British spelling.' }, deps)).value.path).toBe(join(home, 'Prompts', 'notes.md'));
  expect((await call(root, 'list_prompts', {}, deps)).value.prompts[1]).toMatchObject({ state: 'edited', text: 'Use British spelling.\n' });
  expect((await call(root, 'update_prompt', { name: 'summary', text: 'x' }, deps)).error).toBe(true);

  const template = await call(root, 'update_template', { name: 'Board meeting', body: '## Numbers\nRevenue and burn.', match: ['board'] }, deps);
  expect(template.value).toMatchObject({ name: 'Board meeting', match: ['board'], path: join(home, 'Templates', 'board-meeting.md') });
  await call(root, 'update_template', { name: 'About me', body: 'I run a studio.' }, deps);
  const templates = (await call(root, 'list_templates', {}, deps)).value;
  expect(templates.aboutMe).toBe('I run a studio.\n');
  expect(templates.templates.find((item: any) => item.name === 'Board meeting').body).toBe('## Numbers\nRevenue and burn.');

  const automation = await call(root, 'create_automation', { name: 'Post notes', filters: { title: ['sync'] },
    actions: [{ kind: 'webhook', value: 'https://hooks.example.com/z' }] }, deps);
  // An agent's automation is saved off, says who made it, and waits for its owner to turn it on in the file.
  expect(automation.value).toMatchObject({ name: 'Post notes', enabled: false, by: 'agent', actions: [{ kind: 'webhook', url: 'https://hooks.example.com/z' }] });
  expect(readFileSync(automation.value.path, 'utf8')).toContain('enabled: false\nmade-by: agent\n');
  expect(automation.value.hash).toBeUndefined();
  expect((await call(root, 'list_automations', {}, deps)).value.automations[0]).toMatchObject({ name: 'Post notes', approval: 'not asked yet', recentRuns: [] });
  expect(await call(root, 'create_automation', { name: 'On at once', enabled: true, actions: [{ kind: 'write', value: '~/Notes' }] }, deps))
    .toEqual({ error: true, value: expect.stringContaining('Only the user can turn an automation on') });
  // The owner turns it on; any change an agent makes turns it off again.
  writeFileSync(automation.value.path, readFileSync(automation.value.path, 'utf8').replace('enabled: false', 'enabled: true'));
  expect((await call(root, 'list_automations', {}, deps)).value.automations[0].enabled).toBe(true);
  expect((await call(root, 'update_automation', { automation: 'Post notes', filters: { title: ['standup'] } }, deps)).value)
    .toMatchObject({ enabled: false, by: 'agent' });
  expect((await call(root, 'update_automation', { automation: 'Post notes', enabled: true }, deps)).error).toBe(true);
  expect((await call(root, 'create_automation', { name: 'Odd', actions: [{ kind: 'email', value: 'x' }] }, deps)).error).toBe(true);
  expect((await call(root, 'delete_automation', { automation: 'Post notes' }, deps)).value.deleted).toEndWith('post-notes.md');
});

test('agents fix a line and name a speaker without losing the notes; private meetings are refused everywhere', async () => {
  const { root, env } = brainLibrary();
  const deps: MeetingsMcpDependencies = { env, route: () => ({ backend: 'codex', model: 'fixture' }), runner: (async () => { throw new Error('must not run'); }) as any };
  expect((await call(root, 'edit_segment', { id: 'weekly-sync', segmentId: 's000001', text: 'We will ship the pricing page on Friday.' }, deps)).value)
    .toMatchObject({ before: 'We will ship the pricing page on Fryday.', after: 'We will ship the pricing page on Friday.' });
  const meeting = (await call(root, 'get_meeting', { id: 'weekly-sync' }, deps)).value;
  expect(meeting.notes.items).toHaveLength(2);
  expect(meeting.notes.possiblyOutOfDate).toBe('A transcript line was corrected');
  expect((await call(root, 'rename_speaker', { id: 'weekly-sync', speaker: 'Remote speaker 1', name: 'Dana' }, deps)).value)
    .toMatchObject({ speakerId: 'REMOTE_SPEAKER_00', from: 'Remote speaker 1', to: 'Dana' });
  expect((await call(root, 'get_meeting', { id: 'weekly-sync' }, deps)).value.notes.summary).toBe('Dana writes the email.');

  for (const [name, args] of [
    ['edit_segment', { id: 'hr-chat', segmentId: 's000001', text: 'x' }], ['rename_speaker', { id: 'hr-chat', speaker: 'x', name: 'y' }],
    ['run_extractor', { id: 'hr-chat', extractor: 'x' }], ['get_insights', { id: 'hr-chat' }],
    ['get_video_moment', { id: 'hr-chat', segmentId: 's000001' }],
  ] as const) {
    expect(await call(root, name, args, deps)).toEqual({ error: true, value: expect.stringContaining('This meeting is private') });
  }
  expect((await call(root, 'query_notes', {}, deps)).value.items.every((item: any) => item.meetingId !== 'hr-chat')).toBe(true);
  expect(findTranscriptRecord(root, 'hr-chat').record.transcript[0]!.text).toBe('Confidential.');
});

test('a meeting whose settings cannot be read is treated as private, never shared by mistake', async () => {
  const root = library();
  const directory = dirname(findTranscriptRecord(root, 'weekly-sync').path);
  // Half-written, or damaged: it might have said "AI off".
  writeFileSync(join(directory, 'meeting.json'), '{"schemaVersion":1,"ai":{"off":tr');
  expect((await call(root, 'search_transcripts', { query: 'launch email' })).value.matches).toEqual([]);
  expect((await call(root, 'list_meetings', {})).value.meetings[0]).toEqual({ id: 'weekly-sync', title: 'Weekly sync',
    startedAt: '2026-10-01T00:00:00.000Z', private: true });
  expect(await call(root, 'get_transcript', { id: 'weekly-sync' })).toEqual({ error: true, value: expect.stringContaining('This meeting is private') });
  expect((await call(root, 'list_action_items', {})).value.items).toEqual([]);
  writeFileSync(join(directory, 'meeting.json'), 'null');
  expect((await call(root, 'search_transcripts', { query: 'launch email' })).value.matches).toEqual([]);
});
