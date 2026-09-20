import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AutomaticMeetingWatchService, type AutomaticMeetingWatchEvent } from '../src/automatic-meeting-watch.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import type { DurableLiveCaptureHandle } from '../src/durable-live-capture.ts';
import { findTranscriptRecord } from '../src/transcript-library.ts';
import { loadMeetingArtifact } from '../src/meeting-artifact.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const failure of ['provider', 'context', 'transcription'] as const) {
  test(`watcher reports the saved meeting after ${failure} failure only when its transcript exists`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-enrichment-fault-'));
    roots.push(root);
    const events: AutomaticMeetingWatchEvent[] = [];
    const service = new AutomaticMeetingWatchService({
      config: { libraryDir: root, meeting: {
        mode: 'post-session',
        routes: { reconciliation: { backend: 'openrouter', model: 'test/notes' } },
        ...(failure === 'context' ? { contextFiles: [join(root, 'missing.txt')] } : {}),
        automation: { enabled: true, mode: 'automatic', confirmationPolls: 2 },
      } },
      onEvent: (value) => events.push(value),
      dependencies: {
        now: () => new Date(1_000),
        readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: 1_000, supported: true,
          inputProcesses: [{ pid: 42, bundleId: 'us.zoom.xos', name: 'Zoom' }] }),
        startCapture: () => {
          const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'enrichment-fault', startedAtUnixMs: 1_000 });
          return { store, sessionId: 'enrichment-fault', manifestPath: store.manifestPath,
            async stop() { return store.setStatus('captured', 'test'); } };
        },
        finalizeCapture: async () => {
          if (failure === 'transcription') throw new Error('ASR unavailable');
          return createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'Saved meeting.' }], speakers: [] },
            { id: 'enrichment-fault', now: new Date(1_000) });
        },
        enrich: async () => { throw new Error('Provider unavailable'); },
      },
    });
    await service.pollOnce();
    await service.pollOnce();
    await service.shutdown();
    if (failure === 'transcription') {
      expect(events.map((value) => value.type)).not.toContain('meeting.ready');
      expect(events.map((value) => value.type)).toContain('watch.error');
    } else {
      expect(events.map((value) => value.type).slice(-2)).toEqual(['watch.warning', 'meeting.ready']);
      expect(events.map((value) => value.type)).not.toContain('watch.error');
      expect(findTranscriptRecord(root, 'enrichment-fault').record.transcript[0]?.text).toBe('Saved meeting.');
      expect(loadMeetingArtifact(root, 'enrichment-fault')?.status).toBe('failed');
      expect(loadMeetingArtifact(root, 'enrichment-fault')?.failure).toContain(
        failure === 'provider' ? 'Provider unavailable' : 'missing.txt',
      );
    }
  });
}

for (const fault of ['detector', 'capture-start'] as const) {
  test(`watcher recovers from ${fault} failure without pretending recording is healthy`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-auto-fault-'));
    roots.push(root);
    let now = 0;
    let broken = false;
    let starts = 0;
    let stops = 0;
    const events: string[] = [];
    const service = new AutomaticMeetingWatchService({
      config: { libraryDir: root, meeting: { automation: {
        enabled: true, mode: 'automatic', confirmationPolls: 2, endGraceSeconds: 1,
      } } },
      onEvent: (event) => events.push(event.type),
      dependencies: {
        now: () => new Date(now),
        readSignals: () => {
          if (broken) throw new Error('detector disconnected');
          return { schemaVersion: 1, capturedAtUnixMs: now, supported: true,
            inputProcesses: [{ pid: 42, bundleId: 'us.zoom.xos', name: 'Zoom' }] };
        },
        startCapture: () => {
          starts += 1;
          if (fault === 'capture-start' && starts === 1) throw new Error('disk unavailable');
          const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'fault-test', startedAtUnixMs: now });
          return { store, sessionId: 'fault-test', manifestPath: store.manifestPath,
            async stop() { stops += 1; return store.setStatus('captured', 'test'); } };
        },
        finalizeCapture: async () => createTranscriptRecord({
          transcript: [{ start: 0, end: 1, text: 'Recoverable meeting.' }], speakers: [],
        }, { id: 'fault-test', now: new Date(1_000) }),
      },
    });
    await service.pollOnce();
    now = 1_000;
    await service.pollOnce();
    if (fault === 'capture-start') {
      expect(service.phase).toBe('watching');
      expect(events).toContain('watch.error');
      await service.pollOnce();
      await service.pollOnce();
      expect(starts).toBe(2);
      expect(service.phase).toBe('recording');
    } else {
      broken = true;
      now = 2_000;
      await service.pollOnce();
      now = 3_001;
      expect((await service.pollOnce()).kind).toBe('finish');
      expect(stops).toBe(1);
    }
    await service.shutdown();
    expect(events).toContain('meeting.ready');
  });
}

test('watcher records only after confirmation and finalizes after grace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-auto-watch-'));
  roots.push(root);
  const times = [0, 1_000, 2_000, 3_000, 4_000];
  let timeIndex = 0;
  let signalActive = true;
  const events: Array<{ type: string }> = [];
  let captureStarts = 0;
  let captureStops = 0;
  const service = new AutomaticMeetingWatchService({
    config: {
      libraryDir: root,
      meeting: {
        automation: {
          enabled: true,
          mode: 'automatic',
          confirmationPolls: 2,
          endGraceSeconds: 1,
          cooldownSeconds: 1,
        },
      },
    },
    onEvent: (value) => events.push(value),
    dependencies: {
      now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]!),
      readSignals: () => ({
        schemaVersion: 1,
        capturedAtUnixMs: times[Math.max(0, timeIndex - 1)]!,
        supported: true,
        inputProcesses: signalActive
          ? [{ pid: 42, bundleId: 'us.zoom.xos', name: 'Zoom' }]
          : [],
      }),
      startCapture: (options) => {
        captureStarts += 1;
        const startedAt = options.startedAt ?? new Date(1_000);
        const store = new CaptureSessionStore({
          libraryDir: options.libraryDir,
          sessionId: 'automatic-test',
          startedAtUnixMs: startedAt.getTime(),
          createdAt: startedAt.toISOString(),
        });
        return {
          sessionId: 'automatic-test',
          manifestPath: store.manifestPath,
          store,
          async stop() {
            captureStops += 1;
            return store.setStatus('captured', 'test');
          },
        } satisfies DurableLiveCaptureHandle;
      },
      finalizeCapture: async () => createTranscriptRecord({
        transcript: [{ id: 's000001', start: 0, end: 1, text: 'Hello', speaker: 'LOCAL' }],
        speakers: [{ id: 'LOCAL', label: 'Microphone' }],
      }, { id: 'automatic-test', now: new Date(1_000), title: 'Zoom meeting' }),
    },
  });

  expect((await service.pollOnce()).kind).toBe('none');
  expect((await service.pollOnce()).kind).toBe('start');
  expect(captureStarts).toBe(1);
  signalActive = false;
  expect((await service.pollOnce()).kind).toBe('none');
  expect((await service.pollOnce()).kind).toBe('finish');
  await service.shutdown();
  expect(captureStops).toBe(1);
  expect(events.map((value) => value.type)).toEqual([
    'meeting.started',
    'meeting.capture-finished',
    'meeting.ready',
  ]);
});

test('a short-lived consent command can approve an ambiguous background browser call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-auto-consent-'));
  roots.push(root);
  let captureStarts = 0;
  let consentReads = 0;
  const service = new AutomaticMeetingWatchService({
    config: {
      libraryDir: root,
      meeting: {
        automation: {
          mode: 'automatic',
          browserWithoutCalendar: 'ask',
          confirmationPolls: 2,
        },
      },
    },
    dependencies: {
      now: () => new Date(1_000),
      readSignals: () => ({
        schemaVersion: 1,
        capturedAtUnixMs: 1_000,
        supported: true,
        inputProcesses: [{ pid: 7, bundleId: 'com.google.Chrome', name: 'Chrome' }],
      }),
      consumeConsent: () => (++consentReads === 1 ? 'approve' : undefined),
      startCapture: (options) => {
        captureStarts += 1;
        const store = new CaptureSessionStore({
          libraryDir: options.libraryDir,
          sessionId: 'browser-consent',
          startedAtUnixMs: 1_000,
        });
        return {
          sessionId: 'browser-consent',
          manifestPath: store.manifestPath,
          store,
          async stop() { return store.setStatus('captured', 'test'); },
        } satisfies DurableLiveCaptureHandle;
      },
      finalizeCapture: async () => createTranscriptRecord({
        transcript: [{ start: 0, end: 1, text: 'Approved.' }],
        speakers: [],
      }, { id: 'browser-consent', now: new Date(1_000), title: 'Chrome meeting' }),
    },
  });
  expect((await service.pollOnce()).kind).toBe('none');
  expect((await service.pollOnce()).kind).toBe('start');
  expect(captureStarts).toBe(1);
  await service.shutdown();
});
