import { expect, test } from 'bun:test';
import {
  parseNativeSystemAudioEvent,
  PcmS16leChunker,
  pcmS16leToWav,
  pcmS16leSignalLevel,
  hasAudiblePcmSignal,
} from '../src/live-system-audio.ts';

test('native system-audio events are strict and preserve first-buffer clock evidence', () => {
  expect(parseNativeSystemAudioEvent(JSON.stringify({
    type: 'start', sampleRate: 16000, channels: 1, bitsPerChannel: 16,
  }))).toEqual({ type: 'start', sampleRate: 16000, channels: 1, bitsPerChannel: 16 });
  expect(parseNativeSystemAudioEvent(JSON.stringify({
    type: 'first-buffer', capturedAtUnixMs: 1_786_400_000_000,
    hostTime: '19351966390170', sampleTime: 0,
  }))).toEqual({
    type: 'first-buffer', capturedAtUnixMs: 1_786_400_000_000,
    hostTime: '19351966390170', sampleTime: 0,
  });
  expect(() => parseNativeSystemAudioEvent('{bad')).toThrow('malformed JSON');
  expect(() => parseNativeSystemAudioEvent('{"type":"mystery"}')).toThrow('Unknown');
  expect(() => parseNativeSystemAudioEvent(JSON.stringify({
    type: 'first-buffer', capturedAtUnixMs: 1, sampleTime: '0',
  }))).toThrow('finite number');
});

test('PCM chunking is byte-lossless and carries a monotonic sample clock', () => {
  const chunker = new PcmS16leChunker(1_000, 100);
  const first = chunker.append(Buffer.alloc(50, 1));
  expect(first).toEqual([]);
  const chunks = chunker.append(Buffer.alloc(370, 2));
  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toMatchObject({ sequence: 1, startFrame: 0, endFrame: 100 });
  expect(chunks[1]).toMatchObject({ sequence: 2, startFrame: 100, endFrame: 200 });
  expect(chunks[0]!.pcm).toHaveLength(200);
  expect(chunks[0]!.pcm.subarray(0, 50)).toEqual(Buffer.alloc(50, 1));
  expect(chunks[0]!.pcm.subarray(50)).toEqual(Buffer.alloc(150, 2));
  const final = chunker.flush();
  expect(final).toMatchObject({ sequence: 3, startFrame: 200, endFrame: 210 });
  expect(final!.pcm).toHaveLength(20);
});

test('PCM chunks become valid independently decodable mono WAV files', () => {
  const pcm = Buffer.alloc(32_000, 0x2a);
  const wav = pcmS16leToWav(pcm, 16_000, 1);
  expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
  expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt16LE(34)).toBe(16);
  expect(wav.readUInt32LE(40)).toBe(pcm.length);
  expect(wav.subarray(44)).toEqual(pcm);
});

test('digital silence is skipped without discarding quiet but audible speech', () => {
  const silence = Buffer.alloc(32_000);
  expect(hasAudiblePcmSignal(silence)).toBe(false);
  expect(pcmS16leSignalLevel(silence).rmsDbfs).toBe(Number.NEGATIVE_INFINITY);

  const audible = Buffer.alloc(32_000);
  for (let offset = 0; offset < audible.length; offset += 2) {
    audible.writeInt16LE(offset % 4 === 0 ? 600 : -600, offset);
  }
  expect(hasAudiblePcmSignal(audible)).toBe(true);
  expect(pcmS16leSignalLevel(audible).peak).toBe(600);
});
