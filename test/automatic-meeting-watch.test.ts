import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AutomaticMeetingWatchService } from '../src/automatic-meeting-watch.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import type { DurableLiveCaptureHandle } from '../src/durable-live-capture.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
