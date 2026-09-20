import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runHumainMeeting } from '../src/humain-client.ts';
import { createMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { enrichMeeting } from '../src/meeting-enrichment.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';

// Real Humain CLI, compiler, semantic validation, durable store, and receipt.
// Only the model executable is substituted; this never invokes a paid provider.
const cli = resolve(process.argv[2]!);
const root = resolve(process.argv[3]!);
const bin = join(root, 'bin');
mkdirSync(bin, { recursive: true, mode: 0o700 });
writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}\n', { mode: 0o600 });
const node = Bun.which('node');
if (!node) throw new Error('Node is required for the Humain contract gym');
symlinkSync(node, join(bin, 'node'));
// Preserve Node's real module resolution while giving the CLI an empty project
// cwd, so the sibling checkout's .env/.env.local cannot affect the fixture.
const isolatedDist = join(root, 'engine', 'dist');
mkdirSync(isolatedDist, { recursive: true, mode: 0o700 });
const isolatedCli = join(isolatedDist, 'cli.js');
symlinkSync(cli, isolatedCli);
const calls = join(root, 'provider-calls.jsonl');
writeFileSync(calls, '', { mode: 0o600 });
writeFileSync(join(bin, 'codex'), `#!${node}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-cli gym-fixture');
else if (args[0] === 'login' && args[1] === 'status') console.log('Logged in using ChatGPT');
else if (args[0] === 'exec') {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({model:args[args.indexOf('--model')+1]})+'\\n');
  if (args[args.indexOf('--model')+1] === 'fixture/failure') {
    console.error('Synthetic terminal provider failure'); process.exit(1);
  }
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1], 'utf8'));
  const output = schema.properties.answer
    ? {answer:'The team will ship Friday.', evidenceSegmentIds:['s000001']}
    : {summary:'The team will ship Friday.', claims:[]};
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify(output));
} else { console.error('Unexpected fixture invocation'); process.exit(2); }
`, { mode: 0o700 });

// Isolate executable discovery. The stub's absolute Node shebang avoids a
// fallback to installed Codex, and no ambient API credential is passed onward.
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
Object.assign(env, { PATH: bin, HUMAIN_CLI: isolatedCli, TMPDIR: root });
const count = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length;
const request = { meetingId: 'gym-contract', backend: 'codex', model: 'fixture/success',
  segments: [{ id: 's000001', start: 0, end: 1, text: 'We will ship Friday.' }],
  provisionalClaims: [], idempotencyKey: 'gym-replay' };
const storeDir = join(root, 'replay-store');
const first = await runHumainMeeting('reconcile', request, { env, storeDir, runId: 'first-request' });
const replay = await runHumainMeeting('reconcile', request, { env, storeDir, runId: 'second-request' });
assert.equal(replay.runId, first.runId);
assert.equal(count(), 1, 'A successful replay must not dispatch the model again');

const failedRequest = { ...request, model: 'fixture/failure', idempotencyKey: 'gym-terminal' };
for (let attempt = 0; attempt < 2; attempt++) {
  await assert.rejects(runHumainMeeting('reconcile', failedRequest,
    { env, storeDir, runId: 'terminal-request' }), /Humain failed/);
}
assert.equal(count(), 2, 'A terminal replay must not retry a potentially paid dispatch');

const library = join(root, 'library');
const record = createTranscriptRecord({ transcript: request.segments, speakers: [] },
  { id: 'long.meeting-' + 'a'.repeat(120), now: new Date(1_000) });
saveTranscriptRecord(library, record);
saveMeetingArtifact(library, createMeetingArtifact(record));
const route = { backend: 'codex' as const, model: 'fixture/success' };
const runner: typeof runHumainMeeting = (action, input, options) => runHumainMeeting(action, input, { ...options, env });
const options = { mode: 'post-session' as const, route, runner, context: { revision: 1 } };
const one = await enrichMeeting(library, record.id, options);
const same = await enrichMeeting(library, record.id, options);
assert.equal(one.analysis?.runId, same.analysis?.runId);
assert.equal(count(), 3);
const changed = await enrichMeeting(library, record.id, { ...options, context: { revision: 2 } });
assert.notEqual(one.analysis?.runId, changed.analysis?.runId);
assert.equal(count(), 4);

saveMeetingArtifact(library, createMeetingArtifact(record, { mode: 'streaming' }));
await assert.rejects(enrichMeeting(library, record.id, { mode: 'streaming', runner,
  route: { ...route, model: 'fixture/failure' } }), /Humain failed/);
const observed = await enrichMeeting(library, record.id, { mode: 'streaming', runner, route });
assert.equal(observed.session.cursor, 1);
assert.equal(count(), 6, 'Changing the route must create a distinct observer run');
const chat = await runHumainMeeting('chat', { ...request, question: 'When do we ship?',
  finalClaims: [], idempotencyKey: 'gym-chat' }, { env, storeDir, runId: 'chat-request' });
assert.deepEqual(chat.output, { answer: 'The team will ship Friday.', evidenceSegmentIds: ['s000001'] });
assert.equal(count(), 7);
writeFileSync(join(root, 'contract-results.json'), JSON.stringify({
  provider: 'local fixture executable', realHumainCli: cli,
  successfulReplay: true, terminalReplay: true, longMeetingIdentity: true,
  changedObserverRoute: true, chatEvidence: true, providerCalls: count(),
}, null, 2) + '\n', { mode: 0o600 });
console.log('PASS: real Humain replay, terminal failure, changed meeting identities, observer, and chat (fixture provider)');
