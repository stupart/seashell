import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { availableParallelism, homedir, totalmem } from 'os';
import { dirname, join, resolve } from 'path';

export const LOCAL_ASR_PROFILE_SCHEMA_VERSION = '0.1' as const;

/** More whisper.cpp threads than this stop paying off and crowd out the next call. */
const MAX_TRANSCRIPTION_THREADS = 8;
/** The live draft runs beside a call, so it gets fewer threads than the final pass. */
const MAX_LIVE_THREADS = 4;

export interface TranscriptionHardware {
  readonly appleSilicon: boolean;
  /** Apple Silicon's cores other than efficiency cores; every physical core on Intel. */
  readonly performanceCores: number;
  readonly memoryBytes: number;
}

/** sysctl values by name, for the names this Mac has. */
export type SysctlReader = (names: readonly string[]) => Readonly<Record<string, string>>;

const readSysctl: SysctlReader = (names) => {
  // Unknown names (perflevels on Intel) print an error and leave the rest intact.
  const result = spawnSync('/usr/sbin/sysctl', [...names], { encoding: 'utf8', timeout: 2_000 });
  const values: Record<string, string> = {};
  for (const line of (result.stdout ?? '').split('\n')) {
    const separator = line.indexOf(': ');
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 2).trim();
  }
  return values;
};

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Apple Silicon numbers its core types from fastest down: M1 to M4 report
 * Performance and Efficiency, M5 reports Super and Performance. Count every
 * type but efficiency cores. Intel cores are all alike; count physical ones.
 */
export function readTranscriptionHardware(read: SysctlReader = readSysctl): TranscriptionHardware {
  const levels = Array.from({ length: 4 }, (_, level) => [`hw.perflevel${level}.name`, `hw.perflevel${level}.physicalcpu`]).flat();
  const values = read(['hw.optional.arm64', 'hw.physicalcpu', 'hw.memsize', 'hw.nperflevels', ...levels]);
  const appleSilicon = values['hw.optional.arm64'] === '1';
  const levelCount = Math.min(4, positiveInteger(values['hw.nperflevels']) ?? 0);
  const fastCores = Array.from({ length: levelCount }, (_, level) => level)
    .filter((level) => level === 0 || (values[`hw.perflevel${level}.name`] !== undefined &&
      values[`hw.perflevel${level}.name`] !== 'Efficiency'))
    .reduce((total, level) => total + (positiveInteger(values[`hw.perflevel${level}.physicalcpu`]) ?? 0), 0);
  return {
    appleSilicon,
    performanceCores: (appleSilicon && fastCores) || positiveInteger(values['hw.physicalcpu']) || availableParallelism(),
    memoryBytes: positiveInteger(values['hw.memsize']) ?? totalmem(),
  };
}

let hardware: TranscriptionHardware | undefined;
/** Read once per process; the hardware does not change while Seashell runs. */
export function transcriptionHardware(): TranscriptionHardware {
  return hardware ??= readTranscriptionHardware();
}

/** Threads for a whisper.cpp pass over a whole recording. */
export function finalTranscriptionThreads(hardware = transcriptionHardware()): number {
  return Math.max(1, Math.min(MAX_TRANSCRIPTION_THREADS, hardware.performanceCores));
}

/** Threads for the live draft server before a measured profile exists. */
export function liveTranscriptionThreads(hardware = transcriptionHardware()): number {
  return Math.max(1, Math.min(MAX_LIVE_THREADS, hardware.performanceCores));
}

/**
 * whisper.cpp's Metal backend is built for Apple GPUs. Intel Macs transcribe
 * on the CPU rather than on a GPU the backend may not support.
 */
export function transcriptionUsesGpu(hardware = transcriptionHardware(), environment: NodeJS.ProcessEnv = process.env): boolean {
  return hardware.appleSilicon && environment.SEASHELL_DISABLE_GPU !== '1';
}

/** A final pass peaks near 1.3 GB for a 30-minute track; two at once need room beside a call. */
const CONCURRENT_TRACKS_MIN_MEMORY_BYTES = 16 * 2 ** 30;

/**
 * Whether the final pass can transcribe the microphone and system audio at
 * once. Only with the GPU: on the CPU two passes just split the same cores.
 */
export function concurrentTrackTranscription(hardware = transcriptionHardware(), environment: NodeJS.ProcessEnv = process.env): boolean {
  return transcriptionUsesGpu(hardware, environment) && hardware.memoryBytes >= CONCURRENT_TRACKS_MIN_MEMORY_BYTES;
}

export interface StoredLocalAsrProfile {
  readonly schemaVersion: '0.1';
  readonly measuredAt: string;
  readonly sourceAudioSeconds: number;
  readonly modelPath: string;
  readonly threads: number;
  readonly medianLatencyMs: number;
  readonly realtimeFactor: number;
}

export function localAsrProfilePath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.SEASHELL_ASR_PROFILE_PATH?.trim() || join(
    homedir(),
    'Library',
    'Application Support',
    'Sea Shell',
    'live-asr-profile.json',
  );
}

export function parseStoredLocalAsrProfile(value: unknown): StoredLocalAsrProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Local ASR profile must be an object');
  }
  const profile = value as Record<string, unknown>;
  if (profile.schemaVersion !== LOCAL_ASR_PROFILE_SCHEMA_VERSION ||
      typeof profile.measuredAt !== 'string' || Number.isNaN(Date.parse(profile.measuredAt)) ||
      typeof profile.modelPath !== 'string' || !profile.modelPath ||
      !Number.isSafeInteger(profile.threads) || Number(profile.threads) < 1 ||
      typeof profile.sourceAudioSeconds !== 'number' || profile.sourceAudioSeconds <= 0 ||
      typeof profile.medianLatencyMs !== 'number' || profile.medianLatencyMs < 0 ||
      typeof profile.realtimeFactor !== 'number' || profile.realtimeFactor < 0) {
    throw new Error('Local ASR profile is invalid');
  }
  return Object.freeze(profile as unknown as StoredLocalAsrProfile);
}

export function loadLocalAsrProfile(defaultModelPath: string): {
  readonly id: string;
  readonly modelPath: string;
  readonly threads: number;
  readonly measured: boolean;
} {
  const configuredModel = process.env.SEASHELL_DRAFT_MODEL?.trim();
  const modelPath = resolve(configuredModel || defaultModelPath);
  const path = localAsrProfilePath();
  if (existsSync(path)) {
    try {
      const stored = parseStoredLocalAsrProfile(JSON.parse(readFileSync(path, 'utf8')));
      if (resolve(stored.modelPath) === modelPath && existsSync(modelPath)) {
        return { id: 'measured-local', modelPath, threads: stored.threads, measured: true };
      }
    } catch {}
  }
  return {
    id: 'safe-default-unmeasured',
    modelPath,
    threads: liveTranscriptionThreads(),
    measured: false,
  };
}

export async function saveLocalAsrProfile(profile: StoredLocalAsrProfile): Promise<string> {
  const path = localAsrProfilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  return path;
}
