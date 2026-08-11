import { randomUUID } from 'crypto';
import {
  CaptureSessionStore,
  type CaptureSessionManifest,
} from './capture-session.ts';
import { startMicrophoneCapture } from './live-microphone.ts';
import {
  startSystemAudioCapture,
  type PcmSignalLevel,
  type SystemAudioCaptureState,
} from './live-system-audio.ts';

export interface CaptureSignalTestResult {
  readonly schemaVersion: '0.1';
  readonly durationSeconds: number;
  readonly microphone: {
    readonly state: SystemAudioCaptureState;
    readonly peak: number;
    readonly rmsDbfs: number | null;
    readonly chunks: number;
    readonly audibleChunks: number;
  };
  readonly systemAudio: {
    readonly state: SystemAudioCaptureState;
    readonly peak: number;
    readonly rmsDbfs: number | null;
    readonly chunks: number;
    readonly audibleChunks: number;
  };
  readonly ready: boolean;
  readonly guidance: readonly string[];
}

export interface BoundedCaptureResult extends CaptureSignalTestResult {
  readonly manifestPath: string;
  readonly session: CaptureSessionManifest;
}

function louder(current: PcmSignalLevel | null, incoming: PcmSignalLevel): PcmSignalLevel {
  return !current || incoming.rms > current.rms ? incoming : current;
}

async function captureForDuration(
  libraryDir: string,
  durationSeconds: number,
  sessionPrefix: string,
): Promise<{ store: CaptureSessionStore; result: CaptureSignalTestResult }> {
  const now = new Date();
  const store = new CaptureSessionStore({
    libraryDir,
    sessionId: `${sessionPrefix}-${now.toISOString().replace(/\D/gu, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    startedAtUnixMs: now.getTime(),
    createdAt: now.toISOString(),
  });
  let microphoneState: SystemAudioCaptureState = 'starting';
  let systemAudioState: SystemAudioCaptureState = 'starting';
  let microphoneLevel: PcmSignalLevel | null = null;
  let systemAudioLevel: PcmSignalLevel | null = null;
  const microphone = startMicrophoneCapture({
    sessionStartedAtUnixMs: now.getTime(),
    chunkMilliseconds: 1_000,
    onLevel: (level) => { microphoneLevel = louder(microphoneLevel, level); },
    onState: (update) => { microphoneState = update.state; },
    onChunk: (chunk) => {
      store.commitChunk({
        sourcePath: chunk.path,
        trackId: 'microphone',
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        audible: chunk.audible,
      });
    },
  });
  const system = startSystemAudioCapture({
    sessionStartedAtUnixMs: now.getTime(),
    chunkMilliseconds: 1_000,
    onLevel: (level) => { systemAudioLevel = louder(systemAudioLevel, level); },
    onState: (update) => { systemAudioState = update.state; },
    onChunk: (chunk) => {
      store.commitChunk({
        sourcePath: chunk.path,
        trackId: 'system-audio',
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        audible: chunk.audible,
      });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1_000));
  microphone.stop();
  system.stop();
  await Promise.all([microphone.done, system.done]);
  const manifest = store.manifest;
  const summarize = (trackId: 'microphone' | 'system-audio', state: SystemAudioCaptureState, level: PcmSignalLevel | null) => {
    const chunks = manifest.chunks.filter((chunk) => chunk.trackId === trackId);
    return Object.freeze({
      state,
      peak: level?.peak ?? 0,
      rmsDbfs: level && Number.isFinite(level.rmsDbfs) ? level.rmsDbfs : null,
      chunks: chunks.length,
      audibleChunks: chunks.filter((chunk) => chunk.audible).length,
    });
  };
  const microphoneSummary = summarize('microphone', microphoneState, microphoneLevel);
  const systemSummary = summarize('system-audio', systemAudioState, systemAudioLevel);
  const guidance = [
    ...(microphoneSummary.audibleChunks > 0
      ? []
      : ['Speak during the test; if the microphone stays quiet, check its input selection and macOS permission.']),
    ...(systemSummary.audibleChunks > 0
      ? []
      : ['Play speech or meeting audio during the test; permission alone cannot prove an audible system signal.']),
  ];
  return {
    store,
    result: Object.freeze({
    schemaVersion: '0.1' as const,
    durationSeconds,
    microphone: microphoneSummary,
    systemAudio: systemSummary,
    ready: microphoneSummary.state === 'stopped' && systemSummary.state === 'stopped' &&
      microphoneSummary.audibleChunks > 0 && systemSummary.audibleChunks > 0,
    guidance: Object.freeze(guidance),
    }),
  };
}

/** Bounded, disposable real-device test used before trusting an important call. */
export async function runCaptureSignalTest(
  libraryDir: string,
  durationSeconds = 5,
): Promise<CaptureSignalTestResult> {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 2 || durationSeconds > 30) {
    throw new Error('Capture test duration must be an integer from 2 to 30 seconds');
  }
  const { store, result } = await captureForDuration(libraryDir, durationSeconds, 'signal-test');
  store.setStatus('completed', 'disposable-signal-test');
  store.discardCompleted();
  return result;
}

/** Bounded provider execution; the durable artifact remains available for workflows. */
export async function recordBoundedCapture(
  libraryDir: string,
  durationSeconds: number,
): Promise<BoundedCaptureResult> {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 2 || durationSeconds > 14_400) {
    throw new Error('Capture duration must be an integer from 2 seconds to 4 hours');
  }
  const { store, result } = await captureForDuration(libraryDir, durationSeconds, 'capture');
  const session = store.setStatus('captured', 'bounded-capture-complete-awaiting-finalization');
  return Object.freeze({ ...result, manifestPath: store.manifestPath, session });
}
