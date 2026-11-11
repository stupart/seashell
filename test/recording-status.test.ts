import { expect, test } from 'bun:test';
import { CaptureHealthTracker } from '../src/capture-health.ts';
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
  expect(live.problems[0]).toBe('Microphone: not hearing you — muted or wrong mic? · i audio help');
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
