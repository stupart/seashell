import { spawnSync } from 'child_process';
import { accessSync, constants } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { defaultConfigPath, loadConfig } from './config.ts';

/**
 * Which local engine separates speakers.
 *
 * auto: native/bin/seashell-speakers runs both of its engines on the Neural
 * Engine and lets community-1 check Nemotron 3 (211 MB of models, no Python, no
 * account). Measured on 13 AMI meetings, Nemotron 3 put the wrong speaker on
 * 0.55% of words outside crosstalk against 2.98% for community-1, but on two
 * of Tyler's calls it heard two plainly different voices as one, which no
 * renaming can undo. auto keeps Nemotron 3's speakers unless community-1's
 * voices show such a merge, then uses community-1's: 0.54% on those meetings,
 * and community-1 on those two calls. See native/speakers for the rule.
 * Without the Nemotron 3 models it is community-1 alone.
 *
 * native: community-1 alone — pyannote's models as Core ML (FluidAudio). 21 MB.
 * On four AMI meetings: 10.0% diarization error against 8.8% for pyannote in
 * Python, in 22 s against 257 s for 92 minutes of audio.
 *
 * nemotron3: NVIDIA's Nemotron 3 alone, up to eight voices per channel. 190 MB.
 *
 * pyannote: scripts/diarize.py in a ~1 GB Python environment, with a Hugging
 * Face login. Kept for anyone who wants it.
 *
 * auto is the default wherever the helper was built. SEASHELL_SPEAKER_ENGINE or
 * config.json `speakers.engine` (`seashell speakers use`) chooses one engine.
 */
export type SpeakerEngine = 'auto' | 'native' | 'nemotron3' | 'pyannote';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const NATIVE_SPEAKER_MODEL = 'pyannote community-1 · Core ML (FluidAudio)';
export const NEMOTRON_SPEAKER_MODEL = 'NVIDIA Nemotron 3 · Core ML (FluidAudio)';
export const AUTO_SPEAKER_MODEL = 'Nemotron 3 checked by pyannote community-1 · Core ML (FluidAudio)';

/** The helper names the model it used for a file; show it the way status does. */
export function helperModelLabel(model: string): string {
  return model.split(' and ').map((name) => (name.startsWith('nvidia/') ? NEMOTRON_SPEAKER_MODEL
    : name.startsWith('fluidaudio/') ? NATIVE_SPEAKER_MODEL : name)).join(' and ');
}

/** The download a fresh setup of each engine makes. */
export function speakerModelSize(engine: SpeakerEngine): string {
  return engine === 'auto' ? '211 MB' : engine === 'nemotron3' ? '190 MB' : '21 MB';
}

/** The engines seashell-speakers runs, as opposed to the Python one. */
export function usesSpeakersHelper(engine: SpeakerEngine): boolean { return engine !== 'pyannote'; }

/** auto is the helper's default, so a helper built before it still runs community-1. */
export function speakerEngineArguments(engine: SpeakerEngine): string[] {
  return engine === 'nemotron3' ? ['--engine', 'nemotron3'] : engine === 'native' ? ['--engine', 'community-1'] : [];
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
  if (chosen === 'auto' || chosen === 'native' || chosen === 'nemotron3' || chosen === 'pyannote') return chosen;
  return executable(speakersHelper(env)) ? 'auto' : 'pyannote';
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
  const model = engine === 'nemotron3' ? NEMOTRON_SPEAKER_MODEL : engine === 'auto' ? AUTO_SPEAKER_MODEL : NATIVE_SPEAKER_MODEL;
  const helper = speakersHelper(env);
  if (!executable(helper)) {
    return { ready: false, model, detail: 'The native speaker helper is not installed. Reinstall Sea Shell.' };
  }
  const result = spawnSync(helper, ['--status', ...speakerEngineArguments(engine)], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env } });
  try {
    const status = JSON.parse(result.stdout) as { ready?: unknown; directory?: unknown; nemotron?: unknown };
    const ready = status.ready === true;
    return {
      ready,
      // auto without the Nemotron 3 models, or a helper from before auto, is community-1 alone.
      model: engine === 'auto' && status.nemotron !== true ? NATIVE_SPEAKER_MODEL : model,
      ...(typeof status.directory === 'string' ? { directory: status.directory } : {}),
      detail: ready ? 'Speaker models are downloaded and run on this Mac.' : 'Speaker models are not downloaded yet.',
    };
  } catch {
    return { ready: false, model, detail: 'The native speaker helper did not answer. Reinstall Sea Shell.' };
  }
}
