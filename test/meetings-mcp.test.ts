import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { createMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { handleMeetingsMcpMessage, runMeetingsMcpServer } from '../src/meetings-mcp.ts';
import { installMeetingsMcp } from '../src/mcp-install.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';

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
const call = (root: string, name: string, args: object) => {
  const response = handleMeetingsMcpMessage(root, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 'test') as any;
  return { error: response.result.isError === true, value: response.result.isError ? response.result.content[0].text : JSON.parse(response.result.content[0].text) };
};

test('agents can find a meeting, read its cited notes and page its transcript', () => {
  const root = library();
  expect(call(root, 'list_meetings', {}).value.meetings.map((m: any) => [m.id, m.notes])).toEqual([['weekly-sync', 'final'], ['memo', 'none']]);
  expect(call(root, 'list_meetings', { query: 'pricing friday' }).value.meetings.map((m: any) => m.id)).toEqual(['weekly-sync']);
  expect(call(root, 'list_meetings', { from: '2026-09-15' }).value.meetings.map((m: any) => m.id)).toEqual(['weekly-sync']);
  const meeting = call(root, 'get_meeting', { id: 'weekly-sync' }).value;
  expect(meeting.notes.summary).toBe('Pricing page ships Friday.');
  expect(meeting.notes.items[1]).toEqual({ type: 'action_item', text: 'Write the launch email.', person: 'Dana', evidence: ['s000002 01:05'] });
  const page = call(root, 'get_transcript', { id: 'weekly-sync', limit: 1 }).value;
  expect(page.segments[0]).toMatchObject({ id: 's000001', at: '00:01', speaker: 'Microphone' });
  expect(page.nextOffset).toBe(1);
  expect(call(root, 'get_transcript', { id: 'weekly-sync', speaker: 'remote' }).value.segments.map((s: any) => s.text)).toEqual(['Dana owns the launch email.']);
  expect(call(root, 'search_transcripts', { query: 'LAUNCH email' }).value.matches[0]).toMatchObject({ meetingId: 'weekly-sync', segmentId: 's000002', speaker: 'Remote speaker 1' });
  expect(call(root, 'list_action_items', { since: '2026-09-15' }).value.items).toEqual([
    { meetingId: 'weekly-sync', title: 'Weekly sync', startedAt: '2026-10-01T00:00:00.000Z', text: 'Write the launch email.', person: 'Dana', evidence: ['s000002'], final: true }]);
  // Bad input is a readable tool error the agent can correct, not a protocol failure.
  expect(call(root, 'get_meeting', { id: 'nope' })).toEqual({ error: true, value: 'Transcript not found: nope' });
  expect(call(root, 'list_meetings', { from: 'last week' }).error).toBe(true);
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
  expect(lines[2].result.tools.every((tool: any) => tool.annotations.readOnlyHint && !('run' in tool))).toBe(true);
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
