import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { meetingWatchLogFiles, readMeetingWatchLog } from '../src/launch-at-login.ts';
import { WARNING_REPEAT_MS, WarningRateLimit, watchLogWriter } from '../src/watch-log.ts';

const roots: string[] = [];
const descriptors: number[] = [];
afterEach(() => {
  for (const descriptor of descriptors.splice(0)) closeSync(descriptor);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function logsDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'seashell-watch-log-'));
  roots.push(root);
  return root;
}

const MINUTE = 60_000;

test('the same warning shows at most once per 10 minutes, and alternating warnings count as repeats', () => {
  const limit = new WarningRateLimit();
  const shown: Array<[string, number]> = [];
  // Two messages flipping every 3 seconds for 25 minutes, as Meet checks did.
  for (let at = 0; at < 25 * MINUTE; at += 3_000) {
    const message = (at / 3_000) % 2 === 0 ? 'Browser inspection was incomplete.' : 'Meet is out of view.';
    const repeats = limit.admit(message, at);
    if (repeats !== undefined) shown.push([message, repeats]);
  }
  expect(shown).toEqual([
    ['Browser inspection was incomplete.', 0],
    ['Meet is out of view.', 0],
    ['Browser inspection was incomplete.', 99],
    ['Meet is out of view.', 99],
    ['Browser inspection was incomplete.', 99],
    ['Meet is out of view.', 99],
  ]);
  expect(limit.admit('A different warning', 25 * MINUTE)).toBe(0);
});

test('a warning that stops recurring is forgotten after two windows, with the repeats nobody saw', () => {
  const forgotten: Array<[string, number]> = [];
  const limit = new WarningRateLimit(undefined, (message, repeats) => forgotten.push([message, repeats]));
  expect(limit.admit('Made-up device warning.', 0)).toBe(0);
  for (let at = MINUTE; at <= 3 * MINUTE; at += MINUTE) expect(limit.admit('Made-up device warning.', at)).toBeUndefined();
  // Shown once and never repeated: forgotten after one window, with nothing to say.
  expect(limit.admit('Made-up one-off warning.', 5 * MINUTE)).toBe(0);
  // One window later the repeated warning would still show its count if it came back.
  expect(limit.admit('Another made-up warning.', 15 * MINUTE)).toBe(0);
  expect(forgotten).toEqual([]);
  expect(limit.size).toBe(2);
  // Two windows after it last showed, it is dropped and its three unseen repeats are said.
  expect(limit.admit('A last made-up warning.', 20 * MINUTE)).toBe(0);
  expect(forgotten).toEqual([['Made-up device warning.', 3]]);
  expect(limit.size).toBe(2);
});

test('the warning limit never holds more than 256 messages, however many distinct ones arrive', () => {
  const forgotten: Array<[string, number]> = [];
  const limit = new WarningRateLimit(undefined, (message, repeats) => forgotten.push([message, repeats]));
  // A thousand distinct messages inside one window, each repeated once, as a
  // message carrying a changing number or path would arrive.
  for (let index = 0; index < 1_000; index++) {
    expect(limit.admit(`Made-up chunk ${index} failed.`, index)).toBe(0);
    expect(limit.admit(`Made-up chunk ${index} failed.`, index)).toBeUndefined();
    expect(limit.size).toBeLessThanOrEqual(256);
  }
  // The oldest go first, each with its unseen repeat.
  expect(forgotten).toHaveLength(1_000 - 256);
  expect(forgotten[0]).toEqual(['Made-up chunk 0 failed.', 1]);
  expect(forgotten.at(-1)).toEqual([`Made-up chunk ${1_000 - 257} failed.`, 1]);
  // A message still held keeps its count.
  expect(limit.admit('Made-up chunk 999 failed.', WARNING_REPEAT_MS + 999)).toBe(1);
});

test('the watch log is capped in place and keeps one rotated file, like launchd appending stdout', () => {
  const files = meetingWatchLogFiles({ logsDir: logsDir() });
  // launchd opens StandardOutPath for appending and holds that descriptor.
  const descriptor = openSync(files.path, 'a', 0o600);
  descriptors.push(descriptor);
  const write = watchLogWriter(files, { descriptor, maxBytes: 4_096 });
  const lines = Array.from({ length: 200 }, (_, index) =>
    JSON.stringify({ type: 'meeting.started', at: new Date(index * 1_000).toISOString(), sessionId: `call-${index}`, candidate: { id: `audio:zoom:${index}` } }));
  for (const line of lines) write(line);

  const current = readFileSync(files.path, 'utf8');
  const rotated = readFileSync(files.rotatedPath, 'utf8');
  expect(statSync(files.path).size).toBeLessThan(4_096 + 200);
  expect(statSync(files.rotatedPath).size).toBeLessThan(4_096 + 200);
  expect(current).not.toContain('\0');
  // Every line survives intact; the newest are in the current file, the ones before in the rotated file.
  const kept = `${rotated}${current}`.trimEnd().split('\n');
  expect(kept).toEqual(lines.slice(-kept.length));
  expect(current.trimEnd().split('\n').at(-1)).toBe(lines.at(-1));
  expect(readMeetingWatchLog({ logsDir: dirname(files.path) })).toBe(`${rotated}${current}`);
});

test('output that is not the watch log is never rotated or truncated', () => {
  const directory = logsDir();
  const files = meetingWatchLogFiles({ logsDir: directory });
  writeFileSync(files.path, '');
  const elsewhere = join(directory, 'redirected.jsonl');
  const descriptor = openSync(elsewhere, 'a', 0o600);
  descriptors.push(descriptor);
  const write = watchLogWriter(files, { descriptor, maxBytes: 1_024 });
  for (let index = 0; index < 100; index++) write(JSON.stringify({ type: 'watch.warning', index }));
  expect(readFileSync(elsewhere, 'utf8').trimEnd().split('\n')).toHaveLength(100);
  expect(existsSync(files.rotatedPath)).toBe(false);
});

test('the watch log opened without append mode is left to grow rather than corrupted', () => {
  const files = meetingWatchLogFiles({ logsDir: logsDir() });
  const descriptor = openSync(files.path, 'w', 0o600);
  descriptors.push(descriptor);
  const write = watchLogWriter(files, { descriptor, maxBytes: 1_024 });
  for (let index = 0; index < 100; index++) write(JSON.stringify({ type: 'watch.warning', index }));
  expect(readFileSync(files.path, 'utf8').trimEnd().split('\n')).toHaveLength(100);
  expect(existsSync(files.rotatedPath)).toBe(false);
});

test('a terminal or pipe gets the plain fallback writer', () => {
  const written: string[] = [];
  const write = watchLogWriter(meetingWatchLogFiles({ logsDir: logsDir() }), {
    descriptor: 999_999, fallback: (line) => written.push(line),
  });
  write('{"type":"watch.ready"}');
  expect(written).toEqual(['{"type":"watch.ready"}\n']);
});
