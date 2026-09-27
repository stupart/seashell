import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomaticMeetingWatchService, type AutomaticMeetingWatchEvent } from '../src/automatic-meeting-watch.ts';
import { CaptureHealthTracker } from '../src/capture-health.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { readBackgroundWatchStatus } from '../src/background-watch-status.ts';
import { readBackgroundMeetingStatus } from '../src/background-meeting-status.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { listTranscriptRecords } from '../src/transcript-library.ts';

test('background health warnings persist into ready history while draft status and saved progress remain visible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-health-watch-'));
  const events: AutomaticMeetingWatchEvent[] = [];
  const health = new CaptureHealthTracker({ nowUnixMs: 1 });
  let now = 1000, closedDraft = false;
  const service = new AutomaticMeetingWatchService({ libraryDir: root,
    config: { meeting: { automation: { enabled: true, mode: 'automatic', confirmationPolls: 1 } } },
    onEvent: event => events.push(event),
    dependencies: {
      now: () => new Date(now), consumeConsent: () => undefined,
      readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: now, supported: true,
        inputProcesses: [{ pid: 42, bundleId: 'us.zoom.xos', name: 'Zoom' }] }),
      startCapture: options => {
        const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'source-health', startedAtUnixMs: now });
        health.state('microphone', { state: 'active', code: 'microphone_quiet', message: 'Input is quiet; check if you are speaking.' }, now);
        health.pcm('systemAudio', { peak: 1000, rms: 100, rmsDbfs: -45 }, true, now);
        const status = () => options.onStatus?.({ microphone: 'active', systemAudio: 'active', durableChunks: 1,
          audioSavedThroughMs: 10000, health: health.snapshot });
        status();
        return { store, sessionId: 'source-health', manifestPath: store.manifestPath,
          async stop() { health.stop(++now); status(); return store.setStatus('captured', 'fixture'); } };
      },
      startLiveTranscript: options => {
        const status = { stage: 'live' as const, detail: 'Live draft available', queueDepth: 0 };
        options.onStatus?.(status);
        return { status, enqueue() {}, async close() { closedDraft = true;
          options.onStatus?.({ stage: 'stopped', detail: 'Final transcript is next', queueDepth: 0 }); } };
      },
      finalizeCapture: async () => {
        expect(closedDraft).toBe(true);
        return createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'Remote audio survived.' }], speakers: [] },
          { id: 'source-health', now: new Date(1000) });
      },
    },
  });
  try {
    await service.pollOnce();
    const recording = listTranscriptRecords(root)[0]!;
    expect(recording.captureState).toBe('recording');
    expect(recording.captureHealth?.microphone.state).toBe('quiet');
    expect(recording.audioSavedThroughMs).toBe(10000);
    expect(recording.draftStatus?.stage).toBe('live');
    expect(readBackgroundWatchStatus(root, { nowUnixMs: now })?.phase).toBe('recording');
    expect(events.some(event => event.type === 'watch.warning' && event.message.includes('Input is quiet'))).toBe(true);
    await service.shutdown();
    const ready = listTranscriptRecords(root)[0]!;
    expect(ready.captureState).toBe('ready');
    expect(ready.captureHealth?.microphone.state).toBe('stopped');
    expect(ready.captureHealth?.microphone.warnings[0]?.kind).toBe('quiet');
    expect(ready.captureHealth?.microphone.warnings[0]?.resolvedAtUnixMs).toBeUndefined();
    expect(readBackgroundMeetingStatus(ready.directory)?.audioSavedThroughMs).toBe(10000);
    expect(ready.draftStatus?.stage).toBe('stopped');
    expect(readBackgroundWatchStatus(root, { nowUnixMs: now })?.phase).toBe('stopped');
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test('each waiting episode gets a new scoped consent ID even when the browser candidate ID repeats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-consent-projection-'));
  let now = 1000, active = true;
  const consumed: Array<string | undefined> = [];
  const service = new AutomaticMeetingWatchService({ libraryDir: root,
    config: { meeting: { automation: { enabled: true, mode: 'automatic', confirmationPolls: 1, browserWithoutCalendar: 'ask' } } },
    dependencies: {
      now: () => new Date(now),
      readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: now, supported: true,
        inputProcesses: active ? [{ pid: 42, bundleId: 'com.google.Chrome', name: 'Chrome' }] : [] }),
      consumeConsent: (_path, _now, _age, consentId) => { consumed.push(consentId); return undefined; },
    },
  });
  try {
    await service.pollOnce();
    const first = readBackgroundWatchStatus(root, { nowUnixMs: now });
    expect(first?.phase).toBe('awaiting-consent');
    expect(first?.consentId).toBeTruthy();
    expect(consumed.at(-1)).toBe(first?.consentId);
    active = false; now += 1000; await service.pollOnce();
    expect(readBackgroundWatchStatus(root, { nowUnixMs: now })?.consentId).toBeUndefined();
    active = true; now += 1000; await service.pollOnce();
    const second = readBackgroundWatchStatus(root, { nowUnixMs: now });
    expect(second?.candidate?.id).toBe(first?.candidate?.id);
    expect(second?.consentId).toBeTruthy();
    expect(second?.consentId).not.toBe(first?.consentId);
    service.declineSuggestion();
    expect(readBackgroundWatchStatus(root, { nowUnixMs: now })?.consentId).toBeUndefined();
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
