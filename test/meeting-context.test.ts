import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMeetingContext, loadMeetingContextFiles } from '../src/meeting-context.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('loads only explicit bounded context files', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-context-'));
  roots.push(root);
  const path = join(root, 'blueprint.md');
  writeFileSync(path, '# Blueprint\nPrivate project context.\n');
  expect(loadMeetingContextFiles([path])).toEqual([{
    name: 'blueprint.md',
    content: '# Blueprint\nPrivate project context.\n',
  }]);
  expect(buildMeetingContext([path])).toMatchObject({
    calendar: null,
    attendees: [],
    documents: [{ name: 'blueprint.md' }],
  });
});

test('rejects oversized context before an AI route can receive it', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-context-'));
  roots.push(root);
  const path = join(root, 'too-large.txt');
  writeFileSync(path, 'x'.repeat(512 * 1024 + 1));
  expect(() => loadMeetingContextFiles([path])).toThrow('exceeds 512 KiB');
});
