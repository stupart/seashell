import { spawn, type ChildProcess } from 'child_process';
import {
  hasAudiblePcmSignal,
  LIVE_CAPTURE_CHUNK_MILLISECONDS,
  LIVE_CAPTURE_SAMPLE_RATE,
  PcmS16leChunker,
  pcmS16leSignalLevel,
  writeLivePcmChunk,
  type PcmSignalLevel,
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
}

export interface MicrophoneCaptureHandle {
  readonly process: ChildProcess;
  readonly done: Promise<void>;
  stop(): void;
}

/**
 * Capture one continuous microphone PCM stream. Chunk boundaries derive from
 * the sample count, not transcription completion or wall-clock polling.
 */
export function startMicrophoneCapture(options: StartMicrophoneOptions): MicrophoneCaptureHandle {
  const chunker = new PcmS16leChunker(
    LIVE_CAPTURE_SAMPLE_RATE,
    options.chunkMilliseconds ?? LIVE_CAPTURE_CHUNK_MILLISECONDS,
  );
  const minimumChunkMilliseconds = options.minimumChunkMilliseconds ?? 500;
  let firstBufferAtUnixMs: number | undefined;
  let requestedStop = false;
  let lastLevelUpdate = 0;
  let failure: string | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const publish = (chunk: ReturnType<PcmS16leChunker['flush']>) => {
    if (!chunk || firstBufferAtUnixMs === undefined) return;
    const durationMilliseconds = (chunk.endFrame - chunk.startFrame) * 1_000 /
      LIVE_CAPTURE_SAMPLE_RATE;
    if (durationMilliseconds < minimumChunkMilliseconds) return;
    const originOffset = Math.max(0, firstBufferAtUnixMs - options.sessionStartedAtUnixMs);
    const startSeconds = (originOffset + chunk.startFrame * 1_000 / LIVE_CAPTURE_SAMPLE_RATE) / 1_000;
    const endSeconds = (originOffset + chunk.endFrame * 1_000 / LIVE_CAPTURE_SAMPLE_RATE) / 1_000;
    const level = pcmS16leSignalLevel(chunk.pcm);
    const path = writeLivePcmChunk(chunk, 'microphone');
    try {
      options.onChunk(Object.freeze({
        path,
        startSeconds,
        endSeconds,
        sequence: chunk.sequence,
        source: 'microphone' as const,
        audible: hasAudiblePcmSignal(chunk.pcm),
        level,
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
    if (firstBufferAtUnixMs === undefined) {
      firstBufferAtUnixMs = Date.now();
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
    stop() {
      if (requestedStop) return;
      requestedStop = true;
      child.kill('SIGTERM');
    },
  };
}
