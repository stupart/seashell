import { randomUUID } from 'crypto';
import { unlinkSync } from 'fs';
import { startMeetSpeakerReader, type MeetBrowserMode, type MeetProbe, type MeetSpeaker } from './meet-speakers.ts';
import type { TranscriptSegment } from './transcript-types.ts';
import {
  CaptureSessionStore,
  type CaptureSessionManifest,
  type CommittedCaptureChunk,
} from './capture-session.ts';
import { CaptureHealthTracker, CaptureHealthWriter, type CaptureHealthSnapshot } from './capture-health.ts';
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
import { screenFilmedNotice, startVideoTrack, type VideoCaptureRequest, type VideoState, type VideoTrackHandle } from './video-capture.ts';
import { signalProcessGroup } from './process-lifecycle.ts';

/**
 * The longest a stop waits for its sources. Each settles well before this on
 * its own (a helper is killed within a few seconds); past it, whatever still
 * holds on is killed and the meeting is saved with the audio that arrived, so
 * no helper can keep a recording, or the watcher behind it, open forever.
 */
export const CAPTURE_STOP_DEADLINE_MS = 20_000;

export interface DurableLiveCaptureStatus {
  readonly microphone: SystemAudioCaptureState;
  readonly systemAudio: SystemAudioCaptureState;
  readonly microphoneLevel?: PcmSignalLevel;
  readonly systemAudioLevel?: PcmSignalLevel;
  readonly durableChunks: number;
  readonly health?: CaptureHealthSnapshot;
  readonly audioSavedThroughMs?: number;
  /** Only when video was asked for. */
  readonly video?: VideoState;
}

export interface DurableLiveCaptureHandle {
  readonly sessionId: string;
  readonly manifestPath: string;
  readonly store: CaptureSessionStore;
  readonly health?: CaptureHealthSnapshot;
  readonly speakerFor?: (segment: TranscriptSegment) => MeetSpeaker | undefined;
  stop(reason?: string): Promise<CaptureSessionManifest>;
}

export interface StartDurableLiveCaptureOptions {
  readonly speakerBrowser?: MeetBrowserMode | 'off';
  readonly onMeetStatus?: (status: MeetProbe) => void;
  readonly libraryDir: string;
  readonly sessionId?: string;
  readonly startedAt?: Date;
  readonly microphone?: boolean;
  readonly systemAudio?: boolean;
  readonly chunkMilliseconds?: number;
  readonly onStatus?: (status: DurableLiveCaptureStatus) => void;
  readonly onCommittedChunk?: (chunk: CommittedCaptureChunk) => void;
  readonly onError?: (error: Error) => void;
  readonly microphoneStarter?: typeof startMicrophoneCapture;
  readonly systemAudioStarter?: typeof startSystemAudioCapture;
  /** Also record the call's window or a display. Video never holds up or fails audio: its problems are warnings. */
  readonly video?: VideoCaptureRequest;
  readonly videoStarter?: typeof startVideoTrack;
  /** Tests only: CAPTURE_STOP_DEADLINE_MS. */
  readonly stopDeadlineMs?: number;
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
  let video: VideoTrackHandle | undefined;
  let videoState: VideoState | undefined = options.video ? 'starting' : undefined;
  let stopping: Promise<CaptureSessionManifest> | undefined;
  let captureFailure: Error | undefined;
  let audioSavedThroughMs = 0;
  const health = new CaptureHealthTracker({ microphone: options.microphone, systemAudio: options.systemAudio });
  if (videoState) health.video(videoState);
  const healthWriter = new CaptureHealthWriter(store.root);
  let healthWriteFailed = false;

  const status = (force = false) => {
    try { healthWriter.write(health.snapshot, force); }
    catch {
      if (!healthWriteFailed) options.onError?.(new Error('Capture continues, but its source-health status could not be saved.'));
      healthWriteFailed = true;
    }
    options.onStatus?.(Object.freeze({
      microphone: microphoneState,
      systemAudio: systemAudioState,
      ...(microphoneLevel === undefined ? {} : { microphoneLevel }),
      ...(systemAudioLevel === undefined ? {} : { systemAudioLevel }),
      durableChunks: store.manifest.chunks.length,
      audioSavedThroughMs,
      health: health.snapshot,
      ...(videoState === undefined ? {} : { video: videoState }),
    }));
  };
  const fail = (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    captureFailure ??= normalized;
    options.onError?.(normalized);
  };
  const commit = (chunk: Parameters<CaptureSessionStore['commitChunkAsync']>[0]) => {
    void store.commitChunkAsync(chunk).then(committed => {
      audioSavedThroughMs = Math.max(audioSavedThroughMs, committed.endMs);
      status();
      try { options.onCommittedChunk?.(committed); }
      catch (error) { options.onError?.(error instanceof Error ? error : new Error(String(error))); }
    }).catch((error: unknown) => {
      try { unlinkSync(chunk.sourcePath); } catch {}
      fail(error);
    });
  };

  if (options.microphone !== false) {
    try {
      microphone = (options.microphoneStarter ?? startMicrophoneCapture)({
        sessionStartedAtUnixMs: startedAt.getTime(),
        ...(options.chunkMilliseconds === undefined ? {} : { chunkMilliseconds: options.chunkMilliseconds }),
        onChunk: (chunk) => {
          health.pcm('microphone', chunk.level, chunk.audible);
          commit({
            sourcePath: chunk.path,
            trackId: 'microphone',
            startSeconds: chunk.startSeconds,
            endSeconds: chunk.endSeconds,
            audible: chunk.audible,
            clock: chunk.clock,
          });
        },
        onLevel: (level) => { microphoneLevel = level; health.pcm('microphone', level); status(); },
        onState: (update) => {
          microphoneState = update.state;
          health.state('microphone', update);
          if (update.state === 'unavailable') fail(new Error(update.message ?? 'Microphone unavailable'));
          status();
        },
      });
    } catch (error) {
      microphoneState = 'unavailable';
      const normalized = error instanceof Error ? error : new Error(String(error));
      health.state('microphone', { state: 'unavailable', code: 'microphone_start_failed', message: normalized.message });
      fail(normalized);
    }
  }
  if (options.systemAudio !== false) {
    try {
      systemAudio = (options.systemAudioStarter ?? startSystemAudioCapture)({
        startAfter: microphone?.startup,
        sessionStartedAtUnixMs: startedAt.getTime(),
        ...(options.chunkMilliseconds === undefined ? {} : { chunkMilliseconds: options.chunkMilliseconds }),
        onChunk: (chunk) => {
          health.pcm('systemAudio', chunk.level, chunk.audible);
          commit({
            sourcePath: chunk.path,
            trackId: 'system-audio',
            startSeconds: chunk.startSeconds,
            endSeconds: chunk.endSeconds,
            audible: chunk.audible,
            clock: chunk.clock,
          });
        },
        onDiscontinuity: (event) => {
          void store.recordDiscontinuityAsync({
            trackId: 'system-audio',
            atSeconds: event.atFrame / LIVE_CAPTURE_SAMPLE_RATE,
            durationSeconds: event.durationFrames / LIVE_CAPTURE_SAMPLE_RATE,
            reason: event.reason,
          }).catch(fail);
        },
        onLevel: (level) => { systemAudioLevel = level; health.pcm('systemAudio', level); status(); },
        // Said, never fatal: the audio carries on under the other permission.
        onWarning: (message) => options.onError?.(new Error(message)),
        onState: (update) => {
          systemAudioState = update.state;
          health.state('systemAudio', update);
          // A surviving source remains useful; fail stop only when no chunks exist.
          if (update.state === 'unavailable') fail(new Error(update.message ?? 'Computer audio unavailable'));
          status();
        },
      });
    } catch (error) {
      // System audio is optional; keep the microphone handle reachable so it
      // can flush its final chunk and stop normally after a startup failure.
      systemAudioState = 'unavailable';
      health.state('systemAudio', { state: 'unavailable', code: 'system_audio_start_failed',
        message: error instanceof Error ? error.message : String(error) });
      fail(error);
    }
  }
  if (options.video) {
    // A warning, not fail(): a missing video must never mark the audio as failed.
    const warn = (message: string) => options.onError?.(new Error(message));
    try {
      video = (options.videoStarter ?? startVideoTrack)({
        request: options.video,
        sessionStartedAtUnixMs: store.manifest.startedAtUnixMs,
        nextSegment: () => store.nextVideoSegment(),
        onSegment: (segment) => store.recordVideoSegmentAsync(segment),
        onState: (state) => { videoState = state; health.video(state); status(); },
        onWarning: warn,
        // What is filmed shows with the recording; a whole display is also said aloud, as a notice.
        onTarget: (filming) => {
          health.video(videoState ?? 'starting', filming);
          if (filming.kind === 'display') warn(screenFilmedNotice(filming));
          status();
        },
      });
    } catch (error) {
      videoState = 'unavailable';
      health.video('unavailable');
      warn(`Video was not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  status();

  const meetReader = options.systemAudio !== false && options.speakerBrowser && options.speakerBrowser !== 'off'
    ? startMeetSpeakerReader({ browser: options.speakerBrowser, store, onStatus: options.onMeetStatus }) : undefined;

  return Object.freeze({
    sessionId: store.manifest.sessionId,
    manifestPath: store.manifestPath,
    store,
    get health() { return health.snapshot; },
    ...(meetReader ? { speakerFor: meetReader.speakerFor } : {}),
    stop(reason = 'meeting-signal-ended') {
      if (stopping) return stopping;
      meetReader?.stop();
      microphone?.stop();
      systemAudio?.stop();
      video?.stop();
      // Video settles on its own deadline and never rejects.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        deadline = setTimeout(() => resolve('late'), options.stopDeadlineMs ?? CAPTURE_STOP_DEADLINE_MS);
      });
      stopping = Promise.race([Promise.all([microphone?.done, systemAudio?.done, video?.done]), late]).then(async (outcome) => {
        clearTimeout(deadline);
        if (outcome === 'late') {
          for (const handle of [microphone, systemAudio]) if (handle?.process) signalProcessGroup(handle.process, 'SIGKILL');
          options.onError?.(new Error('Capture did not stop in time. The audio saved so far is kept.'));
        }
        await store.drainCommits();
        if (captureFailure && store.manifest.chunks.length === 0) {
          store.setStatus('interrupted', 'capture-source-failed');
          throw captureFailure;
        }
        return store.setStatus('captured', reason);
      }).finally(() => {
        // The whole meeting's chunks, including any part before a pause.
        health.stop(Date.now(), store.manifest.chunks);
        status(true);
      });
      return stopping;
    },
  });
}
