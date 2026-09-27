import { spawn, type ChildProcess } from 'child_process';
import { terminateManagedChild } from './process-lifecycle.ts';
import {
  hasAudiblePcmSignal,
  LIVE_CAPTURE_CHUNK_MILLISECONDS,
  LIVE_CAPTURE_SAMPLE_RATE,
  PcmS16leChunker,
  pcmS16leSignalLevel,
  writeLivePcmChunk,
  type PcmSignalLevel,
  type LiveCaptureClock,
  type SystemAudioCaptureState,
  type SystemAudioStateUpdate,
} from './live-system-audio.ts';

export interface MicrophoneChunk {
  readonly path: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly sequence: number;
  readonly source: 'microphone';
  readonly audible: boolean;
  readonly level: PcmSignalLevel;
  readonly clock: LiveCaptureClock;
}

export interface MicrophoneAttemptDiagnostic {
  readonly attempt: number;
  readonly pid?: number;
  readonly reason: 'startup-timeout' | 'stalled' | 'spawn-error' | 'chunk-error' | 'process-exit';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr?: string;
}

export interface MicrophoneStateUpdate extends SystemAudioStateUpdate {
  readonly diagnostic?: MicrophoneAttemptDiagnostic;
}

export interface StartMicrophoneOptions {
  readonly sessionStartedAtUnixMs: number;
  readonly chunkMilliseconds?: number;
  readonly minimumChunkMilliseconds?: number;
  readonly onChunk: (chunk: MicrophoneChunk) => void;
  readonly onState: (update: MicrophoneStateUpdate) => void;
  readonly onLevel?: (level: PcmSignalLevel) => void;
  /** Test/development override; production uses the fixed SoX command below. */
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  /** Deadline for releasing startup and terminating an attempt with no PCM. */
  readonly startupTimeoutMs?: number;
  readonly quietWarningMs?: number;
  readonly stalledTimeoutMs?: number;
  readonly maxRestarts?: number;
  readonly restartDelayMs?: number;
}

export interface MicrophoneCaptureHandle {
  readonly process: ChildProcess;
  readonly done: Promise<void>;
  /** Settles when the input opens or fails, so CoreAudio sources open in order. */
  readonly startup?: Promise<void>;
  stop(): void;
}

/**
 * Capture one continuous microphone PCM stream. Chunk boundaries derive from
 * the sample count, not transcription completion or wall-clock polling.
 */
export function startMicrophoneCapture(options: StartMicrophoneOptions): MicrophoneCaptureHandle {
  const maximumRestarts = options.maxRestarts ?? 2;
  let restarts = 0;
  let stopped = false;
  let cancelDelay: (() => void) | undefined;
  const start = () => startMicrophoneAttempt({ ...options, onState(update) {
    if (update.state === 'unavailable' && !stopped && restarts < maximumRestarts) {
      options.onState({ ...update, state: 'starting', code: 'microphone_reconnecting',
        message: `${update.message ?? 'Microphone capture failed.'} Retrying (${restarts + 1}/${maximumRestarts})…` });
    } else options.onState(update);
  } }, restarts + 1);
  let current = start();
  const startup = current.startup;
  const done = (async () => {
    while (true) {
      await current.done;
      if (stopped || restarts >= maximumRestarts) return;
      restarts++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { cancelDelay = undefined; resolve(); }, options.restartDelayMs ?? 1000);
        cancelDelay = () => { clearTimeout(timer); cancelDelay = undefined; resolve(); };
      });
      if (stopped) { options.onState({ state: 'stopped' }); return; }
      current = start();
    }
  })();
  return {
    get process() { return current.process; },
    startup, done,
    stop() { stopped = true; cancelDelay?.(); current.stop(); },
  };
}

function startMicrophoneAttempt(options: StartMicrophoneOptions, attempt: number): MicrophoneCaptureHandle {
  const chunker = new PcmS16leChunker(
    LIVE_CAPTURE_SAMPLE_RATE,
    options.chunkMilliseconds ?? LIVE_CAPTURE_CHUNK_MILLISECONDS,
  );
  const minimumChunkMilliseconds = options.minimumChunkMilliseconds ?? 500;
  const captureStartedAtUnixMs = Date.now();
  let clock: LiveCaptureClock | undefined;
  let requestedStop = false;
  let lastLevelUpdate = 0;
  let failure: string | undefined;
  let failureReason: MicrophoneAttemptDiagnostic['reason'] = 'process-exit';
  let lastDataAt = captureStartedAtUnixMs;
  let lastAudibleAt = captureStartedAtUnixMs;
  let quietWarning = false;
  let endingForFailure = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  let settleStartup = () => {};
  const startup = new Promise<void>((resolve) => { settleStartup = resolve; });
  const startupTimer = setTimeout(() => {
    if (clock || requestedStop) return;
    endingForFailure = true;
    failureReason = 'startup-timeout';
    failure = 'No microphone samples arrived before the startup deadline. Check the selected input and microphone access.';
    // Optional system audio must not wait forever for a microphone that never
    // opens. Release it before waiting for this child to terminate and retry.
    settleStartup();
    options.onState({ state: 'starting', code: 'microphone_no_audio',
      message: failure });
    void terminateManagedChild(child);
  }, options.startupTimeoutMs ?? 8_000);
  startupTimer.unref();
  const watchdog = setInterval(() => {
    if (!clock || requestedStop || endingForFailure) return;
    const now = Date.now();
    if (now - lastDataAt >= (options.stalledTimeoutMs ?? 8000)) {
      endingForFailure = true;
      failureReason = 'stalled';
      failure = 'Microphone stopped delivering audio. Check Sound → Input and reconnect your microphone.';
      void terminateManagedChild(child);
    } else if (!quietWarning && now - lastAudibleAt >= (options.quietWarningMs ?? 30000)) {
      quietWarning = true;
      options.onState({ state: 'active', code: 'microphone_quiet',
        message: 'No clear microphone signal yet. If you’re speaking, check your selected input, mute control, and input level.' });
    }
  }, Math.max(10, Math.min(1000, options.quietWarningMs ?? 30000, options.stalledTimeoutMs ?? 8000)));
  watchdog.unref();

  const publish = (chunk: ReturnType<PcmS16leChunker['flush']>) => {
    if (!chunk || clock === undefined) return;
    const durationMilliseconds = (chunk.endFrame - chunk.startFrame) * 1_000 /
      LIVE_CAPTURE_SAMPLE_RATE;
    if (durationMilliseconds < minimumChunkMilliseconds) return;
    const originOffset = Math.max(0, clock.originUnixMs - options.sessionStartedAtUnixMs);
    const startSeconds = (originOffset + chunk.startFrame * 1_000 / LIVE_CAPTURE_SAMPLE_RATE) / 1_000;
    const endSeconds = (originOffset + chunk.endFrame * 1_000 / LIVE_CAPTURE_SAMPLE_RATE) / 1_000;
    const level = pcmS16leSignalLevel(chunk.pcm);
    const audible = hasAudiblePcmSignal(chunk.pcm);
    if (audible) {
      lastAudibleAt = Date.now();
      if (quietWarning && !endingForFailure && !requestedStop) {
        quietWarning = false;
        options.onState({ state: 'active', message: 'Microphone signal detected' });
      }
    }
    const path = writeLivePcmChunk(chunk, 'microphone');
    try {
      options.onChunk(Object.freeze({
        path,
        startSeconds,
        endSeconds,
        sequence: chunk.sequence,
        source: 'microphone' as const,
        audible,
        level,
        clock,
      }));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      failureReason = 'chunk-error';
      endingForFailure = true;
      void terminateManagedChild(child);
    }
  };

  options.onState({ state: 'starting', message: 'Opening microphone…' });
  const defaultArguments = [
    '-q',
    '-d',
    '-t', 'raw',
    '-r', String(LIVE_CAPTURE_SAMPLE_RATE),
    '-c', '1',
    '-b', '16',
    '-e', 'signed-integer',
    '-',
  ];
  const child = spawn(options.command ?? 'sox', options.commandArgs ?? defaultArguments, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2_000); });
  child.stdout?.on('data', (data: Buffer) => {
    if (endingForFailure) return;
    lastDataAt = Date.now();
    if (clock === undefined) {
      clearTimeout(startupTimer);
      settleStartup();
      const firstDataAtUnixMs = Date.now();
      clock = Object.freeze({
        kind: 'process-start-estimate' as const,
        originUnixMs: captureStartedAtUnixMs,
        sampleRate: LIVE_CAPTURE_SAMPLE_RATE,
        uncertaintyMs: Math.max(1, firstDataAtUnixMs - captureStartedAtUnixMs),
      });
      options.onState({ state: 'active', message: 'Microphone input connected' });
    }
    const now = Date.now();
    if (options.onLevel && now - lastLevelUpdate >= 500 && data.byteLength >= 2) {
      lastLevelUpdate = now;
      options.onLevel(pcmS16leSignalLevel(data.subarray(0, data.byteLength - data.byteLength % 2)));
    }
    for (const chunk of chunker.append(data)) publish(chunk);
  });
  child.on('error', (error) => { failure = error.message; failureReason = 'spawn-error'; });
  child.on('close', (code, signal) => {
    clearTimeout(startupTimer);
    clearInterval(watchdog);
    settleStartup();
    publish(chunker.flush());
    const state: SystemAudioCaptureState = requestedStop ? 'stopped' : 'unavailable';
    const recordedStderr = stderr.trim();
    const exitDescription = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
    options.onState({
      state,
      ...(requestedStop
        ? {}
        : {
            code: failureReason === 'startup-timeout' ? 'microphone_no_audio' : 'microphone_stopped',
            message: `${failure ?? 'Microphone capture ended unexpectedly.'} Attempt ${attempt}: ${exitDescription}.${recordedStderr ? ` Recorder: ${recordedStderr}` : ''}`,
            diagnostic: Object.freeze({ attempt, ...(child.pid === undefined ? {} : { pid: child.pid }),
              reason: failureReason, exitCode: code, signal,
              ...(recordedStderr ? { stderr: recordedStderr } : {}),
            }),
          }),
    });
    resolveDone();
  });

  return {
    process: child,
    done,
    startup,
    stop() {
      if (requestedStop) return;
      requestedStop = true;
      clearTimeout(startupTimer);
      clearInterval(watchdog);
      child.kill('SIGINT');
      const terminate = setTimeout(() => {
        void terminateManagedChild(child);
      }, 1_500);
      terminate.unref();
      void done.then(() => clearTimeout(terminate));
    },
  };
}
