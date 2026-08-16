import { randomUUID } from 'crypto';
import { unlinkSync } from 'fs';
import {
  CaptureSessionStore,
  type CaptureSessionManifest,
} from './capture-session.ts';
import {
  startMicrophoneCapture,
  type MicrophoneCaptureHandle,
} from './live-microphone.ts';
import {
  LIVE_CAPTURE_SAMPLE_RATE,
  startSystemAudioCapture,
  type PcmSignalLevel,
  type SystemAudioCaptureHandle,
  type SystemAudioCaptureState,
} from './live-system-audio.ts';

export interface DurableLiveCaptureStatus {
  readonly microphone: SystemAudioCaptureState;
  readonly systemAudio: SystemAudioCaptureState;
  readonly microphoneLevel?: PcmSignalLevel;
  readonly systemAudioLevel?: PcmSignalLevel;
  readonly durableChunks: number;
}

export interface DurableLiveCaptureHandle {
  readonly sessionId: string;
  readonly manifestPath: string;
  readonly store: CaptureSessionStore;
  stop(reason?: string): Promise<CaptureSessionManifest>;
}

export interface StartDurableLiveCaptureOptions {
  readonly libraryDir: string;
  readonly sessionId?: string;
  readonly startedAt?: Date;
  readonly microphone?: boolean;
  readonly systemAudio?: boolean;
  readonly chunkMilliseconds?: number;
  readonly onStatus?: (status: DurableLiveCaptureStatus) => void;
  readonly onError?: (error: Error) => void;
  readonly microphoneStarter?: typeof startMicrophoneCapture;
  readonly systemAudioStarter?: typeof startSystemAudioCapture;
}

function sessionId(now: Date): string {
  return `meeting-${now.toISOString().replace(/\D/gu, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

/** Capture both sources durably without starting any inference process. */
export function startDurableLiveCapture(
  options: StartDurableLiveCaptureOptions,
): DurableLiveCaptureHandle {
  const startedAt = options.startedAt ?? new Date();
  const store = new CaptureSessionStore({
    libraryDir: options.libraryDir,
    sessionId: options.sessionId ?? sessionId(startedAt),
    startedAtUnixMs: startedAt.getTime(),
    createdAt: startedAt.toISOString(),
  });
  let microphoneState: SystemAudioCaptureState = options.microphone === false ? 'unavailable' : 'starting';
  let systemAudioState: SystemAudioCaptureState = options.systemAudio === false ? 'unavailable' : 'starting';
  let microphoneLevel: PcmSignalLevel | undefined;
  let systemAudioLevel: PcmSignalLevel | undefined;
  let microphone: MicrophoneCaptureHandle | undefined;
  let systemAudio: SystemAudioCaptureHandle | undefined;
  let stopping: Promise<CaptureSessionManifest> | undefined;
  let captureFailure: Error | undefined;

  const status = () => options.onStatus?.(Object.freeze({
    microphone: microphoneState,
    systemAudio: systemAudioState,
    ...(microphoneLevel === undefined ? {} : { microphoneLevel }),
    ...(systemAudioLevel === undefined ? {} : { systemAudioLevel }),
    durableChunks: store.manifest.chunks.length,
  }));
  const fail = (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    captureFailure ??= normalized;
    options.onError?.(normalized);
  };
  const commit = (chunk: Parameters<CaptureSessionStore['commitChunkAsync']>[0]) => {
    void store.commitChunkAsync(chunk).then(status).catch((error: unknown) => {
      try { unlinkSync(chunk.sourcePath); } catch {}
      fail(error);
    });
  };

  if (options.microphone !== false) {
    microphone = (options.microphoneStarter ?? startMicrophoneCapture)({
      sessionStartedAtUnixMs: startedAt.getTime(),
      ...(options.chunkMilliseconds === undefined ? {} : { chunkMilliseconds: options.chunkMilliseconds }),
      onChunk: (chunk) => commit({
        sourcePath: chunk.path,
        trackId: 'microphone',
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        audible: chunk.audible,
        clock: chunk.clock,
      }),
      onLevel: (level) => { microphoneLevel = level; status(); },
      onState: (update) => {
        microphoneState = update.state;
        if (update.state === 'unavailable') fail(new Error(update.message ?? 'Microphone unavailable'));
        status();
      },
    });
  }
  if (options.systemAudio !== false) {
    systemAudio = (options.systemAudioStarter ?? startSystemAudioCapture)({
      sessionStartedAtUnixMs: startedAt.getTime(),
      ...(options.chunkMilliseconds === undefined ? {} : { chunkMilliseconds: options.chunkMilliseconds }),
      onChunk: (chunk) => commit({
        sourcePath: chunk.path,
        trackId: 'system-audio',
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        audible: chunk.audible,
        clock: chunk.clock,
      }),
      onDiscontinuity: (event) => {
        void store.recordDiscontinuityAsync({
          trackId: 'system-audio',
          atSeconds: event.atFrame / LIVE_CAPTURE_SAMPLE_RATE,
          durationSeconds: event.durationFrames / LIVE_CAPTURE_SAMPLE_RATE,
          reason: event.reason,
        }).catch(fail);
      },
      onLevel: (level) => { systemAudioLevel = level; status(); },
      onState: (update) => {
        systemAudioState = update.state;
        // System audio is optional at runtime; mic-only capture remains useful.
        if (update.state === 'unavailable' && update.message) options.onError?.(new Error(update.message));
        status();
      },
    });
  }
  status();

  return Object.freeze({
    sessionId: store.manifest.sessionId,
    manifestPath: store.manifestPath,
    store,
    stop(reason = 'meeting-signal-ended') {
      if (stopping) return stopping;
      microphone?.stop();
      systemAudio?.stop();
      stopping = Promise.all([microphone?.done, systemAudio?.done]).then(async () => {
        await store.drainCommits();
        if (captureFailure && store.manifest.chunks.length === 0) {
          store.setStatus('interrupted', 'capture-source-failed');
          throw captureFailure;
        }
        return store.setStatus('captured', reason);
      });
      return stopping;
    },
  });
}
