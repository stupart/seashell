import { readFileSync, writeFileSync } from 'fs';
import { pcmS16leToWav } from './live-system-audio.ts';
import { readMonoPcm, type SpeechRegion } from './speech-gate.ts';
import type { TimedTranscriptUnit } from './transcript-types.ts';

/**
 * Whisper takes as long over silence as over speech: on a sparse 25-minute call
 * track, 57% of its time went on silence. So the final pass cuts the silence
 * out, transcribes the speech packed together, and puts every time Whisper
 * reports back on the track's own clock.
 *
 * whisper.cpp's --vad packs audio too, but leaves word timings on the packed
 * clock (ggml-org/whisper.cpp#4046), so Seashell packs the audio itself.
 */
const SAMPLE_RATE = 16_000;
/** Kept either side of each speech region, beyond Silero's own 200 ms, so no word is clipped. */
const PAD_SECONDS = 0.4;
/** Regions closer than this stay together; cutting a short pause saves little. */
const JOIN_SECONDS = 1;
/** Digital silence between packed spans, so the end of one never runs into the next. */
const GAP_SECONDS = 1;
/** Above this share of the track, packing would save too little to be worth it. */
const MOST_OF_TRACK = 0.8;

export interface PackedSpan {
  /** Where the span starts on the track's clock, in seconds. */
  readonly track: number;
  /** Where it starts in the packed audio, in seconds. */
  readonly packed: number;
  readonly duration: number;
}

export interface SpeechPacking {
  /** In order on both clocks, with GAP_SECONDS of packed silence between neighbours. */
  readonly spans: readonly PackedSpan[];
  readonly trackSeconds: number;
}

/**
 * Which parts of a track to keep. Undefined when there is nothing to gain:
 * no speech was found, or speech covers most of the track.
 */
export function planSpeechPacking(
  regions: readonly SpeechRegion[],
  trackSamples: number,
  sampleRate = SAMPLE_RATE,
): SpeechPacking | undefined {
  const pad = Math.round(PAD_SECONDS * sampleRate);
  const join = Math.round(JOIN_SECONDS * sampleRate);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const region of regions.toSorted((left, right) => left.start - right.start)) {
    const start = Math.max(0, Math.round(region.start * sampleRate) - pad);
    const end = Math.min(trackSamples, Math.round(region.end * sampleRate) + pad);
    if (end <= start) continue;
    const last = ranges.at(-1);
    if (last && start - last.end < join) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  const kept = ranges.reduce((total, range) => total + range.end - range.start, 0);
  if (!ranges.length || kept > trackSamples * MOST_OF_TRACK) return undefined;
  const gap = Math.round(GAP_SECONDS * sampleRate);
  let packed = 0;
  const spans = ranges.map((range, index) => {
    if (index > 0) packed += gap;
    const span = { track: range.start / sampleRate, packed: packed / sampleRate, duration: (range.end - range.start) / sampleRate };
    packed += range.end - range.start;
    return span;
  });
  return { spans, trackSeconds: trackSamples / sampleRate };
}

/** The packed audio: each span's samples in order, digital silence between them. */
export function packedSpeechPcm(pcm: Int16Array, packing: SpeechPacking, sampleRate = SAMPLE_RATE): Int16Array {
  const last = packing.spans.at(-1);
  const packed = new Int16Array(last ? Math.round((last.packed + last.duration) * sampleRate) : 0);
  for (const span of packing.spans) {
    const start = Math.round(span.track * sampleRate);
    packed.set(pcm.subarray(start, start + Math.round(span.duration * sampleRate)), Math.round(span.packed * sampleRate));
  }
  return packed;
}

/**
 * Write the speech of a 16 kHz mono WAV, packed, to `destination`. Undefined,
 * with nothing written, when the track is better transcribed whole: it can't
 * be read, or packing would gain nothing.
 */
export function packSpeech(wavPath: string, regions: readonly SpeechRegion[], destination: string): SpeechPacking | undefined {
  const pcm = readMonoPcm(readFileSync(wavPath));
  const packing = pcm && planSpeechPacking(regions, pcm.length);
  if (!pcm || !packing) return undefined;
  const packed = packedSpeechPcm(pcm, packing);
  writeFileSync(destination, pcmS16leToWav(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength)));
  return packing;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The last span starting at or before a packed time. */
function spanAt(spans: readonly PackedSpan[], time: number): number {
  let low = 0, high = spans.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (spans[middle]!.packed <= time) low = middle; else high = middle - 1;
  }
  return low;
}

type Side = 'start' | 'end' | 'nearest';

/**
 * A packed time on the track's clock. Inside a span it moves by that span's
 * offset. In the silence after a span, which the track never had, a start
 * belongs to the next span's speech and an end to the previous span's.
 */
function trackTime(spans: readonly PackedSpan[], time: number, side: Side): number {
  const index = spanAt(spans, time);
  const span = spans[index]!;
  const end = span.track + span.duration;
  const offset = time - span.packed;
  if (offset <= 0) return span.track;
  if (offset <= span.duration) return span.track + offset;
  const next = spans[index + 1];
  if (!next) return end;
  if (side === 'nearest') return time - (span.packed + span.duration) < next.packed - time ? end : next.track;
  return side === 'start' ? next.track : end;
}

/** The span a packed time falls in the silence after, or past the last of; undefined inside a span. */
function inSilenceAfter(spans: readonly PackedSpan[], time: number): number | undefined {
  const index = spanAt(spans, time);
  const span = spans[index]!;
  return time > span.packed + span.duration ? index : undefined;
}

/**
 * Put Whisper's times on packed audio back on the track's clock. No time goes
 * below zero or past the track's end, no unit ends before it starts, and a
 * unit that straddles a cut covers the speech on both sides of it. A unit
 * wholly in packed silence lands at the nearer edge of real audio, with no length.
 */
export function unpackUnits<T extends TimedTranscriptUnit>(units: readonly T[], packing: SpeechPacking): T[] {
  const { spans, trackSeconds } = packing;
  if (!spans.length) return [...units];
  const clamp = (value: number) => roundSeconds(Math.min(trackSeconds, Math.max(0, value)));
  return units.map((unit) => {
    const silence = inSilenceAfter(spans, unit.start);
    const stranded = silence !== undefined && silence === inSilenceAfter(spans, unit.end);
    const start = stranded ? trackTime(spans, (unit.start + unit.end) / 2, 'nearest') : trackTime(spans, unit.start, 'start');
    const end = stranded ? start : Math.max(start, trackTime(spans, unit.end, 'end'));
    const mapped: T = { ...unit, start: clamp(start), end: clamp(end) };
    if (unit.anchor !== undefined) mapped.anchor = clamp(trackTime(spans, unit.anchor, 'nearest'));
    return mapped;
  });
}
