import { afterEach, describe, expect, test } from 'bun:test';
import { transcribeWithTimestamps, timedUnitsFromWhisperJson } from '../src/whisper-timestamps.ts';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import type { TranscriptionHardware } from '../src/local-asr-profile.ts';

describe('timedUnitsFromWhisperJson', () => {
  test('real VAD mixed-clock output preserves whole sentences instead of collapsing words at the segment start', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/whisper-vad-mixed-clock.json', import.meta.url), 'utf8'));
    const units = timedUnitsFromWhisperJson(raw);
    expect(units).toHaveLength(raw.transcription.length);
    for (const [i, unit] of units.entries()) {
      const segment = raw.transcription[i];
      expect(unit).toEqual({ start: segment.offsets.from / 1000, end: segment.offsets.to / 1000, text: segment.text.trim() });
      expect(unit.end - unit.start).toBeGreaterThan(4);
    }
  });

  test('punctuation preserves text without extending a word into subsequent silence', () => {
    expect(timedUnitsFromWhisperJson({ transcription: [{ offsets: { from: 0, to: 7000 }, text: ' release notes.', tokens: [
      { text: ' release', offsets: { from: 4260, to: 4600 }, t_dtw: 460 },
      { text: ' notes', offsets: { from: 4600, to: 5000 }, t_dtw: 504 },
      { text: '.', offsets: { from: 5000, to: 6520 }, t_dtw: 652 },
    ] }] })).toEqual([
      { start: 4.26, end: 4.6, anchor: 4.6, text: 'release' },
      { start: 4.6, end: 5.04, anchor: 5.04, text: 'notes.' },
    ]);
  });

  test('raw token clock mismatches and regressing anchors fall back without dropping text', () => {
    for (const tokens of [
      [{ text: ' Later', offsets: { from: 10, to: 500 }, t_dtw: -1 }],
      [{ text: ' Later', offsets: { from: 10000, to: 10500 }, t_dtw: 1050 },
        { text: ' words.', offsets: { from: 10500, to: 11000 }, t_dtw: 1040 }],
    ]) expect(timedUnitsFromWhisperJson({ transcription: [{ offsets: { from: 10000, to: 12000 }, text: ' Later words.', tokens }] }))
      .toEqual([{ start: 10, end: 12, text: 'Later words.' }]);
  });

  test('filters special tokens and folds BPE pieces and punctuation into words', () => {
    const result = timedUnitsFromWhisperJson({
      transcription: [
        {
          offsets: { from: 0, to: 1000 },
          text: ' Hello, transcription!',
          tokens: [
            { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
            { text: ' Hello', offsets: { from: 100, to: 300 } },
            { text: ',', offsets: { from: 300, to: 350 } },
            { text: ' trans', offsets: { from: 400, to: 600 } },
            { text: 'cription', offsets: { from: 600, to: 900 } },
            { text: '!', offsets: { from: 900, to: 950 } },
            { text: '[_TT_50]', offsets: { from: 950, to: 950 } },
          ],
        },
      ],
    });

    expect(result).toEqual([
      { start: 0.1, end: 0.35, text: 'Hello,' },
      { start: 0.4, end: 0.95, text: 'transcription!' },
    ]);
  });

  test('falls back to segment timestamps when token timings are absent', () => {
    expect(timedUnitsFromWhisperJson({
      transcription: [
        {
          offsets: { from: 1250, to: 2500 },
          text: ' Segment fallback. ',
        },
      ],
    })).toEqual([
      { start: 1.25, end: 2.5, text: 'Segment fallback.' },
    ]);
  });

  test('uses DTW centisecond anchors instead of silence-smeared offsets', () => {
    expect(timedUnitsFromWhisperJson({
      transcription: [
        {
          offsets: { from: 10000, to: 25000 },
          text: ' And so',
          tokens: [
            {
              text: ' And',
              offsets: { from: 10320, to: 10550 },
              t_dtw: 1450,
            },
            {
              text: ' so',
              offsets: { from: 10680, to: 10910 },
              t_dtw: 1486,
            },
          ],
        },
      ],
    })).toEqual([
      { start: 14.27, end: 14.5, anchor: 14.5, text: 'And' },
      { start: 14.63, end: 14.86, anchor: 14.86, text: 'so' },
    ]);
  });

  test('words keep their DTW timing when whisper.cpp ends a token before it starts', () => {
    expect(timedUnitsFromWhisperJson({ transcription: [{ offsets: { from: 12460, to: 15000 }, text: ' Made up words.', tokens: [
      { text: ' Made', offsets: { from: 12460, to: 11040 }, t_dtw: 1320 },
      { text: ' up', offsets: { from: 12460, to: 11310 }, t_dtw: 1354 },
      { text: ' words', offsets: { from: 13050, to: 13860 }, t_dtw: 1482 },
      { text: '.', offsets: { from: 13860, to: 13500 }, t_dtw: 1500 },
    ] }] })).toEqual([
      { start: 12.9, end: 13.2, anchor: 13.2, text: 'Made' },
      { start: 13.24, end: 13.54, anchor: 13.54, text: 'up' },
      { start: 14.01, end: 14.82, anchor: 14.82, text: 'words.' },
    ]);
  });

  test('a reversed word with no DTW timing falls back to its segment', () => {
    expect(timedUnitsFromWhisperJson({ transcription: [{ offsets: { from: 12460, to: 15000 }, text: ' Made up.', tokens: [
      { text: ' Made', offsets: { from: 12460, to: 11040 } },
      { text: ' up.', offsets: { from: 13050, to: 13860 } },
    ] }] })).toEqual([{ start: 12.46, end: 15, text: 'Made up.' }]);
  });

  test('falls back to complete segment text rather than dropping an untimed token', () => {
    expect(timedUnitsFromWhisperJson({
      transcription: [
        {
          offsets: { from: 0, to: 1000 },
          text: ' Keep every word.',
          tokens: [
            { text: ' Keep', offsets: { from: 0, to: 300 } },
            { text: ' every' },
            { text: ' word.', offsets: { from: 600, to: 1000 } },
          ],
        },
      ],
    })).toEqual([
      { start: 0, end: 1, text: 'Keep every word.' },
    ]);
  });
});

describe('transcribeWithTimestamps', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  /** A stand-in whisper-cli that logs its arguments and can fail whenever the GPU is used. */
  function fakeWhisper(failOnGpu: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'seashell-fake-whisper-'));
    roots.push(root);
    const cli = join(root, 'whisper-cli');
    const calls = join(root, 'calls.log');
    writeFileSync(cli, `#!/bin/sh
echo "$*" >> '${calls}'
case " $* " in *" -ng "*) gpu=0 ;; *) gpu=1 ;; esac
if [ "$gpu" = 1 ] && [ ${failOnGpu ? 1 : 0} = 1 ]; then echo 'error: failed to initialize whisper context' >&2; exit 3; fi
while [ $# -gt 0 ]; do [ "$1" = -of ] && out="$2"; shift; done
printf '%s' '{"transcription":[{"text":" Made-up words.","offsets":{"from":0,"to":900}}]}' > "$out.json"
`);
    chmodSync(cli, 0o755);
    const model = join(root, 'model.bin');
    writeFileSync(model, '');
    // A loud tone, so no speech check can mistake the words for silence.
    const pcm = Buffer.alloc(16_000 * 2);
    for (let index = 0; index < 16_000; index++) pcm.writeInt16LE(Math.round(Math.sin(index / 8) * 16_000), index * 2);
    const audio = join(root, 'audio.wav');
    writeFileSync(audio, pcmS16leToWav(pcm));
    return { cli, model, audio, calls: () => readFileSync(calls, 'utf8').trim().split('\n') };
  }
  const mac: TranscriptionHardware = { appleSilicon: true, performanceCores: 6, memoryBytes: 16 * 2 ** 30 };
  const intel: TranscriptionHardware = { appleSilicon: false, performanceCores: 4, memoryBytes: 8 * 2 ** 30 };

  test('a Metal run that exits with an error is retried once on the CPU', async () => {
    const whisper = fakeWhisper(true);
    const fallbacks: string[] = [];
    const units = await transcribeWithTimestamps(whisper.audio, {
      whisperCli: whisper.cli, modelPath: whisper.model, hardware: mac, onFallback: (message) => fallbacks.push(message),
    });
    expect(units.map((unit) => unit.text)).toEqual(['Made-up words.']);
    expect(fallbacks).toEqual(['Metal transcription failed; retrying on CPU…']);
    const [gpu, cpu] = whisper.calls();
    expect(gpu).not.toContain('-ng');
    expect(gpu).toContain('-t 6');
    expect(cpu).toStartWith('-ng ');
  });

  test('an Intel Mac transcribes on the CPU with one thread per physical core', async () => {
    const whisper = fakeWhisper(true);
    const fallbacks: string[] = [];
    await transcribeWithTimestamps(whisper.audio, {
      whisperCli: whisper.cli, modelPath: whisper.model, hardware: intel, onFallback: (message) => fallbacks.push(message),
    });
    expect(fallbacks).toEqual([]);
    expect(whisper.calls()).toHaveLength(1);
    expect(whisper.calls()[0]).toStartWith('-ng ');
    expect(whisper.calls()[0]).toContain('-t 4');
  });
});
