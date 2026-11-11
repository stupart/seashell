import { expect, test } from 'bun:test';
import {
  finalTranscriptionThreads,
  liveTranscriptionThreads,
  parseStoredLocalAsrProfile,
  readTranscriptionHardware,
  transcriptionUsesGpu,
} from '../src/local-asr-profile.ts';

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

const sysctl = (values: Record<string, string>) => (names: readonly string[]) =>
  Object.fromEntries(names.flatMap((name) => values[name] === undefined ? [] : [[name, values[name]!]]));
const appleSilicon = (levels: Array<[string, number]>, memoryGb = 16) => sysctl({
  'hw.optional.arm64': '1', 'hw.memsize': String(memoryGb * 2 ** 30), 'hw.nperflevels': String(levels.length),
  'hw.physicalcpu': String(levels.reduce((total, [, cores]) => total + cores, 0)),
  ...Object.fromEntries(levels.flatMap(([name, cores], level) => [
    [`hw.perflevel${level}.name`, name], [`hw.perflevel${level}.physicalcpu`, String(cores)],
  ])),
});

test('transcription threads follow the fast cores, never efficiency cores, up to eight', () => {
  const cases: Array<[string, ReturnType<typeof sysctl>, number, number, boolean]> = [
    ['M1, 4 performance + 4 efficiency', appleSilicon([['Performance', 4], ['Efficiency', 4]], 8), 4, 4, true],
    ['M3 Pro, 6 + 6', appleSilicon([['Performance', 6], ['Efficiency', 6]]), 6, 4, true],
    ['M4 Pro, 10 + 4', appleSilicon([['Performance', 10], ['Efficiency', 4]]), 8, 4, true],
    ['M5 Max, 6 super + 12 performance', appleSilicon([['Super', 6], ['Performance', 12]], 128), 8, 4, true],
    ['Intel quad-core i7', sysctl({ 'hw.optional.arm64': '0', 'hw.physicalcpu': '4', 'hw.memsize': String(16 * 2 ** 30) }), 4, 4, false],
    ['Intel dual-core i5', sysctl({ 'hw.physicalcpu': '2', 'hw.memsize': String(8 * 2 ** 30) }), 2, 2, false],
  ];
  for (const [name, read, final, live, gpu] of cases) {
    const hardware = readTranscriptionHardware(read);
    expect({ name, final: finalTranscriptionThreads(hardware), live: liveTranscriptionThreads(hardware), gpu: transcriptionUsesGpu(hardware, {}) })
      .toEqual({ name, final, live, gpu });
  }
});

test('core types without names count only the fastest, as on early Apple Silicon releases', () => {
  const hardware = readTranscriptionHardware(sysctl({
    'hw.optional.arm64': '1', 'hw.physicalcpu': '8', 'hw.nperflevels': '2',
    'hw.perflevel0.physicalcpu': '4', 'hw.perflevel1.physicalcpu': '4', 'hw.memsize': String(8 * 2 ** 30),
  }));
  expect(hardware).toEqual({ appleSilicon: true, performanceCores: 4, memoryBytes: 8 * 2 ** 30 });
});

test('unreadable hardware still gives a working thread count, and the GPU can be turned off', () => {
  const hardware = readTranscriptionHardware(() => ({}));
  expect(hardware.appleSilicon).toBe(false);
  expect(finalTranscriptionThreads(hardware)).toBeGreaterThanOrEqual(1);
  expect(finalTranscriptionThreads(hardware)).toBeLessThanOrEqual(8);
  const mac = readTranscriptionHardware(appleSilicon([['Performance', 4], ['Efficiency', 4]]));
  expect(transcriptionUsesGpu(mac, {})).toBe(true);
  expect(transcriptionUsesGpu(mac, { SEASHELL_DISABLE_GPU: '1' })).toBe(false);
});

test('this Mac reports its cores', () => {
  const hardware = readTranscriptionHardware();
  expect(hardware.performanceCores).toBeGreaterThanOrEqual(1);
  expect(hardware.memoryBytes).toBeGreaterThan(2 ** 30);
});
