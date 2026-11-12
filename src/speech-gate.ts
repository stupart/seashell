import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pcmS16leToWav } from './live-system-audio.ts';
import { DEFAULT_VAD_MODEL_FILENAME } from './model-config.ts';
import { trackChildProcess, trackTempDirectory } from './process-lifecycle.ts';
import { inferenceCommand } from './inference-priority.ts';
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
/**
 * Silero is a recurrent model, so a run uses one core however many threads it
 * gets: 25 minutes took 3 to 4 seconds, and more threads only made it slower.
 * A long track is cut into pieces of at least this length, read at once.
 */
const DETECTION_PIECE_SECONDS = 120;
const MAX_DETECTION_PIECES = 4;
/** Each cut goes at the quietest half second this close to an even split. */
const CUT_SEARCH_SECONDS = 10;
const CUT_WINDOW_SECONDS = 0.5;
const CUT_STEP_SECONDS = 0.05;
/** Silero reads 512-sample frames; a cut off that grid shifts every region after it. */
const SILERO_FRAME_SAMPLES = 512;

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

function runSpeechTool(wavPath: string, tool: string, model: string): Promise<SpeechRegion[] | undefined> {
  return new Promise((resolve) => {
    const run = inferenceCommand(tool, ['-f', wavPath, '-vm', model, '-np', '-t', '1', '-vspd', MIN_SPEECH_MS, '-vp', SPEECH_PAD_MS], 'background');
    const child = spawn(run.command, run.args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const stopTracking = trackChildProcess(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), TOOL_TIMEOUT_MS);
    let output = '';
    child.stdout?.on('data', (data) => { output += data.toString(); });
    const finish = (regions: SpeechRegion[] | undefined) => { clearTimeout(timer); stopTracking(); resolve(regions); };
    child.once('error', () => finish(undefined));
    child.once('close', (code) => finish(code === 0 ? parseSpeechRegions(output) : undefined));
  });
}

/**
 * Where to cut a track into pieces for detection, as sample offsets: the middle
 * of the quietest half second near each even split, on Silero's frame grid, so
 * a piece starts in silence as the whole track does. On a sparse 25-minute
 * track the regions matched one long run's to the centisecond; on a busy AMI
 * meeting a few edges moved, and the phantom check judged every word the same.
 */
export function quietCuts(pcm: Int16Array, sampleRate = 16_000): number[] {
  const pieces = Math.min(MAX_DETECTION_PIECES, Math.floor(pcm.length / (DETECTION_PIECE_SECONDS * sampleRate)));
  const window = Math.round(CUT_WINDOW_SECONDS * sampleRate);
  const step = Math.round(CUT_STEP_SECONDS * sampleRate);
  const search = Math.round(CUT_SEARCH_SECONDS * sampleRate);
  const cuts: number[] = [];
  for (let piece = 1; piece < pieces; piece += 1) {
    const even = Math.round(pcm.length * piece / pieces);
    let quietest = even, lowest = Infinity;
    for (let first = even - search; first + window <= even + search; first += step) {
      let energy = 0;
      for (let index = first; index < first + window; index += 1) energy += pcm[index]! * pcm[index]!;
      if (energy < lowest) { lowest = energy; quietest = first + window / 2; }
    }
    cuts.push(Math.round(quietest / SILERO_FRAME_SAMPLES) * SILERO_FRAME_SAMPLES);
  }
  return cuts;
}

/** Undefined when detection is unavailable or fails, which leaves the transcript alone. */
export async function detectSpeechRegions(
  wavPath: string,
  tool = SPEECH_TOOL,
  model = SPEECH_MODEL,
): Promise<SpeechRegion[] | undefined> {
  if (!existsSync(tool) || !existsSync(model)) return undefined;
  let pcm: Int16Array | undefined;
  try { pcm = readMonoPcm(readFileSync(wavPath)); } catch { pcm = undefined; }
  const cuts = pcm ? quietCuts(pcm) : [];
  if (!pcm || !cuts.length) return await runSpeechTool(wavPath, tool, model);
  const audio = pcm;
  const directory = mkdtempSync(join(tmpdir(), 'seashell-speech-'));
  const stopTrackingTemp = trackTempDirectory(directory);
  try {
    const bounds = [0, ...cuts, audio.length];
    const pieces = await Promise.all(bounds.slice(1).map(async (end, index) => {
      const start = bounds[index]!;
      const path = join(directory, `${index}.wav`);
      writeFileSync(path, pcmS16leToWav(new Uint8Array(audio.buffer, audio.byteOffset + start * 2, (end - start) * 2)));
      const regions = await runSpeechTool(path, tool, model);
      return regions?.map((region) => ({ start: region.start + start / 16_000, end: region.end + start / 16_000 }));
    }));
    return pieces.some((regions) => regions === undefined) ? undefined : pieces.flatMap((regions) => regions ?? []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    stopTrackingTemp();
  }
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
