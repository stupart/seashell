import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectSpeechRegions, dropPhantomUnits, isPhantomUnit, liveSpeechGateArguments, parseSpeechRegions, peakFrameDbfs, quietCuts, readMonoPcm } from '../src/speech-gate.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'seashell-speech-gate-')); directories.push(path); return path; };

/** Ten seconds at 16 kHz: silence, except a loud tone from 2 to 3 s and noise-floor hiss from 6 to 7 s. */
function audio(): Int16Array {
  const pcm = new Int16Array(160_000);
  for (let index = 32_000; index < 48_000; index += 1) pcm[index] = Math.round(8_000 * Math.sin(index / 5));
  for (let index = 96_000; index < 112_000; index += 1) pcm[index] = index % 2 ? 20 : -20;
  return pcm;
}
function wav(pcm: Int16Array, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}
const unit = (start: number, end: number, text = 'Okay.') => ({ start, end, text });

test('a line over silence or a noise floor is phantom', () => {
  expect(isPhantomUnit(unit(8, 9), [], audio())).toBe(true);
  expect(isPhantomUnit(unit(6.2, 6.8), [], audio())).toBe(true);
});

test('a word touching detected speech is kept, however quiet', () => {
  expect(isPhantomUnit(unit(8, 9), [{ start: 8.5, end: 8.9 }], audio())).toBe(false);
});

test('a loud line stays even if speech detection missed it', () => {
  expect(isPhantomUnit(unit(2.2, 2.8), [], audio())).toBe(false);
});

test('a zero-length timing is judged rather than crashing or always passing', () => {
  expect(isPhantomUnit(unit(8, 8), [], audio())).toBe(true);
  expect(isPhantomUnit(unit(2.5, 2.5), [], audio())).toBe(false);
});

test('loudness reads the span, and digital silence is the floor', () => {
  expect(peakFrameDbfs(audio(), 2.2, 2.8)).toBeGreaterThan(-20);
  expect(peakFrameDbfs(audio(), 8, 9)).toBe(-Infinity);
});

test('only the phantom units go, and order is preserved', async () => {
  const path = join(directory(), 'a.wav');
  writeFileSync(path, wav(audio()));
  const kept = await dropPhantomUnits([unit(0.5, 1, 'Thank'), unit(2.2, 2.6, 'real'), unit(8, 9, 'you')], path, async () => []);
  expect(kept.map((item) => item.text)).toEqual(['real']);
});

test('when detection is unavailable the transcript is untouched', async () => {
  const path = join(directory(), 'a.wav');
  writeFileSync(path, wav(audio()));
  const units = [unit(8, 9)];
  expect(await dropPhantomUnits(units, path, async () => undefined)).toEqual(units);
});

test('audio that is not 16 kHz mono PCM is left alone', async () => {
  const path = join(directory(), 'a.wav');
  writeFileSync(path, wav(audio(), 44_100));
  expect(readMonoPcm(wav(audio(), 44_100))).toBeUndefined();
  const units = [unit(8, 9)];
  expect(await dropPhantomUnits(units, path, async () => [])).toEqual(units);
});

test('a WAV with extra chunks before the audio still reads', () => {
  const plain = wav(audio());
  const extra = Buffer.from('LIST\x04\x00\x00\x00INFO', 'latin1');
  const pcm = readMonoPcm(Buffer.concat([plain.subarray(0, 36), extra, plain.subarray(36)]));
  expect(pcm?.length).toBe(160_000);
  expect(pcm?.[32_100]).toBe(audio()[32_100]);
});

test('speech regions are read from the tool, in seconds and in order', async () => {
  expect(parseSpeechRegions('Detected 2 speech segments:\nSpeech segment 1: start = 900.00, end = 950.50\nSpeech segment 0: start = 100.00, end = 250.00\n'))
    .toEqual([{ start: 1, end: 2.5 }, { start: 9, end: 9.505 }]);
  const root = directory();
  const tool = join(root, 'tool');
  const model = join(root, 'model');
  writeFileSync(model, '');
  writeFileSync(tool, '#!/bin/sh\necho "Speech segment 0: start = 100.00, end = 250.00"\n');
  chmodSync(tool, 0o755);
  expect(await detectSpeechRegions('/x.wav', tool, model)).toEqual([{ start: 1, end: 2.5 }]);
  writeFileSync(tool, '#!/bin/sh\nexit 3\n');
  expect(await detectSpeechRegions('/x.wav', tool, model)).toBeUndefined();
  expect(await detectSpeechRegions('/x.wav', join(root, 'missing'), model)).toBeUndefined();
});

/** Steady hiss over `seconds`, except digital silence for half a second at each of `quiet`. */
function hiss(seconds: number, quiet: number[]): Int16Array {
  const pcm = new Int16Array(seconds * 16_000).map((_, index) => (index % 2 ? 300 : -300));
  for (const at of quiet) pcm.fill(0, Math.round((at - 0.25) * 16_000), Math.round((at + 0.25) * 16_000));
  return pcm;
}

test('a long track is cut at its quietest moment near each even split, on Silero’s frame grid', () => {
  const cuts = quietCuts(hiss(600, [146, 302, 457]));
  expect(cuts).toHaveLength(3);
  for (const [index, at] of [146, 302, 457].entries()) {
    expect(cuts[index]! % 512).toBe(0);
    expect(Math.abs(cuts[index]! / 16_000 - at)).toBeLessThan(0.02);
  }
  expect(quietCuts(hiss(239, []))).toEqual([]);
  expect(quietCuts(hiss(360, [175]))).toHaveLength(2);
});

test('each piece of a long track is read, and its regions put back on the track’s clock', async () => {
  const root = directory();
  const path = join(root, 'long.wav');
  writeFileSync(path, wav(hiss(600, [146, 302, 457])));
  const cuts = quietCuts(hiss(600, [146, 302, 457])).map((cut) => cut / 16_000);
  const tool = join(root, 'tool');
  const model = join(root, 'model');
  writeFileSync(model, '');
  writeFileSync(tool, `#!/bin/sh\necho "$2" >> '${join(root, 'pieces.log')}'\necho "Speech segment 0: start = 100.00, end = 250.00"\n`);
  chmodSync(tool, 0o755);
  const regions = await detectSpeechRegions(path, tool, model);
  expect(regions?.map((region) => [region.start, region.end].map((time) => Math.round(time * 1000) / 1000)))
    .toEqual([0, ...cuts].map((offset) => [offset + 1, offset + 2.5].map((time) => Math.round(time * 1000) / 1000)));
  expect(readFileSync(join(root, 'pieces.log'), 'utf8').trim().split('\n')).toHaveLength(4);

  writeFileSync(tool, `#!/bin/sh\ncase "$2" in *2.wav) exit 3 ;; esac\necho "Speech segment 0: start = 100.00, end = 250.00"\n`);
  expect(await detectSpeechRegions(path, tool, model)).toBeUndefined();
});

test('the live server only gets speech detection when its model is there', () => {
  expect(liveSpeechGateArguments('/m.bin', () => true)).toEqual(['--vad', '-vm', '/m.bin']);
  expect(liveSpeechGateArguments('/m.bin', () => false)).toEqual([]);
});
