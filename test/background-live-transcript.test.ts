import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBackgroundLiveTranscript, type BackgroundDraftTranscriber, type BackgroundLiveTranscriptHandle, type BackgroundLiveTranscriptStatus } from '../src/background-live-transcript.ts';
import { CaptureSessionStore, type CommittedCaptureChunk } from '../src/capture-session.ts';
import { createMeetingArtifact, saveMeetingArtifact } from '../src/meeting-artifact.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { findTranscriptRecord, saveTranscriptRecord } from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [], handles: BackgroundLiveTranscriptHandle[] = [];
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map(handle => handle.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seashell-background-draft-')); roots.push(root);
  const record = createTranscriptRecord({ transcript: [], speakers: [] }, {
    id: 'meeting-fixture', title: 'Draft meeting', now: new Date('2026-09-27T00:00:00Z'),
    source: { filename: 'Live capture session', format: 'capture-session/0.1' },
  });
  const saved = saveTranscriptRecord(root, record);
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: record.id, startedAtUnixMs: Date.parse(record.createdAt) });
  let next = 0;
  const chunk = (trackId: 'microphone' | 'system-audio', start = 0, audible = true) => {
    const path = join(root, `incoming-${next++}.wav`);
    writeFileSync(path, pcmS16leToWav(Buffer.alloc(3200, audible ? 4 : 0)));
    return store.commitChunk({ sourcePath: path, trackId, startSeconds: start, endSeconds: start + 10, audible });
  };
  const read = () => findTranscriptRecord(root, record.id).record;
  const worker = (engine: BackgroundDraftTranscriber, extra: Partial<Parameters<typeof startBackgroundLiveTranscript>[0]> = {}) => {
    const handle = startBackgroundLiveTranscript({ libraryDir: root, record, publishIntervalMs: 5,
      dependencies: { createTranscriber: () => engine }, ...extra });
    handles.push(handle); return handle;
  };
  return { root, record, saved, store, chunk, read, worker };
}
async function until(check: () => boolean, message = 'Expected worker state', timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check(), message).toBe(true);
}
const idleStop = async () => {};

test('audible committed chunks publish to the same provisional meeting without touching audio', async () => {
  const f = fixture();
  const chunk = f.chunk('microphone', 4), before = readFileSync(chunk.path);
  const files: string[] = [];
  const worker = f.worker({ transcribe: async path => { files.push(path); return 'We will meet on Tuesday.'; }, stop: idleStop });
  worker.enqueue(chunk);
  await until(() => f.read().transcript.length === 1);
  expect(files).toEqual([chunk.path]);
  expect(f.read()).toMatchObject({ id: f.record.id, createdAt: f.record.createdAt, title: f.record.title,
    transcript: [{ id: `draft-${chunk.id}`, start: 4, end: 14, text: 'We will meet on Tuesday.', speaker: 'LOCAL' }],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }] });
  expect(readFileSync(chunk.path)).toEqual(before);
  expect(worker.status.stage).toBe('live');
});

test('silence never starts local inference and duplicate committed sequences are ignored', async () => {
  const f = fixture();
  let created = 0, calls = 0;
  const worker = f.worker({ transcribe: async () => '', stop: idleStop }, { dependencies: {
    createTranscriber: () => { created++; return { transcribe: async () => { calls++; return 'One sentence.'; }, stop: idleStop }; },
  } });
  worker.enqueue(f.chunk('microphone', 0, false));
  await Bun.sleep(20);
  expect(created).toBe(0);
  const chunk = f.chunk('microphone', 10); worker.enqueue(chunk); worker.enqueue(chunk);
  await until(() => f.read().transcript.length === 1);
  expect(created).toBe(1); expect(calls).toBe(1);
});

test('drafts reconcile microphone echo with remote names and retain native provenance', async () => {
  const f = fixture();
  saveMeetingArtifact(f.root, createMeetingArtifact(f.record));
  let hintCalls = 0;
  const worker = f.worker({ transcribe: async () => 'We should test the recording quality today.', stop: idleStop }, {
    speakerFor: () => { hintCalls++; return { id: 'MEET_alice', label: 'Alice', source: 'google-meet-accessibility' }; },
  });
  worker.enqueue(f.chunk('microphone'));
  await until(() => f.read().transcript.length === 1);
  worker.enqueue(f.chunk('system-audio'));
  await until(() => f.read().transcript[0]?.speaker === 'MEET_alice');
  expect(f.read().transcript).toHaveLength(1);
  expect(f.read().transcript[0]?.speakerSource).toBe('google-meet-accessibility');
  expect(hintCalls).toBe(1);
  expect(existsSync(join(f.saved.directory, 'history', 'meeting-revisions'))).toBe(false);
});

test('pending drafts stay bounded and skipped work reports catching up without losing capture', async () => {
  const f = fixture();
  let release: ((text: string) => void) | undefined;
  const statuses: BackgroundLiveTranscriptStatus[] = [];
  const worker = f.worker({ transcribe: async () => await new Promise<string>(resolve => { release = resolve; }), stop: idleStop },
    { maxPending: 2, onStatus: status => statuses.push(status) });
  const chunks: CommittedCaptureChunk[] = [];
  for (let i = 0; i < 10; i++) { const chunk = f.chunk('system-audio', i * 10); chunks.push(chunk); worker.enqueue(chunk); }
  await until(() => statuses.some(status => status.stage === 'delayed' && status.detail.includes('catching up')));
  expect(Math.max(...statuses.map(status => status.queueDepth))).toBeLessThanOrEqual(3);
  expect(chunks.every(chunk => existsSync(chunk.path))).toBe(true);
  const closed = worker.close();
  release?.('Late draft');
  await closed;
  expect(worker.status.stage).toBe('stopped');
});

test('ASR failure is a visible draft delay and a later chunk can recover', async () => {
  const f = fixture(); let calls = 0;
  const worker = f.worker({ transcribe: async () => {
    if (++calls === 1) throw new Error('Fixture ASR failure'); return 'Recovered live text.';
  }, stop: idleStop });
  const first = f.chunk('microphone'); worker.enqueue(first);
  await until(() => worker.status.stage === 'delayed');
  expect(worker.status.detail).toContain('Audio is saved');
  expect(existsSync(first.path)).toBe(true);
  worker.enqueue(f.chunk('microphone', 10));
  await until(() => f.read().transcript.length === 1);
  expect(worker.status.stage).toBe('live');
});

test('close is a write barrier even if an in-flight transcriber ignores cancellation', async () => {
  const f = fixture(); let release: ((text: string) => void) | undefined, stops = 0;
  const worker = f.worker({ transcribe: async () => await new Promise<string>(resolve => { release = resolve; }),
    stop: async () => { stops++; } });
  worker.enqueue(f.chunk('microphone'));
  await until(() => Boolean(release));
  const closing = worker.close();
  const canonical = { ...f.record, transcript: [{ id: 'final-1', start: 0, end: 10, text: 'Canonical final transcript.' }] };
  saveTranscriptRecord(f.root, canonical);
  await closing;
  release?.('Stale live draft must disappear.');
  worker.enqueue(f.chunk('microphone', 10));
  await Bun.sleep(30);
  expect(f.read()).toEqual(canonical);
  expect(stops).toBeGreaterThanOrEqual(1);
  expect(worker.close()).toBe(closing);
});

test('bounded draft size stops preview growth while leaving complete audio for finalization', async () => {
  const f = fixture(); let calls = 0;
  const worker = f.worker({ transcribe: async () => { calls++; return 'A short sentence.'; }, stop: idleStop }, { maxSegments: 1 });
  worker.enqueue(f.chunk('microphone'));
  await until(() => f.read().transcript.length === 1);
  worker.enqueue(f.chunk('microphone', 10));
  await until(() => worker.status.detail.includes('size limit'));
  worker.enqueue(f.chunk('microphone', 20));
  await Bun.sleep(20);
  expect(calls).toBe(2);
  expect(f.read().transcript).toHaveLength(1);
  expect(f.store.manifest.chunks).toHaveLength(3);
});

test('close flushes pending text once and removes its periodic publish timer', async () => {
  const f = fixture(); let saves = 0;
  const worker = f.worker({ transcribe: async () => 'Pending draft.', stop: idleStop }, { publishIntervalMs: 1000,
    dependencies: { createTranscriber: () => ({ transcribe: async () => 'Pending draft.', stop: idleStop }),
      saveRecord: (...args) => { saves++; return saveTranscriptRecord(...args); } },
  });
  worker.enqueue(f.chunk('system-audio'));
  await until(() => worker.status.stage === 'live');
  expect(saves).toBe(0);
  await worker.close();
  expect(saves).toBe(1); expect(f.read().transcript[0]?.text).toBe('Pending draft.');
  await Bun.sleep(20); expect(saves).toBe(1);
});

test('save failure remains a draft warning, preserves audio, and retries the dirty draft on close', async () => {
  const f = fixture(); let saves = 0;
  const worker = f.worker({ transcribe: async () => 'Save this draft.', stop: idleStop }, { dependencies: {
    createTranscriber: () => ({ transcribe: async () => 'Save this draft.', stop: idleStop }),
    saveRecord: (...args) => { if (++saves === 1) throw new Error('Fixture disk failure'); return saveTranscriptRecord(...args); },
  } });
  const chunk = f.chunk('microphone'); worker.enqueue(chunk);
  await until(() => worker.status.stage === 'delayed');
  expect(worker.status.detail).toContain('could not be saved');
  expect(existsSync(chunk.path)).toBe(true);
  expect(f.read().transcript).toHaveLength(0);
  await worker.close();
  expect(f.read().transcript[0]?.text).toBe('Save this draft.');
  expect(saves).toBe(2);
});
