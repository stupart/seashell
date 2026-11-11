import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';

const columns = process.argv[2] === 'narrow' ? 56 : 100;
const narrow = columns < 72;
Object.defineProperty(process.stdout, 'columns', { value: columns });
Object.defineProperty(process.stdout, 'rows', { value: 30 });
const client = { ...await import('../../src/humain-client.ts') };
const tests: Array<{ routes: Record<string, unknown>; mode?: string; signal?: AbortSignal }> = [];
let answer: () => void = () => {};
// No engine starts and no prompt is sent: the test's own answer stands in for Humain.
mock.module('../../src/humain-client.ts', () => ({ ...client,
  async discoverHumainProviders() { return { integrations: [{ id: 'claude-code', ready: true, detail: 'Connected' }, { id: 'codex', ready: true, detail: 'Connected' }] }; },
  async discoverHumainModels() { return []; },
  async runHumainMeeting() { throw new Error('A connection test never runs a meeting'); },
  async testMeetingAi(routes: Record<string, unknown>, options: { mode?: string; signal?: AbortSignal }) {
    tests.push({ routes, ...options });
    await new Promise<void>((resolve) => { answer = resolve; options.signal?.addEventListener('abort', () => resolve()); });
    return { ok: false, engine: { ready: true }, routes: [
      { roles: ['observer', 'reconciliation'], backend: 'claude-code', model: 'sonnet', ok: true, latencyMs: 1234 },
      { roles: ['chat'], backend: 'codex', model: 'gpt-5.5', ok: false, failure: { kind: 'not-signed-in', message: '' },
        reason: 'Codex is not signed in. Run codex login, then test again.' },
    ] };
  },
}));
const { default: AISettings } = await import('../../src/AISettings.tsx');
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let rendered = '';
const output = Object.assign(new Writable({ write(chunk, _enc, cb) { rendered += chunk.toString(); cb(); } }), { columns, rows: 30 });
const current = { mode: 'hybrid' as const, routes: {
  observer: { backend: 'claude-code' as const, model: 'sonnet' }, reconciliation: { backend: 'claude-code' as const, model: 'sonnet' },
  chat: { backend: 'codex' as const, model: 'gpt-5.5' } } };
let closed = 0;
const app = render(<AISettings current={current} onSave={() => {}} onClose={() => closed++} />,
  { stdin: input as any, stdout: output as any, stderr: output as any, debug: true, patchConsole: false, exitOnCtrlC: false });
const frame = () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('AI for notes and chat')));
const until = async (check: () => boolean, label: string) => {
  const end = Date.now() + 10_000;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  assert.ok(check(), `${label}\n${frame()}`);
};
const type = async (...keys: string[]) => { for (const key of keys) { input.write(key); await Bun.sleep(60); } };
try {
  // Once AI is chosen there is no "Done" row: the test leads.
  await until(() => frame().includes('› Test connection'), 'a chosen AI can be tested');
  assert.ok(!frame().includes('Done'), frame());
  await type('\r');
  await until(() => frame().includes('Testing…  Esc cancel'), 'the test runs, and says how to stop it');
  assert.equal(tests.length, 1);
  assert.equal(tests[0]!.mode, 'hybrid');
  assert.deepEqual(Object.keys(tests[0]!.routes).sort(), ['chat', 'observer', 'reconciliation']);
  // Esc stops a test without leaving the screen.
  await type('\x1b');
  await until(() => tests[0]!.signal?.aborted === true && !frame().includes('Testing…'), 'Esc stops the test');
  assert.equal(closed, 0);
  await type('\r');
  await until(() => tests.length === 2, 'Enter tests again');
  answer();
  await until(() => frame().includes('✓ 1.2 s'), 'a route that answered says how fast');
  // In columns: each role, the provider people know (not its model id), then how it went.
  const lines = frame().split('\n').map((line) => line.trim());
  assert.ok(lines.includes('Live analysis  Claude Code  ✓ 1.2 s') && lines.includes('Final notes    Claude Code  ✓ 1.2 s'), frame());
  assert.ok(lines.includes('Chat           Codex        ✗'), frame());
  const text = frame().replace(/\s+/gu, ' ');
  assert.ok(!text.includes('sonnet') && !text.includes('gpt-5.5'), text);
  assert.ok(text.includes('Codex is not signed in. Run codex login, then test again.'), text);
  assert.ok(text.includes('Enter test again'), text);
  for (const line of frame().split('\n')) assert.ok(Bun.stringWidth(line) <= columns, `fits ${columns} columns: ${line}`);
  console.log(JSON.stringify({ passed: true }));
} finally { app.unmount(); }
