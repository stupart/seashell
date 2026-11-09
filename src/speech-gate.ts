import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_VAD_MODEL_FILENAME } from './model-config.ts';
import { trackChildProcess } from './process-lifecycle.ts';
import type { TimedTranscriptUnit } from './transcript-types.ts';

/**
 * Whisper invents words over silence: "Thank you", "Okay". On real meetings the
 * invented lines sat at or near digital silence while speech sat around -20 dB.
 *
 * Silero speech detection decides what is speech. For the final transcript, these
 * settings kept all 12,116 hand-labelled words on three AMI meetings, including 998
 * short replies such as "okay"; its defaults lost 1.1% of words and 3.2% of those.
 */
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEECH_TOOL = join(PROJECT_ROOT, 'whisper.cpp', 'build', 'bin', 'whisper-vad-speech-segments');
export const SPEECH_MODEL = join(PROJECT_ROOT, 'whisper.cpp', 'models', DEFAULT_VAD_MODEL_FILENAME);

const MIN_SPEECH_MS = '100';
const SPEECH_PAD_MS = '200';
const TOOL_TIMEOUT_MS = 5 * 60_000;
/** A word this much inside detected speech is speech. */
const TOUCH_SECONDS = 0.03;
/**
 * Detection alone also flagged lines at normal speaking volume, up to -13 dB. So
 * a line goes only when it is quiet as well: losing real words is the worse error.
 */
const QUIET_DBFS = -38;
const FRAME_SECONDS = 0.02;
const SHORTEST_WINDOW_SECONDS = 0.2;

export interface SpeechRegion {
  readonly start: number;
  readonly end: number;
}

/**
 * Flags that make the live Whisper server skip chunks with no speech in them.
 * Silero's defaults, unlike the final pass: there is no loudness check here, and
 * on a real call the looser settings let more noise through (60% of phantom lines
 * removed against 66%). Neither lost a real chunk, and the final pass replaces this.
 */
export function liveSpeechGateArguments(model = SPEECH_MODEL, exists: (path: string) => boolean = existsSync): string[] {
  return exists(model) ? ['--vad', '-vm', model] : [];
}

/** The tool prints "Speech segment 0: start = 2320.00, end = 2493.00", in centiseconds. */
export function parseSpeechRegions(output: string): SpeechRegion[] {
  return [...output.matchAll(/start\s*=\s*([\d.]+),\s*end\s*=\s*([\d.]+)/gu)]
    .map((match) => ({ start: Number(match[1]) / 100, end: Number(match[2]) / 100 }))
    .toSorted((left, right) => left.start - right.start);
}

/** Undefined when detection is unavailable or fails, which leaves the transcript alone. */
export function detectSpeechRegions(
  wavPath: string,
  tool = SPEECH_TOOL,
  model = SPEECH_MODEL,
): Promise<SpeechRegion[] | undefined> {
  if (!existsSync(tool) || !existsSync(model)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn(tool, ['-f', wavPath, '-vm', model, '-np', '-t', '2', '-vspd', MIN_SPEECH_MS, '-vp', SPEECH_PAD_MS],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const stopTracking = trackChildProcess(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), TOOL_TIMEOUT_MS);
    let output = '';
    child.stdout?.on('data', (data) => { output += data.toString(); });
    const finish = (regions: SpeechRegion[] | undefined) => { clearTimeout(timer); stopTracking(); resolve(regions); };
    child.once('error', () => finish(undefined));
    child.once('close', (code) => finish(code === 0 ? parseSpeechRegions(output) : undefined));
  });
}

/** 16 kHz mono PCM from a WAV, or undefined for any other shape. */
export function readMonoPcm(wav: Buffer): Int16Array | undefined {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let offset = 12, valid = false;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= wav.length) {
      valid = wav.readUInt16LE(body) === 1 && wav.readUInt16LE(body + 2) === 1 &&
        wav.readUInt32LE(body + 4) === 16_000 && wav.readUInt16LE(body + 14) === 16;
    } else if (id === 'data') {
      if (!valid) return undefined;
      const end = Math.min(wav.length, body + size);
      const copy = wav.subarray(body, end - ((end - body) % 2));
      return new Int16Array(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.length));
    }
    offset = body + size + (size % 2);
  }
  return undefined;
}

/** How loud a span gets: the 95th percentile of its 20 ms frames. */
export function peakFrameDbfs(pcm: Int16Array, start: number, end: number, sampleRate = 16_000): number {
  const middle = (start + end) / 2;
  const half = Math.max(end - start, SHORTEST_WINDOW_SECONDS) / 2;
  const first = Math.max(0, Math.floor((middle - half) * sampleRate));
  const last = Math.min(pcm.length, Math.ceil((middle + half) * sampleRate));
  const frame = Math.round(FRAME_SECONDS * sampleRate);
  const levels: number[] = [];
  for (let position = first; position < last; position += frame) {
    let sum = 0;
    const stop = Math.min(last, position + frame);
    for (let index = position; index < stop; index += 1) sum += pcm[index]! * pcm[index]!;
    levels.push(Math.sqrt(sum / Math.max(1, stop - position)));
  }
  if (!levels.length) return -Infinity;
  const loud = levels.toSorted((left, right) => left - right)[Math.floor(levels.length * 0.95)]!;
  return loud > 0 ? 20 * Math.log10(loud / 32_768) : -Infinity;
}

function speechOverlap(start: number, end: number, regions: readonly SpeechRegion[]): number {
  let total = 0;
  for (const region of regions) {
    if (region.start >= end) break;
    if (region.end > start) total += Math.min(end, region.end) - Math.max(start, region.start);
  }
  return total;
}

export function isPhantomUnit(unit: Pick<TimedTranscriptUnit, 'start' | 'end'>, regions: readonly SpeechRegion[], pcm: Int16Array): boolean {
  // Zero-length timings still have to touch speech, so give them a little width.
  const end = Math.max(unit.end, unit.start + TOUCH_SECONDS);
  return speechOverlap(unit.start, end, regions) < TOUCH_SECONDS && peakFrameDbfs(pcm, unit.start, end) < QUIET_DBFS;
}

/** Remove what Whisper heard in silence. Without detection or a readable WAV, nothing changes. */
export async function dropPhantomUnits<T extends TimedTranscriptUnit>(
  units: T[],
  wavPath: string,
  detect: (path: string) => Promise<SpeechRegion[] | undefined> = detectSpeechRegions,
): Promise<T[]> {
  if (!units.length) return units;
  const regions = await detect(wavPath);
  if (!regions) return units;
  let pcm: Int16Array | undefined;
  try { pcm = readMonoPcm(readFileSync(wavPath)); } catch { return units; }
  if (!pcm) return units;
  const audio = pcm;
  return units.filter((unit) => !isPhantomUnit(unit, regions, audio));
}
