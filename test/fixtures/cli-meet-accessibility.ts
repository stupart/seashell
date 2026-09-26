import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeetingCommand } from '../../src/cli-args.ts';

const root = mkdtempSync(join(tmpdir(), 'seashell-cli-accessibility-'));
process.env.SEASHELL_CONFIG = join(root, 'config.json');
process.env.SEASHELL_LIBRARY_DIR = join(root, 'library');
const initial = { meeting: { speakerBrowser: 'off', mode: 'post-session' } };
writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify(initial));
let permissionRequests = 0, checks = 0, trusted = false, output = '';
const meet = { ...await import('../../src/meet-speakers.ts') };
mock.module('../../src/meet-speakers.ts', () => ({ ...meet,
  async requestMeetAccessibilityPermission() {
    permissionRequests++;
    return { state: 'permission', detail: 'Allow Accessibility, then check again.' };
  },
  async checkMeetConnection(mode: string) {
    checks++;
    assert.equal(mode, 'auto');
    return trusted ? { state: 'connected', detail: 'Meeting connected.', browser: 'chrome',
      snapshot: { meeting: '/abc-defg-hij', joined: true,
        participants: [{ id: 'private-person-id', name: 'Private Name', self: false, speaking: true }] } }
      : { state: 'permission', detail: 'Allow Accessibility, then check again.' };
  },
}));
const { executeCliCommand } = await import('../../src/cli-runtime.ts');
const run = (browser: Extract<MeetingCommand['action'], { kind: 'speakers' }>['browser']) =>
  executeCliCommand({ kind: 'meeting', action: { kind: 'speakers', browser }, json: true });
const readConfig = () => JSON.parse(readFileSync(process.env.SEASHELL_CONFIG!, 'utf8'));
const originalWrite = process.stdout.write;
process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
try {
  assert.equal(await run('check'), 0);
  assert.equal(checks, 0, 'Checking an off integration does not read meeting UI');
  assert.deepEqual(readConfig(), initial, 'Check is read-only');
  assert.equal(await run('auto'), 2);
  assert.equal(checks, 1);
  assert.equal(permissionRequests, 0, 'Selecting auto does not request access');
  assert.equal(readConfig().meeting.speakerBrowser, 'auto');
  const before = readFileSync(process.env.SEASHELL_CONFIG!, 'utf8');
  assert.equal(await run('check'), 2);
  assert.equal(permissionRequests, 0, 'Missing access never turns a check into a prompt');
  assert.equal(readFileSync(process.env.SEASHELL_CONFIG!, 'utf8'), before);
  assert.equal(await run('setup'), 2);
  assert.equal(permissionRequests, 1, 'Explicit setup requests access once');
  assert.equal(checks, 2, 'Setup uses its permission result without probing again');
  assert.equal(readConfig().meeting.mode, 'post-session', 'Setup preserves other preferences');
  trusted = true;
  assert.equal(await run('check'), 0);
  assert.equal(permissionRequests, 1);
  assert.equal(await run('off'), 0);
  assert.equal(checks, 3, 'Turning off does not read meeting UI');
  assert.equal(permissionRequests, 1);
  assert.ok(!output.includes('private-person-id') && !output.includes('Private Name') && !output.includes('/abc-defg-hij'),
    'CLI status does not expose participant IDs, names, or meeting URLs');
} finally {
  process.stdout.write = originalWrite;
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: true }));
