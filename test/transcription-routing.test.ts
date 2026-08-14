import { expect, test } from 'bun:test';
import {
  selectCanonicalTranscriptionRoute,
  selectDraftTranscriptionRoute,
  type TranscriptionRoutingConfig,
} from '../src/transcription-routing.ts';

const adaptive: TranscriptionRoutingConfig = {
  mode: 'adaptive',
  canonicalFinal: 'local',
  adaptiveCloudQueueDepth: 3,
  cloud: { model: 'openai/whisper-large-v3', uploadConsent: true },
};

test('adaptive routing keeps a pinned local canonical final', () => {
  expect(selectDraftTranscriptionRoute(adaptive, 1)).toBe('local');
  expect(selectDraftTranscriptionRoute(adaptive, 3)).toBe('cloud');
  expect(selectCanonicalTranscriptionRoute(adaptive)).toBe('local');
});

test('cloud routing fails closed without upload consent', () => {
  expect(() => selectDraftTranscriptionRoute({
    ...adaptive,
    mode: 'cloud',
    cloud: { model: 'openai/whisper-large-v3', uploadConsent: false },
  }, 0)).toThrow('explicit uploadConsent');
  expect(() => selectCanonicalTranscriptionRoute({
    ...adaptive,
    canonicalFinal: 'cloud',
    cloud: undefined,
  })).toThrow('explicit uploadConsent');
});
