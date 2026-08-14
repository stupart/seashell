import { expect, test } from 'bun:test';
import { parseStoredLocalAsrProfile } from '../src/local-asr-profile.ts';

test('measured local ASR profiles are strict and carry benchmark evidence', () => {
  const profile = parseStoredLocalAsrProfile({
    schemaVersion: '0.1',
    measuredAt: '2026-08-14T12:00:00.000Z',
    sourceAudioSeconds: 8,
    modelPath: '/models/whisper.bin',
    threads: 4,
    medianLatencyMs: 2400,
    realtimeFactor: 0.3,
  });
  expect(profile.threads).toBe(4);
  expect(profile.realtimeFactor).toBe(0.3);
  expect(() => parseStoredLocalAsrProfile({ ...profile, medianLatencyMs: 'fast' })).toThrow();
});
