import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_WHISPER_MODEL_ID } from './model-config.ts';
import { SYSTEM_AUDIO_HELPER } from './live-system-audio.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = (() => {
  const parsed = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof parsed.version !== 'string' || !parsed.version.trim()) {
    throw new Error('Sea Shell package version is missing');
  }
  return parsed.version.trim();
})();

export function seashellCapabilityManifest(options: { systemAudioReady?: boolean } = {}) {
  const diarizationModel = process.env.SEASHELL_DIARIZATION_MODEL ||
    'pyannote/speaker-diarization-community-1';
  const hubRoot = process.env.HF_HUB_CACHE || join(
    process.env.HF_HOME || join(homedir(), '.cache', 'huggingface'),
    'hub',
  );
  const modelCache = isAbsolute(diarizationModel)
    ? diarizationModel
    : join(hubRoot, `models--${diarizationModel.replaceAll('/', '--')}`);
  const diarizationDependencies = existsSync(join(PROJECT_ROOT, '.venv-diarization/bin/python'));
  const diarizationModelCached = existsSync(modelCache);
  const diarizationReady = diarizationDependencies && diarizationModelCached;
  const systemAudioReady = options.systemAudioReady ?? (
    process.platform === 'darwin' && existsSync(SYSTEM_AUDIO_HELPER)
  );
  return Object.freeze({
    schemaVersion: '0.1',
    product: Object.freeze({
      id: 'product.seashell',
      name: 'Sea Shell',
      version: PACKAGE_VERSION,
    }),
    capabilities: Object.freeze([
      Object.freeze({
        id: 'transcription.seashell.local',
        operation: 'media.transcribe',
        boundary: 'local',
        modes: Object.freeze(['batch']),
        inputKinds: Object.freeze(['audio-file', 'video-file']),
        languages: Object.freeze(['en']),
        network: 'none',
        supportsCancellation: true,
        features: Object.freeze([
          'segment-timestamps',
          'audio-stream-selection',
        ]),
        optionalFeatures: Object.freeze([
          Object.freeze({
            id: 'speaker-diarization',
            ready: diarizationReady,
            ...(diarizationReady
              ? {}
              : {
                  nextStep: !diarizationDependencies
                    ? 'Install the optional diarization environment described in the Sea Shell README'
                    : 'Download the configured pyannote model once before using offline diarization',
                }),
          }),
        ]),
        engine: 'whisper.cpp',
        model: DEFAULT_WHISPER_MODEL_ID,
      }),
      ...(systemAudioReady
        ? [Object.freeze({
            id: 'capture.seashell.macos.live',
            operation: 'media.capture',
            boundary: 'local',
            modes: Object.freeze(['live']),
            inputKinds: Object.freeze(['microphone', 'system-audio']),
            languages: Object.freeze([]),
            network: 'none',
            supportsCancellation: true,
            features: Object.freeze([
              'separate-source-labels',
              'shared-session-clock',
              'incremental-wav-chunks',
            ]),
            optionalFeatures: Object.freeze([]),
            engine: 'coreaudio+sox',
            model: 'none',
          })]
        : []),
    ]),
  });
}

export function renderCapabilityManifest(): string {
  const manifest = seashellCapabilityManifest();
  return [
    `${manifest.product.name} ${manifest.product.version}`,
    ...manifest.capabilities.flatMap((capability) => [
      '',
      `${capability.id}`,
      `  operation: ${capability.operation}`,
      `  boundary: ${capability.boundary}`,
      `  modes: ${capability.modes.join(', ')}`,
      `  inputs: ${capability.inputKinds.join(', ')}`,
      ...(capability.languages.length === 0
        ? []
        : [`  languages: ${capability.languages.join(', ')}`]),
      `  network: ${capability.network}`,
      `  engine: ${capability.engine}`,
      `  model: ${capability.model}`,
      `  features: ${capability.features.join(', ')}`,
      ...capability.optionalFeatures.map((feature) =>
        `  optional ${feature.id}: ${feature.ready ? 'ready' : `setup required — ${feature.nextStep}`}`),
    ]),
  ].join('\n');
}
