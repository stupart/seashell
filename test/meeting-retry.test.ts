import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { retryableRun } from '../src/meeting-enrichment.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function receipt(store: string, runId: string, status: string) {
  mkdirSync(join(store, 'runs', runId), { recursive: true });
  writeFileSync(join(store, 'runs', runId, 'receipt.json'), JSON.stringify({ status }));
}

test('a failed meeting step retries as a new attempt; a finished one is reused', () => {
  const store = mkdtempSync(join(tmpdir(), 'seashell-humain-store-'));
  roots.push(store);
  expect(retryableRun(store, 'meeting-x-reconcile-abc', 'key')).toEqual({ runId: 'meeting-x-reconcile-abc', idempotencyKey: 'key' });
  receipt(store, 'meeting-x-reconcile-abc', 'succeeded');
  expect(retryableRun(store, 'meeting-x-reconcile-abc', 'key').runId).toBe('meeting-x-reconcile-abc');
  // The Oct 1 final notes failed once and could never run again with the same run ID.
  receipt(store, 'meeting-x-reconcile-abc', 'failed');
  expect(retryableRun(store, 'meeting-x-reconcile-abc', 'key')).toEqual({ runId: 'meeting-x-reconcile-abc-r1', idempotencyKey: 'key:retry-1' });
  receipt(store, 'meeting-x-reconcile-abc-r1', 'failed');
  expect(retryableRun(store, 'meeting-x-reconcile-abc', 'key').runId).toBe('meeting-x-reconcile-abc-r2');
});
