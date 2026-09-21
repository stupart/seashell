import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { createMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { saveTranscriptRecord } from '../src/transcript-library.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seashell-cli-context-'));
  roots.push(root);
  const library = join(root, 'library');
  const document = join(root, 'approved context.md');
  writeFileSync(document, 'Release means the public beta.');
  const record = createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'Release on Friday.' }], speakers: [] });
  saveTranscriptRecord(library, record);
  const calendar = { provider: 'fixture', eventId: 'event', title: 'Planning',
    startAt: '2026-09-21T00:00:00Z', endAt: '2026-09-21T01:00:00Z', attendees: [{ name: 'Alex' }] };
  saveMeetingArtifact(library, createMeetingArtifact(record, { calendar }));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ libraryDir: library, meeting: {
    backend: 'codex', model: 'fixture/model', contextFiles: [document],
  } }));
  const requestPath = join(root, 'sent-request.json');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const humain = join(bin, 'humain');
  writeFileSync(humain, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'fs';
const args = process.argv.slice(2);
writeFileSync(process.env.FIXTURE_REQUEST, readFileSync(args[2], 'utf8'));
const runId = args[args.indexOf('--run-id') + 1];
console.log(JSON.stringify({ status: 'succeeded', runId, compiledRunId: 'fixture',
  receipt: { status: 'succeeded', runId, compiledRunId: 'fixture' },
  output: { summary: 'Release on Friday.', claims: [] } }));
`, { mode: 0o700 });
  const run = (extra: string[] = []) => Bun.spawnSync([
    process.execPath, 'run', fileURLToPath(new URL('../src/cli.tsx', import.meta.url)),
    'meeting', 'enrich', record.id, '--mode', 'post-session', '--json', ...extra,
  ], { cwd: root, env: { ...process.env, HOME: root, SEASHELL_CONFIG: config,
    SEASHELL_LIBRARY_DIR: library, HUMAIN_CLI: humain, FIXTURE_REQUEST: requestPath } });
  return { root, document, calendar, requestPath, run };
}

test('CLI enrichment includes the configured context files and saved calendar', () => {
  const f = fixture();
  const result = f.run();
  expect(result.stderr.toString()).not.toContain('Error');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(f.requestPath, 'utf8')).context).toEqual({
    calendar: f.calendar, attendees: f.calendar.attendees,
    documents: [{ name: 'approved context.md', content: 'Release means the public beta.' }],
  });
});

test('explicit CLI context replaces configured context without reading its files', () => {
  const f = fixture();
  rmSync(f.document);
  const override = join(f.root, 'override.json');
  writeFileSync(override, JSON.stringify({ agenda: 'Explicit context only' }));
  const result = f.run(['--context', override]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(f.requestPath, 'utf8')).context).toEqual({ agenda: 'Explicit context only' });
});

test('missing approved context stops CLI enrichment before model dispatch', () => {
  const f = fixture();
  rmSync(f.document);
  const result = f.run();
  expect(result.exitCode).toBe(1);
  expect(existsSync(f.requestPath)).toBe(false);
});
