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
import {
  DEFAULT_VAD_MODEL_FILENAME,
  DEFAULT_WHISPER_MODEL_FILENAME,
} from './model-config.ts';
import type { TimedTranscriptUnit } from './transcript-types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..');
const WHISPER_CLI = join(PROJECT_ROOT, 'whisper.cpp/build/bin/whisper-cli');
const MODEL_PATH = join(PROJECT_ROOT, 'models', DEFAULT_WHISPER_MODEL_FILENAME);
const VAD_MODEL_PATH = join(PROJECT_ROOT, 'whisper.cpp/models', DEFAULT_VAD_MODEL_FILENAME);

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
  return typeof value === 'number' && Number.isFinite(value) ? value / 1000 : undefined;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isSpecialToken(text: string): boolean {
  const trimmed = text.trim();
  return /^\[_.*\]$/u.test(trimmed) || /^<\|.*\|>$/u.test(trimmed);
}

function timedTokens(segment: WhisperJsonSegment): TimedTranscriptUnit[] {
  if (!Array.isArray(segment.tokens)) return [];

  const units: TimedTranscriptUnit[] = [];
  let current: (TimedTranscriptUnit & { dtwAnchors: number[] }) | undefined;
  let missingLexicalTiming = false;
  const segmentStart = milliseconds(segment.offsets?.from) ?? 0;
  const segmentEnd = milliseconds(segment.offsets?.to);

  const flush = () => {
    if (current && current.text.trim()) {
      const { dtwAnchors, ...unit } = current;
      unit.text = unit.text.trim();

      if (dtwAnchors.length > 0) {
        const firstAnchor = dtwAnchors[0]!;
        const lastAnchor = dtwAnchors.at(-1)!;
        const heuristicDuration = Math.min(
          1.5,
          Math.max(0.05, unit.end - unit.start),
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
    if (start === undefined || end === undefined || end < start) {
      if (token.text.trim()) missingLexicalTiming = true;
      continue;
    }
    const dtwAnchor = typeof token.t_dtw === 'number' &&
      Number.isFinite(token.t_dtw) &&
      token.t_dtw >= 0
      ? token.t_dtw / 100
      : undefined;

    const startsNewWord = /^\s/u.test(token.text);
    if (startsNewWord && current) flush();

    if (!current) {
      current = {
        start,
        end,
        text: token.text,
        dtwAnchors: dtwAnchor === undefined ? [] : [dtwAnchor],
      };
    } else {
      current.end = Math.max(current.end, end);
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
}

class WhisperExecutionError extends Error {
  constructor(
    message: string,
    readonly retryWithoutGpu: boolean,
  ) {
    super(message);
  }
}

/**
 * Canonical detailed transcription path for all file-based workflows.
 */
export async function transcribeWithTimestamps(
  filePath: string,
  options: TimestampTranscriptionOptions = {},
): Promise<TimedTranscriptUnit[]> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!existsSync(WHISPER_CLI)) {
    throw new Error('whisper.cpp is not built. Run ./install.sh first.');
  }
  if (!existsSync(MODEL_PATH)) {
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
  const outputBase = join(tempDirectory, 'transcript');
  const outputJson = `${outputBase}.json`;

  try {
    const runWhisper = (disableGpu: boolean) => new Promise<void>((resolve, reject) => {
      const proc = spawn(WHISPER_CLI, [
        ...(disableGpu ? ['-ng'] : []),
        '-m', MODEL_PATH,
        ...(existsSync(VAD_MODEL_PATH) ? ['-vm', VAD_MODEL_PATH, '--vad'] : []),
        '-f', filePath,
        '-l', 'en',
        '-t', '6',
        // DTW anchors stay on the original audio timeline across long pauses.
        // This whisper.cpp build requires flash attention off for DTW.
        '-nfa',
        '-dtw', 'large.v3.turbo',
        '-np',
        '-pp',
        '-mc', '0',
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
            Boolean(signal) || code === 139,
          ));
          return;
        }
        resolve();
      });
    });

    const forceCpu = process.env.SEASHELL_DISABLE_GPU === '1';
    try {
      await runWhisper(forceCpu);
    } catch (error) {
      if (
        !forceCpu &&
        error instanceof WhisperExecutionError &&
        error.retryWithoutGpu
      ) {
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

    return timedUnitsFromWhisperJson(parsed);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
    stopTrackingTemp();
    endManagedSession();
  }
}
