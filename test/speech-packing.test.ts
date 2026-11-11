import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { readMonoPcm } from '../src/speech-gate.ts';
import { packedSpeechPcm, packSpeech, planSpeechPacking, unpackUnits, type SpeechPacking } from '../src/speech-packing.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'seashell-speech-packing-')); directories.push(path); return path; };

const RATE = 16_000;
const seconds = (value: number) => Math.round(value * RATE);
const wav = (pcm: Int16Array, sampleRate = RATE) => pcmS16leToWav(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), sampleRate);

/**
 * A 100-second track with speech at 1-2 s, 2.5-3 s and 10-11 s: the first two
 * are packed together, padded by 0.4 s, and 1 s of silence parts them from the third.
 */
const regions = [{ start: 1, end: 2 }, { start: 2.5, end: 3 }, { start: 10, end: 11 }];
const packing: SpeechPacking = {
  spans: [{ track: 0.6, packed: 0, duration: 2.8 }, { track: 9.6, packed: 3.8, duration: 1.8 }],
  trackSeconds: 100,
};

test('regions are padded, close ones joined, and spans laid out with silence between them', () => {
  expect(planSpeechPacking(regions, seconds(100))).toEqual(packing);
});

test('padding never reaches before the track starts or past its end', () => {
  const plan = planSpeechPacking([{ start: 0.1, end: 1 }, { start: 99, end: 99.9 }], seconds(100));
  expect(plan?.spans[0]).toEqual({ track: 0, packed: 0, duration: 1.4 });
  expect(plan?.spans[1]).toEqual({ track: 98.6, packed: 2.4, duration: 1.4 });
});

test('nothing is packed without speech, or when speech fills most of the track', () => {
  expect(planSpeechPacking([], seconds(100))).toBeUndefined();
  expect(planSpeechPacking([{ start: 5, end: 85 }], seconds(100))).toBeUndefined();
  expect(planSpeechPacking([{ start: 5, end: 75 }], seconds(100))).toBeDefined();
});

test('packed audio holds each span in order, with digital silence between', () => {
  const pcm = new Int16Array(seconds(100)).map((_, index) => (index % 1_000) + 1);
  const packed = packedSpeechPcm(pcm, packing);
  expect(packed.length).toBe(seconds(5.6));
  expect(packed[0]).toBe(pcm[seconds(0.6)]!);
  expect(packed[seconds(2.8) - 1]).toBe(pcm[seconds(3.4) - 1]!);
  expect(packed.subarray(seconds(2.8), seconds(3.8)).every((sample) => sample === 0)).toBe(true);
  expect(packed[seconds(3.8)]).toBe(pcm[seconds(9.6)]!);
  expect(packed.at(-1)).toBe(pcm[seconds(11.4) - 1]!);
});

test('the packed file is a WAV the rest of Seashell reads, and is only written when packing helps', () => {
  const root = directory();
  const track = join(root, 'track.wav');
  writeFileSync(track, wav(new Int16Array(seconds(100)).fill(100)));
  const destination = join(root, 'speech.wav');
  expect(packSpeech(track, regions, destination)).toEqual(packing);
  expect(readMonoPcm(readFileSync(destination))?.length).toBe(seconds(5.6));

  const dense = join(root, 'dense.wav');
  expect(packSpeech(track, [{ start: 0, end: 95 }], dense)).toBeUndefined();
  expect(existsSync(dense)).toBe(false);
  writeFileSync(track, wav(new Int16Array(seconds(100)), 44_100));
  expect(packSpeech(track, regions, dense)).toBeUndefined();
  expect(existsSync(dense)).toBe(false);
});

const word = (start: number, end: number, extra: { anchor?: number; role?: string } = {}) => ({ start, end, text: 'word', ...extra });

test('times inside a span move by that span’s offset', () => {
  expect(unpackUnits([word(0.5, 0.9, { anchor: 0.9 }), word(4, 4.5, { anchor: 4.4 })], packing)).toEqual([
    word(1.1, 1.5, { anchor: 1.5 }), word(9.8, 10.3, { anchor: 10.2 }),
  ]);
});

test('a start in packed silence belongs to the next span, an end to the previous one', () => {
  expect(unpackUnits([word(3.2, 4.2)], packing)).toEqual([word(9.6, 10)]);
  expect(unpackUnits([word(2.5, 3.1)], packing)).toEqual([word(3.1, 3.4)]);
});

test('a segment that straddles a cut covers the speech on both sides of it', () => {
  expect(unpackUnits([word(2, 5)], packing)).toEqual([word(2.6, 10.8)]);
});

test('a unit wholly in packed silence lands, with no length, at the nearer edge of real audio', () => {
  expect(unpackUnits([word(2.9, 3.1, { anchor: 3 })], packing)).toEqual([word(3.4, 3.4, { anchor: 3.4 })]);
  expect(unpackUnits([word(3.5, 3.7)], packing)).toEqual([word(9.6, 9.6)]);
  expect(unpackUnits([word(6, 7)], packing)).toEqual([word(11.4, 11.4)]);
});

test('times past the packed audio stop at the end of its last span', () => {
  expect(unpackUnits([word(5, 9, { anchor: 8 })], packing)).toEqual([word(10.8, 11.4, { anchor: 11.4 })]);
});

test('other fields come through untouched', () => {
  expect(unpackUnits([word(0.5, 0.9, { role: 'local' })], packing)).toEqual([word(1.1, 1.5, { role: 'local' })]);
});

test('every mapped time stays on the track, and no unit ends before it starts, whatever Whisper reports', () => {
  const plan = planSpeechPacking([{ start: 0, end: 1 }, { start: 30, end: 31 }, { start: 59.5, end: 60 }], seconds(60))!;
  const packedEnd = plan.spans.at(-1)!.packed + plan.spans.at(-1)!.duration;
  let state = 11;
  const random = () => { state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff; return state / 0x7fff_ffff; };
  const units = Array.from({ length: 500 }, () => {
    const start = random() * (packedEnd + 2);
    return word(start, start + random() * 3, { anchor: start + random() });
  });
  const mapped = unpackUnits(units, plan);
  for (const unit of mapped) {
    expect(unit.start).toBeGreaterThanOrEqual(0);
    expect(unit.end).toBeGreaterThanOrEqual(unit.start);
    expect(unit.end).toBeLessThanOrEqual(60);
    expect(unit.anchor!).toBeGreaterThanOrEqual(0);
    expect(unit.anchor!).toBeLessThanOrEqual(60);
  }
});
