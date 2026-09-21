import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installHumainPackage, installedHumainCli } from '../src/humain-install.ts';
import { discoverHumainProviders, runHumainMeeting } from '../src/humain-client.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';
import { createMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { enrichMeeting } from '../src/meeting-enrichment.ts';

if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: bun scripts/gym-humain-package.ts <package.tgz> <new-results-directory>');
const root = resolve(process.argv[3]);
const bin = join(root, 'bin');
mkdirSync(bin, { recursive: true, mode: 0o700 });
const node = Bun.which('node');
if (!node) throw new Error('Node is required');
symlinkSync(node, join(bin, 'node'));
let calls = 0;
let invalidEvidence = false;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'fixture' }] });
  assert.equal(url.pathname, '/v1/chat/completions');
  assert.equal(request.headers.get('authorization'), null);
  const body = await request.json() as any;
  calls++;
  const output = body.response_format.json_schema.schema.properties.answer
    ? { answer: 'Monday.', evidenceSegmentIds: ['s000001'] }
    : { summary: 'Ship Monday.', claims: [{ id: 'c1', type: 'decision', text: 'Ship Monday.',
      confidence: 0.9, evidenceSegmentIds: [invalidEvidence ? 'invented' : 's000001'] }] };
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } });
} });
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
Object.assign(env, { PATH: bin, HOME: root, TMPDIR: root, SEASHELL_HUMAIN_DIR: join(root, 'intelligence'),
  HUMAIN_CLI: '', HUMAIN_LOCAL_OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` });
try {
  const installed = await installHumainPackage(resolve(process.argv[2]), env);
  const providers = await discoverHumainProviders(env);
  assert.equal(providers.integrations.find((provider) => provider.id === 'local-openai')?.ready, true);
  const library = join(root, 'library');
  const record = createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'We decided to ship Monday.' }], speakers: [] },
    { id: 'package-gym', now: new Date('2026-09-21T00:00:00Z') });
  saveTranscriptRecord(library, record);
  saveMeetingArtifact(library, createMeetingArtifact(record));
  const runner: typeof runHumainMeeting = (action, input, options) => runHumainMeeting(action, input, { ...options, env });
  const options = { mode: 'post-session' as const, route: { backend: 'local-openai' as const, model: 'fixture' }, runner };
  const first = await enrichMeeting(library, record.id, options);
  const replay = await enrichMeeting(library, record.id, options);
  assert.equal(first.analysis?.runId, replay.analysis?.runId);
  assert.equal(calls, 1);
  const chat = Bun.spawn([process.execPath, new URL('../src/cli.tsx', import.meta.url).pathname,
    'meeting', 'chat', record.id, 'When?', '--backend', 'local-openai', '--model', 'fixture',
    '--library-dir', library, '--json'], { env, stdout: 'pipe', stderr: 'pipe' });
  const [chatCode, chatOutput, chatError] = await Promise.all([
    chat.exited, new Response(chat.stdout).text(), new Response(chat.stderr).text(),
  ]);
  assert.equal(chatCode, 0, chatError);
  assert.ok(JSON.stringify(JSON.parse(chatOutput)).includes('Monday'));
  invalidEvidence = true;
  await assert.rejects(enrichMeeting(library, record.id, { ...options, context: { revision: 2 } }));
  const active = installedHumainCli(env);
  const corrupt = join(root, 'corrupt.tgz'); writeFileSync(corrupt, 'not a package');
  await assert.rejects(installHumainPackage(corrupt, env));
  assert.equal(installedHumainCli(env), active, 'failed installation preserves working selection');
  const report = { passed: true, installed, checks: [
    'fresh package installation', 'provider discovery', 'Seashell -> packaged Humain -> local HTTP model',
    'summary and citations', 'durable replay without a second dispatch', 'meeting chat',
    'invalid citation rejected', 'failed install rollback',
  ], providerCalls: calls };
  writeFileSync(join(root, 'package-gym.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log('PASS: ' + report.checks.join(', '));
} finally { server.stop(true); }
