import { expect, test } from 'bun:test';
import { isLikelySystemAudioLeak, reconcileLiveEcho } from '../src/live-echo.ts';

const system = {
  start: 21,
  end: 31,
  speaker: 'SYSTEM',
  text: 'And so, my fellow Americans, ask not what your country can do for you.',
};

test('strong overlapping playback text is not falsely attributed to the microphone', () => {
  const microphone = {
    start: 1,
    end: 31.5,
    speaker: 'LOCAL',
    text: 'So my fellow Americans ask not what your country can do for you',
  };
  expect(isLikelySystemAudioLeak(microphone, system)).toBe(true);
  expect(reconcileLiveEcho([system], microphone)).toEqual([system]);
  expect(reconcileLiveEcho([microphone], system)).toEqual([system]);
});

test('distinct or non-overlapping microphone speech is preserved', () => {
  const local = {
    start: 22,
    end: 25,
    speaker: 'LOCAL',
    text: 'I think we should move the launch to next Thursday.',
  };
  const repeatedLater = { ...system, start: 60, end: 70 };
  expect(isLikelySystemAudioLeak(local, system)).toBe(false);
  expect(isLikelySystemAudioLeak({ ...system, speaker: 'LOCAL' }, repeatedLater)).toBe(false);
  expect(reconcileLiveEcho([system], local)).toEqual([system, local]);
});

test('short generic phrases remain ambiguous and are never suppressed', () => {
  const local = { start: 21, end: 22, speaker: 'LOCAL', text: 'Thank you' };
  const remote = { start: 21, end: 22, speaker: 'SYSTEM', text: 'Thank you' };
  expect(isLikelySystemAudioLeak(local, remote)).toBe(false);
});

test('remote playback inside a longer local response does not erase the new local speech', () => {
  const remote = { start: 1, end: 10, speaker: 'SYSTEM',
    text: 'The project launch is scheduled for next Thursday morning.' };
  const local = { start: 2, end: 14, speaker: 'LOCAL',
    text: 'The project launch is scheduled for next Thursday morning. I disagree because the payment integration is broken and we need another full week of testing.' };
  expect(isLikelySystemAudioLeak(local, remote)).toBe(false);
  expect(reconcileLiveEcho([remote], local)).toEqual([remote, local]);
  expect(reconcileLiveEcho([local], remote)).toEqual([remote, local]);
});
