export type TranscriptionMode = 'local' | 'cloud' | 'adaptive';
export type TranscriptionRoute = 'local' | 'cloud';

export interface CloudTranscriptionConfig {
  readonly model: string;
  readonly upstreamProvider?: string;
  readonly maxCostMicrousd?: number;
  readonly uploadConsent: boolean;
}

export interface TranscriptionRoutingConfig {
  readonly mode: TranscriptionMode;
  readonly canonicalFinal: TranscriptionRoute;
  readonly cloud?: CloudTranscriptionConfig;
  readonly adaptiveCloudQueueDepth: number;
}

export const DEFAULT_TRANSCRIPTION_ROUTING: TranscriptionRoutingConfig = Object.freeze({
  mode: 'local',
  canonicalFinal: 'local',
  adaptiveCloudQueueDepth: 3,
});

function assertCloudReady(config: TranscriptionRoutingConfig): asserts config is
    TranscriptionRoutingConfig & { cloud: CloudTranscriptionConfig & { uploadConsent: true } } {
  if (!config.cloud?.uploadConsent) {
    throw new Error('Cloud transcription requires explicit uploadConsent in Sea Shell settings');
  }
  if (!config.cloud.model.trim()) throw new Error('Cloud transcription requires an exact model');
}

export function selectDraftTranscriptionRoute(
  config: TranscriptionRoutingConfig,
  localQueueDepth: number,
): TranscriptionRoute {
  if (config.mode === 'local') return 'local';
  if (config.mode === 'cloud') {
    assertCloudReady(config);
    return 'cloud';
  }
  if (localQueueDepth < config.adaptiveCloudQueueDepth) return 'local';
  assertCloudReady(config);
  return 'cloud';
}

/** The canonical route is pinned independently from draft/adaptive routing. */
export function selectCanonicalTranscriptionRoute(
  config: TranscriptionRoutingConfig,
): TranscriptionRoute {
  if (config.canonicalFinal === 'cloud') assertCloudReady(config);
  return config.canonicalFinal;
}
