import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  beginManagedProcessSession,
  trackChildProcess,
  trackTempDirectory,
} from './process-lifecycle.ts';

export const SUPPORTED_MEDIA_EXTENSIONS = [
  'wav',
  'mp3',
  'flac',
  'ogg',
  'opus',
  'm4a',
  'aac',
  'mp4',
  'mov',
  'm4v',
  'mkv',
  'webm',
] as const;

export interface AudioStreamInfo {
  index: number;
  codecName?: string;
  sampleRate?: number;
  channels?: number;
  language?: string;
  isDefault: boolean;
}

export interface MediaProbe {
  path: string;
  formatName?: string;
  duration?: number;
  audioStreams: AudioStreamInfo[];
}

export interface PreparedMedia {
  path: string;
  sourcePath: string;
  probe: MediaProbe;
  selectedAudioStream: AudioStreamInfo;
  cleanup: () => void;
}

export interface PrepareMediaOptions {
  preserveChannels?: boolean;
  audioStreamIndex?: number;
  onStatus?: (message: string) => void;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

interface FfprobeStream {
  index?: unknown;
  codec_name?: unknown;
  sample_rate?: unknown;
  channels?: unknown;
  disposition?: { default?: unknown };
  tags?: { language?: unknown };
}

interface FfprobeDocument {
  streams?: unknown;
  format?: {
    format_name?: unknown;
    duration?: unknown;
  };
}

function finitePositive(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

export function parseFfprobeJson(path: string, value: unknown): MediaProbe {
  if (!value || typeof value !== 'object') {
    throw new Error('ffprobe returned invalid JSON');
  }

  const document = value as FfprobeDocument;
  const candidates = Array.isArray(document.streams) ? document.streams : [];
  const audioStreams: AudioStreamInfo[] = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const stream = candidate as FfprobeStream;
    const index = positiveInteger(stream.index);
    if (index === undefined) continue;
    const sampleRate = positiveInteger(stream.sample_rate);
    const channels = positiveInteger(stream.channels);
    audioStreams.push({
      index,
      ...(typeof stream.codec_name === 'string' ? { codecName: stream.codec_name } : {}),
      ...(sampleRate === undefined ? {} : { sampleRate }),
      ...(channels === undefined ? {} : { channels }),
      ...(typeof stream.tags?.language === 'string'
        ? { language: stream.tags.language }
        : {}),
      isDefault: stream.disposition?.default === 1,
    });
  }

  const duration = finitePositive(document.format?.duration);
  return {
    path,
    ...(typeof document.format?.format_name === 'string'
      ? { formatName: document.format.format_name }
      : {}),
    ...(duration === undefined ? {} : { duration }),
    audioStreams,
  };
}

export function buildFfprobeArgs(filePath: string): string[] {
  return [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-select_streams', 'a',
    filePath,
  ];
}

export function selectAudioStream(
  probe: MediaProbe,
  requestedIndex?: number,
): AudioStreamInfo {
  if (probe.audioStreams.length === 0) {
    throw new Error(`No audio stream found in ${probe.path}`);
  }
  if (requestedIndex !== undefined) {
    const selected = probe.audioStreams.find((stream) => stream.index === requestedIndex);
    if (!selected) {
      const available = probe.audioStreams.map((stream) => stream.index).join(', ');
      throw new Error(
        `Audio stream ${requestedIndex} was not found. Available stream indices: ${available}`,
      );
    }
    return selected;
  }
  return probe.audioStreams.find((stream) => stream.isDefault) ?? probe.audioStreams[0]!;
}

export function buildFfmpegPreparationArgs(
  filePath: string,
  outputPath: string,
  stream: AudioStreamInfo,
  preserveChannels: boolean,
): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', filePath,
    '-map', `0:${stream.index}`,
    '-vn',
    '-ar', '16000',
    ...(!preserveChannels ? ['-ac', '1'] : []),
    '-c:a', 'pcm_s16le',
    outputPath,
  ];
}

async function runProcess(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stopTracking = trackChildProcess(process);
    let stdout = '';
    let stderr = '';
    let settled = false;

    process.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    process.stderr?.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-12000);
    });
    process.on('error', (error) => {
      stopTracking();
      if (settled) return;
      settled = true;
      reject(new Error(`Could not start ${command}: ${error.message}`));
    });
    process.on('close', (code) => {
      stopTracking();
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`${command} failed (${code}): ${stderr.trim() || 'no details'}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function probeMedia(filePath: string): Promise<MediaProbe> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const result = await runProcess('ffprobe', buildFfprobeArgs(filePath));
  try {
    return parseFfprobeJson(filePath, JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('ffprobe returned malformed JSON');
    }
    throw error;
  }
}

/**
 * Extract one audio stream into the canonical PCM representation consumed by
 * Whisper. This is media preparation, not loudness normalization.
 */
export async function prepareMedia(
  filePath: string,
  options: PrepareMediaOptions = {},
): Promise<PreparedMedia> {
  const endManagedSession = beginManagedProcessSession();
  options.onStatus?.('Inspecting media…');

  let tempDirectory: string | undefined;
  let stopTrackingTemp: (() => void) | undefined;
  try {
    const probe = await probeMedia(filePath);
    const selectedAudioStream = selectAudioStream(probe, options.audioStreamIndex);
    tempDirectory = mkdtempSync(join(tmpdir(), 'seashell-media-'));
    stopTrackingTemp = trackTempDirectory(tempDirectory);
    const outputPath = join(tempDirectory, 'audio.wav');

    options.onStatus?.('Preparing audio…');
    await runProcess(
      'ffmpeg',
      buildFfmpegPreparationArgs(
        filePath,
        outputPath,
        selectedAudioStream,
        options.preserveChannels ?? false,
      ),
    );

    let cleaned = false;
    return {
      path: outputPath,
      sourcePath: filePath,
      probe,
      selectedAudioStream,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        rmSync(tempDirectory!, { recursive: true, force: true });
        stopTrackingTemp?.();
        endManagedSession();
      },
    };
  } catch (error) {
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
    stopTrackingTemp?.();
    endManagedSession();
    throw error;
  }
}
