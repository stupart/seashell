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

export interface StartMicrophoneOptions {
  readonly sessionStartedAtUnixMs: number;
  readonly chunkMilliseconds?: number;
  readonly minimumChunkMilliseconds?: number;
  readonly onChunk: (chunk: MicrophoneChunk) => void;
  readonly onState: (update: SystemAudioStateUpdate) => void;
  readonly onLevel?: (level: PcmSignalLevel) => void;
  /** Test/development override; production uses the fixed SoX command below. */
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  /** Deadline for reporting a source that never supplies PCM. */
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
      options.onState({ state: 'starting', code: 'microphone_reconnecting',
        message: 'Microphone disconnected · reconnecting…' });
    } else options.onState(update);
  } });
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

function startMicrophoneAttempt(options: StartMicrophoneOptions): MicrophoneCaptureHandle {
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
  let lastDataAt = captureStartedAtUnixMs;
  let lastAudibleAt = captureStartedAtUnixMs;
  let quietWarning = false;
  let stalled = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  let settleStartup = () => {};
  const startup = new Promise<void>((resolve) => { settleStartup = resolve; });
  const startupTimer = setTimeout(() => {
    options.onState({ state: 'starting', code: 'microphone_no_audio',
      message: 'No microphone audio received. Check System Settings → Privacy & Security → Microphone for your terminal app, and Sound → Input. Then press Space twice to retry.' });
  }, options.startupTimeoutMs ?? 8_000);
  startupTimer.unref();
  const watchdog = setInterval(() => {
    if (!clock || requestedStop || stalled) return;
    const now = Date.now();
    if (now - lastDataAt >= (options.stalledTimeoutMs ?? 8000)) {
      stalled = true;
      failure = 'Microphone stopped delivering audio. Check Sound → Input and reconnect your microphone.';
      void terminateManagedChild(child);
    } else if (!quietWarning && now - lastAudibleAt >= (options.quietWarningMs ?? 30000)) {
      quietWarning = true;
      options.onState({ state: 'active', code: 'microphone_quiet',
        message: 'Microphone is very quiet. If you’re speaking, check Sound → Input and its input level.' });
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
      if (quietWarning) {
        quietWarning = false;
        options.onState({ state: 'active', message: 'Microphone active' });
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
      child.kill('SIGTERM');
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
      options.onState({ state: 'active', message: 'Microphone active' });
    }
    const now = Date.now();
    if (options.onLevel && now - lastLevelUpdate >= 500 && data.byteLength >= 2) {
      lastLevelUpdate = now;
      options.onLevel(pcmS16leSignalLevel(data.subarray(0, data.byteLength - data.byteLength % 2)));
    }
    for (const chunk of chunker.append(data)) publish(chunk);
  });
  child.on('error', (error) => { failure = error.message; });
  child.on('close', (code, signal) => {
    clearTimeout(startupTimer);
    clearInterval(watchdog);
    settleStartup();
    publish(chunker.flush());
    const state: SystemAudioCaptureState = requestedStop ? 'stopped' : 'unavailable';
    options.onState({
      state,
      ...(requestedStop
        ? {}
        : {
            code: 'microphone_stopped',
            message: (failure ?? stderr.trim()) || (signal
              ? `Microphone capture stopped by ${signal}`
              : `Microphone capture exited ${code}`),
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
