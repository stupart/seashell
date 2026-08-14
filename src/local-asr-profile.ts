import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { availableParallelism, homedir } from 'os';
import { dirname, join, resolve } from 'path';

export const LOCAL_ASR_PROFILE_SCHEMA_VERSION = '0.1' as const;

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
    threads: Math.max(1, Math.min(4, availableParallelism())),
    measured: false,
  };
}

export async function saveLocalAsrProfile(profile: StoredLocalAsrProfile): Promise<string> {
  const path = localAsrProfilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  return path;
}
