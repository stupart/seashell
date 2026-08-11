import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { renderCapabilityManifest, seashellCapabilityManifest } from '../src/capabilities.ts';

test('capability manifest advertises executable behavior, not presentation formats', () => {
  const manifest = seashellCapabilityManifest({ systemAudioReady: true });
  const offer = manifest.capabilities[0]!;
  const packageVersion = (JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }).version;
  expect(manifest.product.version).toBe(packageVersion);
  expect(offer.operation).toBe('media.transcribe');
  expect(offer.inputKinds).toEqual(['audio-file', 'video-file']);
  expect(offer.network).toBe('none');
  expect(offer.features).toEqual(['segment-timestamps', 'audio-stream-selection']);
  expect(offer.features).not.toContain('srt');
  expect(renderCapabilityManifest()).toContain('speaker-diarization');
  const capture = manifest.capabilities.find((candidate) => candidate.operation === 'media.capture');
  expect(capture).toMatchObject({
    id: 'capture.seashell.macos.live',
    modes: ['live'],
    inputKinds: ['microphone', 'system-audio'],
    network: 'none',
  });
  expect(capture?.features).toContain('shared-session-clock');
});
