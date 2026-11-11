import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomaticMeetingWatchService } from '../src/automatic-meeting-watch.ts';
import { CaptureHealthTracker, oneSidedNotifier, ONE_SIDED_MESSAGE, readMeetingCoverage } from '../src/capture-health.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { lastMeetingEvidence } from '../src/feature-status.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { listTranscriptRecords } from '../src/transcript-library.ts';

const silent = { peak: 1, rms: 1, rmsDbfs: -90 };
const talking = { peak: 1000, rms: 100, rmsDbfs: -45 };

test('a call where only the others are heard notifies once and is saved as missing your side', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-one-sided-'));
  const notices: string[] = [];
  const notify = oneSidedNotifier(message => notices.push(message));
  const health = new CaptureHealthTracker({ nowUnixMs: 0 });
  let now = 1000;
  let publish = () => {};
  const service = new AutomaticMeetingWatchService({ libraryDir: root,
    config: { meeting: { automation: { enabled: true, mode: 'automatic', confirmationPolls: 1 } } },
    onEvent: notify,
    dependencies: {
      now: () => new Date(now), consumeConsent: () => undefined,
      readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: now, supported: true,
        inputProcesses: [{ pid: 42, bundleId: 'us.zoom.xos', name: 'Zoom' }] }),
      startCapture: options => {
        const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'one-sided', startedAtUnixMs: now });
        publish = () => options.onStatus?.({ microphone: 'active', systemAudio: 'active', durableChunks: 0, health: health.snapshot });
        return { store, sessionId: 'one-sided', manifestPath: store.manifestPath, async stop() {
          const chunk = (trackId: 'microphone' | 'system-audio', index: number, audible: boolean) =>
            ({ trackId, audible, startMs: index * 10_000, endMs: (index + 1) * 10_000 });
          health.stop(++now, [...Array.from({ length: 30 }, (_, index) => chunk('microphone', index, false)),
            ...Array.from({ length: 30 }, (_, index) => chunk('system-audio', index, true))]);
          publish();
          return store.setStatus('captured', 'fixture');
        } };
      },
      startLiveTranscript: () => ({ status: { stage: 'live', detail: 'Live', queueDepth: 0 }, enqueue() {}, async close() {} }),
      finalizeCapture: async () => createTranscriptRecord({ transcript: [], speakers: [] }, { id: 'one-sided', now: new Date(1000) }),
    },
  });
  try {
    await service.pollOnce();
    // Two minutes of the others talking to a microphone that hears nothing,
    // then you unmute, then you go quiet again.
    for (let time = 500; time <= 120_000; time += 500) {
      health.pcm('microphone', silent, undefined, time);
      health.pcm('systemAudio', talking, undefined, time);
      publish();
    }
    health.pcm('microphone', talking, undefined, 120_500);
    publish();
    for (let time = 121_000; time <= 240_000; time += 500) {
      health.pcm('microphone', silent, undefined, time);
      health.pcm('systemAudio', talking, undefined, time);
      publish();
    }
    expect(notices).toEqual([ONE_SIDED_MESSAGE]);
    await service.shutdown();
    const meeting = listTranscriptRecords(root)[0]!;
    expect(meeting.captureHealth?.coverage).toMatchObject({ yourSideMissing: true, otherSideAudibleSeconds: 300 });
    expect(readMeetingCoverage(meeting.directory, meeting.captureHealth)?.yourSideMissing).toBe(true);
    expect(lastMeetingEvidence(root)?.coverage?.yourSideMissing).toBe(true);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
