import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  beginManagedProcessSession,
  trackChildProcess,
  trackTempDirectory,
} from './process-lifecycle.ts';
import { DEFAULT_WHISPER_MODEL_FILENAME } from './model-config.ts';
import { finalTranscriptionThreads, transcriptionHardware, transcriptionUsesGpu, type TranscriptionHardware } from './local-asr-profile.ts';
import { detectSpeechRegions, dropPhantomUnits, type SpeechRegion } from './speech-gate.ts';
import { packSpeech, unpackUnits, type SpeechPacking } from './speech-packing.ts';
import type { TimedTranscriptUnit } from './transcript-types.ts';
import { defaultWhisperPrompt, whisperPromptTokens } from './vocabulary.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..');
const WHISPER_CLI = join(PROJECT_ROOT, 'whisper.cpp/build/bin/whisper-cli');
const MODEL_PATH = join(PROJECT_ROOT, 'models', DEFAULT_WHISPER_MODEL_FILENAME);

interface WhisperJsonToken {
  text?: unknown;
  t_dtw?: unknown;
  offsets?: {
    from?: unknown;
    to?: unknown;
  };
}

interface WhisperJsonSegment {
  text?: unknown;
  offsets?: {
    from?: unknown;
    to?: unknown;
  };
  tokens?: unknown;
}

interface WhisperJsonDocument {
  transcription?: unknown;
}

function milliseconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value / 1000 : undefined;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * How long a word with no usable offsets is taken to last before its DTW
 * anchor: a typical word. On AMI anything from 0.05 to 0.6 s timed words alike,
 * because the previous word's anchor bounds all but a segment's first word.
 */
const UNKNOWN_WORD_SECONDS = 0.3;

function isSpecialToken(text: string): boolean {
  const trimmed = text.trim();
  return /^\[_.*\]$/u.test(trimmed) || /^<\|.*\|>$/u.test(trimmed);
}

/** A word being read from its tokens. Offsets are unknown when every token's were reversed. */
interface WordDraft {
  text: string;
  start?: number;
  end?: number;
  dtwAnchors: number[];
}

function timedTokens(segment: WhisperJsonSegment): TimedTranscriptUnit[] {
  if (!Array.isArray(segment.tokens)) return [];

  const units: TimedTranscriptUnit[] = [];
  let current: WordDraft | undefined;
  let missingLexicalTiming = false;
  const segmentStart = milliseconds(segment.offsets?.from) ?? 0;
  const segmentEnd = milliseconds(segment.offsets?.to);
  // Never clamp a different clock into the segment's start. Some Whisper CLI
  // versions emit VAD-compressed tokens beside original-timeline segments.
  // Retain complete segment text if lexical anchors reveal that inconsistency.
  let previousAnchor = -Infinity;
  for (const raw of segment.tokens) {
    if (!raw || typeof raw !== 'object') continue;
    const token = raw as WhisperJsonToken;
    if (typeof token.text !== 'string' || isSpecialToken(token.text) || !/[\p{L}\p{N}]/u.test(token.text)) continue;
    const anchor = typeof token.t_dtw === 'number' && Number.isFinite(token.t_dtw) && token.t_dtw >= 0
      ? token.t_dtw / 100 : undefined;
    const from = milliseconds(token.offsets?.from), to = milliseconds(token.offsets?.to);
    if (anchor !== undefined) {
      if (anchor < segmentStart - .1 || (segmentEnd !== undefined && anchor > segmentEnd + .1) || anchor < previousAnchor) return [];
      previousAnchor = anchor;
    } else if (from !== undefined && to !== undefined &&
        (from < segmentStart - .1 || (segmentEnd !== undefined && to > segmentEnd + .1))) return [];
  }

  const flush = () => {
    if (current && current.text.trim()) {
      const { dtwAnchors, start, end } = current;
      const unit: TimedTranscriptUnit = { start: start ?? segmentStart, end: end ?? segmentStart, text: current.text.trim() };

      if (dtwAnchors.length > 0) {
        const firstAnchor = dtwAnchors[0]!;
        const lastAnchor = dtwAnchors.at(-1)!;
        // A word with no usable offsets still starts no earlier than the
        // previous word's anchor or its segment, which bound it below.
        const heuristicDuration = start === undefined || end === undefined ? UNKNOWN_WORD_SECONDS : Math.min(
          1.5,
          Math.max(0.05, end - start),
        );
        unit.start = roundSeconds(
          Math.max(segmentStart, firstAnchor - heuristicDuration),
        );
        const previousAnchor = units.at(-1)?.anchor;
        if (previousAnchor !== undefined) {
          unit.start = Math.max(unit.start, previousAnchor);
        }
        unit.end = Math.max(unit.start, roundSeconds(lastAnchor));
        if (segmentEnd !== undefined) {
          unit.end = Math.max(unit.start, Math.min(unit.end, segmentEnd));
        }
        unit.anchor = roundSeconds(firstAnchor);
      } else if (start === undefined || end === undefined) {
        missingLexicalTiming = true;
      }

      units.push(unit);
    }
    current = undefined;
  };

  for (const candidate of segment.tokens) {
    if (!candidate || typeof candidate !== 'object') continue;
    const token = candidate as WhisperJsonToken;
    if (typeof token.text !== 'string' || isSpecialToken(token.text)) continue;

    const start = milliseconds(token.offsets?.from);
    const end = milliseconds(token.offsets?.to);
    const lexical = /[\p{L}\p{N}]/u.test(token.text);
    // Punctuation may be aligned far into the following silence. Fold its text
    // into the word, but only lexical tokens may extend that word's DTW span.
    const dtwAnchor = lexical && typeof token.t_dtw === 'number' &&
      Number.isFinite(token.t_dtw) &&
      token.t_dtw >= 0
      ? token.t_dtw / 100
      : undefined;
    // whisper.cpp's energy heuristic can end a token before it starts, often
    // for every later segment in a 30-second window. Its DTW anchor still times
    // the word, and punctuation only lends its text, so keep both.
    const reversed = start !== undefined && end !== undefined && end < start;
    if (start === undefined || end === undefined || (reversed && lexical && dtwAnchor === undefined)) {
      if (token.text.trim()) missingLexicalTiming = true;
      continue;
    }

    const startsNewWord = /^\s/u.test(token.text);
    if (startsNewWord && current) flush();

    if (!current) {
      current = {
        ...(reversed ? {} : { start, end }),
        text: token.text,
        dtwAnchors: dtwAnchor === undefined ? [] : [dtwAnchor],
      };
    } else {
      if (!reversed) {
        current.start ??= start;
        current.end = Math.max(current.end ?? end, end);
      }
      current.text += token.text;
      if (dtwAnchor !== undefined) current.dtwAnchors.push(dtwAnchor);
    }
  }

  flush();
  return missingLexicalTiming ? [] : units;
}

/**
 * Convert whisper.cpp full JSON into word-like timed units. Whisper exposes
 * timestamped BPE tokens, so adjacent token pieces and punctuation are folded
 * into the word that started with leading whitespace.
 */
export function timedUnitsFromWhisperJson(value: unknown): TimedTranscriptUnit[] {
  if (!value || typeof value !== 'object') {
    throw new Error('whisper.cpp returned invalid JSON');
  }

  const document = value as WhisperJsonDocument;
  if (!Array.isArray(document.transcription)) {
    throw new Error('whisper.cpp JSON is missing transcription segments');
  }

  const units: TimedTranscriptUnit[] = [];
  for (const candidate of document.transcription) {
    if (!candidate || typeof candidate !== 'object') continue;
    const segment = candidate as WhisperJsonSegment;
    const tokens = timedTokens(segment);
    if (tokens.length > 0) {
      units.push(...tokens);
      continue;
    }

    const start = milliseconds(segment.offsets?.from);
    const end = milliseconds(segment.offsets?.to);
    if (
      typeof segment.text === 'string' &&
      segment.text.trim() &&
      start !== undefined &&
      end !== undefined &&
      end >= start
    ) {
      units.push({ start, end, text: segment.text.trim() });
    }
  }

  return units;
}

export interface TimestampTranscriptionOptions {
  onProgress?: (percentage: number) => void;
  onFallback?: (message: string) => void;
  /** Test seams: the whisper.cpp build and model, the Mac to size the run for, and speech detection. */
  whisperCli?: string;
  modelPath?: string;
  hardware?: TranscriptionHardware;
  detectSpeech?: (wavPath: string) => Promise<SpeechRegion[] | undefined>;
  /** Spellings to prefer, as Whisper's initial prompt (vocabulary.ts). Unset: the owner's vocabulary; empty: none. */
  prompt?: string;
}

/** whisper.cpp started and then failed; spawn failures are plain errors. */
class WhisperExecutionError extends Error {}

/**
 * Canonical detailed transcription path for all file-based workflows.
 */
export async function transcribeWithTimestamps(
  filePath: string,
  options: TimestampTranscriptionOptions = {},
): Promise<TimedTranscriptUnit[]> {
  const whisperCli = options.whisperCli ?? WHISPER_CLI;
  const modelPath = options.modelPath ?? MODEL_PATH;
  const hardware = options.hardware ?? transcriptionHardware();
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!existsSync(whisperCli)) {
    throw new Error('whisper.cpp is not built. Run ./install.sh first.');
  }
  if (!existsSync(modelPath)) {
    throw new Error('Whisper model is missing. Run ./install.sh first.');
  }

  const endManagedSession = beginManagedProcessSession();
  let tempDirectory: string;
  try {
    tempDirectory = mkdtempSync(join(tmpdir(), 'seashell-whisper-'));
  } catch (error) {
    endManagedSession();
    throw error;
  }
  const stopTrackingTemp = trackTempDirectory(tempDirectory);
  const prompt = options.prompt ?? defaultWhisperPrompt();
  const outputBase = join(tempDirectory, 'transcript');
  const outputJson = `${outputBase}.json`;
  const packedPath = join(tempDirectory, 'speech.wav');

  try {
    // Speech detection comes first: Whisper hears only the speech it finds,
    // and the phantom-word check reuses the same regions afterwards.
    const speech = await (options.detectSpeech ?? detectSpeechRegions)(filePath);
    let packing: SpeechPacking | undefined;
    try {
      packing = speech && packSpeech(filePath, speech, packedPath);
    } catch {
      // A track that can't be packed is transcribed whole, as before.
      packing = undefined;
    }
    const audioPath = packing ? packedPath : filePath;

    const runWhisper = (disableGpu: boolean) => new Promise<void>((resolve, reject) => {
      const proc = spawn(whisperCli, [
        ...(disableGpu ? ['-ng'] : []),
        '-m', modelPath,
        '-f', audioPath,
        '-l', 'en',
        '-t', String(finalTranscriptionThreads(hardware)),
        // Do not combine canonical word timestamps with --vad: our pinned CLI
        // maps segment times but emits token/DTW times on compressed audio
        // (ggml-org/whisper.cpp#4046). speech-packing.ts does that job instead,
        // and maps every time back. Live draft VAD is independent of this path.
        // Flash attention must be off for DTW in this build.
        '-nfa',
        '-dtw', 'large.v3.turbo',
        '-np',
        '-pp',
        // No earlier text conditions the next window: past text sets Whisper
        // repeating itself. The vocabulary prompt goes to every window instead,
        // with room for about its own tokens and little else (see vocabulary.ts).
        '-mc', String(prompt ? whisperPromptTokens(prompt) : 0),
        ...(prompt ? ['--carry-initial-prompt', '--prompt', prompt] : []),
        '-ojf',
        '-of', outputBase,
      ], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const stopTrackingChild = trackChildProcess(proc);

      let stderr = '';
      let settled = false;

      proc.stderr?.on('data', (data) => {
        const text = data.toString();
        stderr = (stderr + text).slice(-8000);
        const match = text.match(/progress\s*=\s*(\d+)%/u);
        if (match?.[1]) options.onProgress?.(Number.parseInt(match[1], 10));
      });

      proc.on('error', (error) => {
        stopTrackingChild();
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to start whisper.cpp: ${error.message}`));
      });

      proc.on('close', (code, signal) => {
        stopTrackingChild();
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const reason = signal ? `signal ${signal}` : `exit ${code}`;
          reject(new WhisperExecutionError(
            `whisper.cpp failed (${reason}): ${stderr.trim() || 'no details'}`,
          ));
          return;
        }
        resolve();
      });
    });

    const forceCpu = !transcriptionUsesGpu(hardware);
    try {
      await runWhisper(forceCpu);
    } catch (error) {
      // A GPU run can crash, or stop before transcribing with no reason given
      // ("failed to initialize whisper context"). Either way, retry on the CPU.
      if (!forceCpu && error instanceof WhisperExecutionError) {
        rmSync(outputJson, { force: true });
        options.onFallback?.('Metal transcription failed; retrying on CPU…');
        await runWhisper(true);
      } else {
        throw error;
      }
    }

    if (!existsSync(outputJson)) {
      throw new Error('whisper.cpp completed without writing timestamp JSON');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(outputJson, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not parse whisper.cpp timestamp JSON: ${message}`);
    }

    const units = timedUnitsFromWhisperJson(parsed);
    // The phantom check runs on the track's own clock, against its own audio.
    return await dropPhantomUnits(packing ? unpackUnits(units, packing) : units, filePath, async () => speech);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
    stopTrackingTemp();
    endManagedSession();
  }
}
