import { spawnSync } from 'child_process';
import { accessSync, constants } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { defaultConfigPath, loadConfig } from './config.ts';

/**
 * Which local engine separates speakers.
 *
 * native: native/bin/seashell-speakers — pyannote's community-1 models as Core ML
 * on the Neural Engine (FluidAudio). 21 MB of models, no Python, no account.
 * Measured on four AMI meetings: 10.0% diarization error against 8.8% for
 * pyannote in Python, in 22 s against 257 s for 92 minutes of audio.
 *
 * nemotron3: NVIDIA's Nemotron 3 through the same helper. 190 MB, up to eight
 * voices per channel. On those meetings it put the wrong name on 1.4% of words
 * outside crosstalk against 4.7%. `seashell speakers compare` checks it on your
 * own calls; `seashell speakers use nemotron3` turns it on.
 *
 * pyannote: scripts/diarize.py in a ~1 GB Python environment, with a Hugging
 * Face login. Slightly more accurate; kept for anyone who wants it.
 *
 * Native is the default wherever its helper was built. SEASHELL_SPEAKER_ENGINE
 * or config.json `speakers.engine` chooses explicitly.
 */
export type SpeakerEngine = 'native' | 'nemotron3' | 'pyannote';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const NATIVE_SPEAKER_MODEL = 'pyannote community-1 · Core ML (FluidAudio)';
export const NEMOTRON_SPEAKER_MODEL = 'NVIDIA Nemotron 3 · Core ML (FluidAudio)';

/** The engines seashell-speakers runs, as opposed to the Python one. */
export function usesSpeakersHelper(engine: SpeakerEngine): boolean { return engine !== 'pyannote'; }

export function speakerEngineArguments(engine: SpeakerEngine): string[] {
  return engine === 'nemotron3' ? ['--engine', 'nemotron3'] : [];
}

export function speakersHelper(env: NodeJS.ProcessEnv = process.env): string {
  return env.SEASHELL_SPEAKERS_HELPER || join(PROJECT_ROOT, 'native', 'bin', 'seashell-speakers');
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

export function speakerEngine(env: NodeJS.ProcessEnv = process.env): SpeakerEngine {
  const chosen = env.SEASHELL_SPEAKER_ENGINE ?? (() => {
    try { return loadConfig(defaultConfigPath(env)).speakers?.engine; } catch { return undefined; }
  })();
  if (chosen === 'native' || chosen === 'nemotron3' || chosen === 'pyannote') return chosen;
  return executable(speakersHelper(env)) ? 'native' : 'pyannote';
}

export interface NativeSpeakerStatus {
  ready: boolean;
  model: string;
  directory?: string;
  detail: string;
}

/** Whether the native models are on disk. Never touches the network. */
export function nativeSpeakerStatus(
  env: NodeJS.ProcessEnv = process.env,
  engine: SpeakerEngine = speakerEngine(env),
): NativeSpeakerStatus {
  const model = engine === 'nemotron3' ? NEMOTRON_SPEAKER_MODEL : NATIVE_SPEAKER_MODEL;
  const helper = speakersHelper(env);
  if (!executable(helper)) {
    return { ready: false, model, detail: 'The native speaker helper is not installed. Reinstall Sea Shell.' };
  }
  const result = spawnSync(helper, ['--status', ...speakerEngineArguments(engine)], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env } });
  try {
    const status = JSON.parse(result.stdout) as { ready?: unknown; directory?: unknown };
    const ready = status.ready === true;
    return {
      ready,
      model,
      ...(typeof status.directory === 'string' ? { directory: status.directory } : {}),
      detail: ready ? 'Speaker models are downloaded and run on this Mac.' : 'Speaker models are not downloaded yet.',
    };
  } catch {
    return { ready: false, model, detail: 'The native speaker helper did not answer. Reinstall Sea Shell.' };
  }
}
