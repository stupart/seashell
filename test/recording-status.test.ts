import { expect, test } from 'bun:test';
import { CaptureHealthTracker, parseCaptureHealth } from '../src/capture-health.ts';
import { LIVE_TEXT_PAUSED } from '../src/live-text-guard.ts';
import { captureRecordingMode, recordingNeedsAttention, recordingSummary } from '../src/RecordingStatus.tsx';

test('record intent and helper readiness cannot claim capture before PCM arrives', () => {
  expect(captureRecordingMode()).toBe('starting');
  const health = new CaptureHealthTracker({ nowUnixMs: 1000 });
  expect(captureRecordingMode(health.snapshot)).toBe('starting');
  health.state('systemAudio', { state: 'ready' }, 1001);
  health.state('microphone', { state: 'active' }, 1002);
  expect(captureRecordingMode(health.snapshot)).toBe('starting');
  expect(recordingNeedsAttention(health.snapshot, false, 1003)).toBe(false);
  health.pcm('microphone', { peak: 0, rms: 0, rmsDbfs: -Infinity }, false, 1004);
  expect(captureRecordingMode(health.snapshot)).toBe('recording');
});

test('one surviving source is still recording, while complete loss stops the claim', () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 1000 });
  health.state('microphone', { state: 'unavailable' }, 1001);
  expect(captureRecordingMode(health.snapshot)).toBe('starting');
  health.pcm('systemAudio', undefined, true, 1002);
  expect(captureRecordingMode(health.snapshot)).toBe('recording');
  health.state('systemAudio', { state: 'starting', code: 'system_audio_reconnecting' }, 1003);
  expect(captureRecordingMode(health.snapshot)).toBe('starting');
  health.state('systemAudio', { state: 'unavailable' }, 1004);
  expect(captureRecordingMode(health.snapshot)).toBe('no-audio');
  health.stop(1005);
  expect(captureRecordingMode(health.snapshot)).toBe('no-audio');
  expect(captureRecordingMode(new CaptureHealthTracker({ microphone: false, systemAudio: false }).snapshot)).toBe('no-audio');
});

test('quiet PCM remains capture with a caution, without pretending speech was verified', () => {
  const health = new CaptureHealthTracker({ systemAudio: false, nowUnixMs: 1000, quietAfterMs: 100 });
  health.pcm('microphone', undefined, false, 1100);
  expect(captureRecordingMode(health.snapshot)).toBe('recording');
  expect(recordingNeedsAttention(health.snapshot, false, 1100)).toBe(true);
  expect(health.snapshot.microphone.lastSignalAtUnixMs).toBeUndefined();
});

test('stale receiving PCM asks for attention after eight seconds, even after an earlier signal', () => {
  const health = new CaptureHealthTracker({ systemAudio: false, nowUnixMs: 1000 });
  health.pcm('microphone', undefined, true, 1000);
  expect(recordingNeedsAttention(health.snapshot, false, 9000)).toBe(false);
  expect(recordingNeedsAttention(health.snapshot, false, 9001)).toBe(true);
  // A newer state message does not refresh evidence of actual PCM reception.
  health.state('microphone', { state: 'active' }, 9001);
  expect(recordingNeedsAttention(health.snapshot, false, 9001)).toBe(true);
  health.pcm('microphone', undefined, false, 9002);
  expect(recordingNeedsAttention(health.snapshot, false, 9002)).toBe(false);
  health.stop(9003);
  expect(recordingNeedsAttention(health.snapshot, true, 90_000)).toBe(false);
});

test('a claimed active source without PCM eventually needs attention; disabled sources do not', () => {
  const health = new CaptureHealthTracker({ systemAudio: false, nowUnixMs: 1000 });
  health.state('microphone', { state: 'active' }, 1001);
  expect(recordingNeedsAttention(health.snapshot, false, 9001)).toBe(false);
  expect(recordingNeedsAttention(health.snapshot, false, 9002)).toBe(true);
  const disabled = new CaptureHealthTracker({ microphone: false, systemAudio: false, nowUnixMs: 1 }).snapshot;
  expect(recordingNeedsAttention(disabled, false, 90_000)).toBe(false);
  expect(recordingNeedsAttention(undefined, false, 90_000)).toBe(false);
});

test('a one-sided call names the likely cause live, and a saved meeting says your side was not recorded', () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 0 });
  for (let time = 500; time <= 61_000; time += 500) {
    health.pcm('microphone', { peak: 1, rms: 1, rmsDbfs: -90 }, undefined, time);
    health.pcm('systemAudio', { peak: 1000, rms: 100, rmsDbfs: -45 }, undefined, time);
  }
  const live = recordingSummary({ mode: 'recording', health: health.snapshot, nowUnixMs: 61_000 });
  expect(live.problems[0]).toBe('Microphone: silent — muted or wrong mic? · i audio help');
  // Two audible chunks of 681: something was heard, but not your side of the call.
  const chunk = (trackId: 'microphone' | 'system-audio', index: number, audible: boolean) =>
    ({ trackId, audible, startMs: index * 10_000, endMs: (index + 1) * 10_000 });
  health.stop(62_000, [
    ...Array.from({ length: 681 }, (_, index) => chunk('microphone', index, index < 2)),
    ...Array.from({ length: 680 }, (_, index) => chunk('system-audio', index, index < 425)),
  ]);
  expect(recordingNeedsAttention(health.snapshot, true, 62_000)).toBe(true);
  const saved = recordingSummary({ mode: 'ready', health: health.snapshot, nowUnixMs: 62_000 });
  expect(saved.headline).toBe('Saved · audio needs review');
  expect(saved.problems).toEqual(['Microphone: your side wasn’t recorded']);
});

test('the title slot gets the most urgent problem in a few words, its key apart: red only while a source fails', () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 0 });
  health.state('microphone', { state: 'unavailable', code: 'microphone_stopped', message: 'The microphone stopped.' }, 1);
  health.pcm('systemAudio', { peak: 1000, rms: 500, rmsDbfs: -30 }, true, 2);
  const failing = recordingSummary({ mode: 'recording', health: health.snapshot, nowUnixMs: 3 });
  expect(failing.alert).toEqual({ text: 'Mic silent', color: 'red', fix: ['i', 'mic help'] });
  // What is happening keeps the title's own colour: only the alert says something is wrong.
  expect(failing.headline).toStartWith('● Recording');
  expect(failing).not.toHaveProperty('color');
  // One-sided is attention, not failure.
  const quiet = new CaptureHealthTracker({ nowUnixMs: 0 });
  for (let time = 500; time <= 61_000; time += 500) {
    quiet.pcm('microphone', { peak: 1, rms: 1, rmsDbfs: -90 }, undefined, time);
    quiet.pcm('systemAudio', { peak: 1000, rms: 100, rmsDbfs: -45 }, undefined, time);
  }
  expect(recordingSummary({ mode: 'recording', health: quiet.snapshot, nowUnixMs: 61_000 }).alert)
    .toMatchObject({ text: 'Mic silent', color: 'yellow', fix: ['i', 'mic help'] });
  // A recorder warning is said whole when short, by its first sentence when narrow.
  expect(recordingSummary({ mode: 'watching', warning: 'Meet detection unavailable. Check Speakers.' }))
    .toMatchObject({ headline: 'Ready · watching for calls', alert: { text: 'Meet detection unavailable. Check Speakers', short: 'Meet detection unavailable' } });
  // After the call: audio is safe and the notes are coming, not how far the audio got.
  expect(recordingSummary({ mode: 'processing', title: 'Design review', savedThroughSeconds: 110 }))
    .toMatchObject({ headline: 'Call ended · Design review', detail: 'Audio saved · writing notes', short: 'Call ended · writing notes…' });
});

test('while a call records, the status says what the video films, and a whole screen in the title itself', () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 1000 });
  health.pcm('microphone', undefined, true, 1001);
  health.video('starting', { kind: 'window', name: 'the Google Meet window' }, 1002);
  health.video('recording', undefined, 1003);
  const summary = (snapshot = health.snapshot) => recordingSummary({ mode: 'recording', health: snapshot, savedThroughSeconds: 12, elapsedSeconds: 20, nowUnixMs: 1004 });
  expect(summary().detail).toBe('Audio saved through 0:12 · Filming the Google Meet window');
  expect(summary().label).toBe('● Recording 0:20');
  health.video('waiting', undefined, 1005);
  expect(summary().detail).toBe('Audio saved through 0:12 · Not filming: no call window showing');
  // Only ever asked for, and said where nothing cuts it off, for the rest of the recording.
  health.video('recording', { kind: 'display', name: 'display 1, the whole screen' }, 1006);
  expect(summary().detail).toBe('Audio saved through 0:12 · Filming display 1, the whole screen');
  expect(summary().label).toBe('● Recording 0:20 · filming the whole screen');
  // It survives the trip through capture-health.json to the window showing it.
  const saved = parseCaptureHealth(JSON.parse(JSON.stringify(health.snapshot)));
  expect(saved?.video).toEqual({ state: 'recording', filming: 'display 1, the whole screen', screenFilmed: true });
  expect(summary(saved).label).toBe('● Recording 0:20 · filming the whole screen');
  expect(parseCaptureHealth({ ...health.snapshot, video: { state: 'filming the bank' } })).toBeUndefined();
});

test('a microphone let go of because the call let go of its own is said plainly, never as a failure', () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 1000 });
  health.pcm('microphone', undefined, true, 1100);
  health.pcm('systemAudio', undefined, true, 1100);
  health.release('microphone', 1200);
  // A late chunk from the released microphone does not undo it.
  health.pcm('microphone', undefined, true, 1300);
  expect(health.snapshot.microphone.state).toBe('released');
  expect(parseCaptureHealth(JSON.parse(JSON.stringify(health.snapshot)))?.microphone.state).toBe('released');
  health.pcm('systemAudio', undefined, true, 20_000);
  expect(captureRecordingMode(health.snapshot)).toBe('recording');
  expect(recordingNeedsAttention(health.snapshot, false, 20_000)).toBe(false);
  expect(recordingSummary({ mode: 'recording', health: health.snapshot, nowUnixMs: 20_000, savedThroughSeconds: 19 }).alert).toBeUndefined();
  // Opened again when the call comes back.
  health.state('microphone', { state: 'active' }, 21_000);
  expect(health.snapshot.microphone.state).toBe('receiving');
});

test('live text paused is said in yellow with no key: nothing fixes it but time, and the audio still records', () => {
  const health = new CaptureHealthTracker({ nowUnixMs: 1000 });
  health.pcm('microphone', { peak: 1000, rms: 500, rmsDbfs: -30 }, true, 1000);
  health.pcm('systemAudio', { peak: 1000, rms: 500, rmsDbfs: -30 }, true, 1000);
  const paused = recordingSummary({ mode: 'recording', health: health.snapshot, draftLabel: LIVE_TEXT_PAUSED, nowUnixMs: 1500 });
  expect(paused.alert).toEqual({ text: 'Live text paused', color: 'yellow' });
  // The whole sentence, for `seashell` output and the transcript's last row.
  expect(paused.problems).toEqual([LIVE_TEXT_PAUSED]);
  expect(LIVE_TEXT_PAUSED).toContain('Audio is still recording');
});
