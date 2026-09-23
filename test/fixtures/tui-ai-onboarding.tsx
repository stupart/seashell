import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTranscriptRecord } from '../../src/transcript-record.ts';
import { saveTranscriptRecord } from '../../src/transcript-library.ts';

const root = mkdtempSync(join(tmpdir(), 'seashell-onboarding-'));
const configPath = join(root, 'config.json');
process.env.SEASHELL_CONFIG = configPath;
process.env.SEASHELL_LIBRARY_DIR = join(root, 'library');
process.env.SEASHELL_DISABLE_LISTENER = '1';
writeFileSync(configPath, '{}');
saveTranscriptRecord(process.env.SEASHELL_LIBRARY_DIR, createTranscriptRecord({
  transcript: [{ start: 0, end: 3, text: 'We agreed on Monday.' }], speakers: [],
}, { id: 'fixture-meeting', title: 'Test meeting' }));
const client = { ...await import('../../src/humain-client.ts') };
let calls = 0;
mock.module('../../src/humain-client.ts', () => ({ ...client,
  async discoverHumainProviders() { return { integrations: [
    { id: 'codex', ready: true, detail: 'Connected' },
    { id: 'claude-code', ready: true, detail: 'Connected' },
    { id: 'local-openai', ready: false, detail: 'No server', nextStep: 'Connect a local server' },
  ] }; },
  async discoverHumainModels() { return ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'].map((id) => ({
    id, name: id, description: '', efforts: ['low', 'medium', 'high'],
  })); },
  async runHumainMeeting() { calls++; throw new Error('Setup must not send a prompt'); },
}));
const columns = process.argv[2] === 'narrow' ? 48 : 100;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 28 });
const { default: App } = await import('../../src/app.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } }), { columns, rows: 28 });
const app = render(<App />, { stdin: input as any, stdout: output as any, stderr: output as any,
  debug: true, patchConsole: false, exitOnCtrlC: false });
const text = () => stripVTControlCharacters(rendered);
const type = async (key: string) => { input.write(key); await Bun.sleep(100); };
const until = async (check: () => boolean) => {
  const end = Date.now() + 3000;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  assert.ok(check(), 'UI condition timed out');
};
try {
  await Bun.sleep(150);
  await type('h'); await type('\x1b[B'); await type('\r'); await type('m');
  const before = readFileSync(configPath, 'utf8');
  await type('a'); await until(() => text().includes('Ready with Codex'));
  assert.equal(readFileSync(configPath, 'utf8'), before);
  await type('\x1b[B'); await type('\x1b[B'); await type('\r');
  await until(() => text().includes('Live analysis (off): Codex / gpt-6-luna'));
  assert.ok(text().includes('Final notes: Codex / gpt-6-astra'));
  await type('\x1b'); // Advanced starts with the proposal and can be abandoned.
  await type('\x1b'); // Cancel must leave the account choice unapplied.
  assert.equal(readFileSync(configPath, 'utf8'), before);
  rendered = '';
  await type('a'); await until(() => text().includes('Ready with Codex'));
  await type('\x1b[B'); await type('\r'); // Change provider.
  await type('\x1b[B'); await type('\x1b[B'); await type('\r'); // Unavailable local.
  assert.ok(text().includes('Connect a local server'));
  assert.equal(readFileSync(configPath, 'utf8'), before);
  await type('\x1b'); await type('\r'); // Back, use the proposed Codex setup.
  await until(() => text().includes('Ask:'));
  const saved = JSON.parse(readFileSync(configPath, 'utf8')).meeting;
  assert.equal(saved.modelSelection, 'automatic');
  assert.equal(saved.routes.observer.model, 'gpt-6-luna');
  assert.equal(saved.routes.reconciliation.model, 'gpt-6-astra');
  assert.equal(saved.routes.chat.model, 'gpt-6-sol');
  assert.equal(saved.mode, 'post-session');
  assert.equal(calls, 0);
  console.log(JSON.stringify({ automatic: true, resumedQuestion: true, noModelCalls: true, cancelledSafely: true }));
} finally { app.unmount(); rmSync(root, { recursive: true, force: true }); }
