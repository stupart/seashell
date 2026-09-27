import { expect, test } from 'bun:test';
import { CaptureHealthTracker } from '../src/capture-health.ts';
import { captureRecordingMode, recordingNeedsAttention } from '../src/RecordingStatus.tsx';

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
