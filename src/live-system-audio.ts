import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SYSTEM_AUDIO_HELPER = join(
  PROJECT_ROOT,
  'native',
  'bin',
  'seashell-system-audio',
);
export const LIVE_CAPTURE_SAMPLE_RATE = 16_000;
export const LIVE_CAPTURE_CHUNK_MILLISECONDS = 10_000;

export type SystemAudioCaptureState = 'starting' | 'active' | 'unavailable' | 'stopped';

export interface LiveCaptureClock {
  readonly kind: 'device-sample-clock' | 'process-start-estimate';
  readonly originUnixMs: number;
  readonly sampleRate: 16_000;
  readonly uncertaintyMs: number;
  readonly hostTime?: string;
  readonly sampleTime?: number;
}

export interface LiveCaptureDiscontinuity {
  readonly atFrame: number;
  readonly durationFrames: number;
  readonly reason: 'capture-overrun' | 'device-reset' | 'clock-reset';
}

export interface SystemAudioChunk {
  readonly path: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly sequence: number;
  readonly source: 'system-audio';
  readonly audible: boolean;
  readonly level: PcmSignalLevel;
  readonly clock: LiveCaptureClock;
}

export interface SystemAudioStateUpdate {
  readonly state: SystemAudioCaptureState;
  readonly message?: string;
  readonly code?: string;
}

export type NativeSystemAudioEvent =
  | {
      readonly type: 'start';
      readonly sampleRate: number;
      readonly channels: number;
      readonly bitsPerChannel: number;
    }
  | {
      readonly type: 'first-buffer';
      readonly capturedAtUnixMs: number;
      readonly bufferStartUnixMs?: number;
      readonly sourceSampleRate?: number;
      readonly hostTime?: string;
      readonly sampleTime?: number;
      readonly bufferFrames?: number;
    }
  | {
      readonly type: 'discontinuity';
      readonly droppedFrames: number;
      readonly outputFrames: number;
      readonly reason: 'capture-overrun';
    }
  | {
      readonly type: 'error';
      readonly code: string;
      readonly message: string;
      readonly operation?: string;
      readonly status?: number;
    }
  | { readonly type: 'stop' };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return Number(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing`);
  return value.trim();
}

/** Strictly parse the JSONL control stream emitted on the native helper's stderr. */
export function parseNativeSystemAudioEvent(line: string): NativeSystemAudioEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error('System-audio helper emitted malformed JSON', { cause: error });
  }
  if (!record(value)) throw new Error('System-audio helper event must be an object');
  if (value.type === 'start') {
    return Object.freeze({
      type: 'start' as const,
      sampleRate: integer(value.sampleRate, 'System-audio sample rate', 1),
      channels: integer(value.channels, 'System-audio channel count', 1),
      bitsPerChannel: integer(value.bitsPerChannel, 'System-audio bit depth', 1),
    });
  }
  if (value.type === 'first-buffer') {
    return Object.freeze({
      type: 'first-buffer' as const,
      capturedAtUnixMs: integer(value.capturedAtUnixMs, 'System-audio first-buffer time'),
      ...(value.bufferStartUnixMs === undefined
        ? {}
        : { bufferStartUnixMs: integer(value.bufferStartUnixMs, 'System-audio buffer start time') }),
      ...(value.sourceSampleRate === undefined
        ? {}
        : { sourceSampleRate: integer(value.sourceSampleRate, 'System-audio source sample rate', 1) }),
      ...(value.hostTime === undefined ? {} : { hostTime: text(value.hostTime, 'System-audio host time') }),
      ...(value.sampleTime === undefined
        ? {}
        : { sampleTime: finiteNumber(value.sampleTime, 'System-audio sample time') }),
      ...(value.bufferFrames === undefined
        ? {}
        : { bufferFrames: integer(value.bufferFrames, 'System-audio first-buffer frame count', 1) }),
    });
  }
  if (value.type === 'discontinuity') {
    if (value.reason !== 'capture-overrun') {
      throw new Error('System-audio discontinuity reason is invalid');
    }
    return Object.freeze({
      type: 'discontinuity' as const,
      droppedFrames: integer(value.droppedFrames, 'System-audio dropped frame count', 1),
      outputFrames: integer(value.outputFrames, 'System-audio discontinuity output frame', 0),
      reason: 'capture-overrun' as const,
    });
  }
  if (value.type === 'error') {
    return Object.freeze({
      type: 'error' as const,
      code: text(value.code, 'System-audio error code'),
      message: text(value.message, 'System-audio error message'),
      ...(value.operation === undefined
        ? {}
        : { operation: text(value.operation, 'System-audio error operation') }),
      ...(value.status === undefined
        ? {}
        : { status: integer(value.status, 'System-audio error status', Number.MIN_SAFE_INTEGER) }),
    });
  }
  if (value.type === 'stop') return Object.freeze({ type: 'stop' as const });
  throw new Error(`Unknown system-audio event type: ${String(value.type)}`);
}

export interface PcmChunk {
  readonly sequence: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly pcm: Buffer;
}

/** Split a raw signed-16-bit mono stream without losing bytes across process chunks. */
export class PcmS16leChunker {
  private pending = Buffer.alloc(0);
  private emittedFrames = 0;
  private sequence = 0;
  private readonly bytesPerChunk: number;

  constructor(
    readonly sampleRate: number,
    readonly chunkMilliseconds: number,
  ) {
    integer(sampleRate, 'PCM sample rate', 1);
    integer(chunkMilliseconds, 'PCM chunk duration', 1);
    const frames = Math.round(sampleRate * chunkMilliseconds / 1_000);
    this.bytesPerChunk = frames * 2;
  }

  append(data: Uint8Array): readonly PcmChunk[] {
    if (data.byteLength === 0) return [];
    this.pending = Buffer.concat([this.pending, Buffer.from(data)]);
    const chunks: PcmChunk[] = [];
    while (this.pending.length >= this.bytesPerChunk) {
      const pcm = Buffer.from(this.pending.subarray(0, this.bytesPerChunk));
      this.pending = Buffer.from(this.pending.subarray(this.bytesPerChunk));
      chunks.push(this.chunk(pcm));
    }
    return chunks;
  }

  flush(): PcmChunk | undefined {
    const evenBytes = this.pending.length - (this.pending.length % 2);
    if (evenBytes === 0) return undefined;
    const pcm = Buffer.from(this.pending.subarray(0, evenBytes));
    this.pending = Buffer.alloc(0);
    return this.chunk(pcm);
  }

  private chunk(pcm: Buffer): PcmChunk {
    const startFrame = this.emittedFrames;
    const frames = pcm.length / 2;
    this.emittedFrames += frames;
    this.sequence += 1;
    return Object.freeze({
      sequence: this.sequence,
      startFrame,
      endFrame: this.emittedFrames,
      pcm,
    });
  }
}

/** Wrap mono signed-16-bit PCM in an independently decodable WAV container. */
export function pcmS16leToWav(
  pcm: Uint8Array,
  sampleRate = LIVE_CAPTURE_SAMPLE_RATE,
  channels = 1,
): Buffer {
  integer(sampleRate, 'WAV sample rate', 1);
  integer(channels, 'WAV channel count', 1);
  if (pcm.byteLength % (channels * 2) !== 0) {
    throw new Error('PCM byte length does not contain complete signed-16-bit frames');
  }
  if (pcm.byteLength > 0xffff_ffff - 36) throw new Error('PCM chunk is too large for WAV');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

export interface PcmSignalLevel {
  readonly peak: number;
  readonly rms: number;
  readonly rmsDbfs: number;
}

export function pcmS16leSignalLevel(pcm: Uint8Array): PcmSignalLevel {
  if (pcm.byteLength % 2 !== 0) throw new Error('PCM signal contains an incomplete sample');
  if (pcm.byteLength === 0) return { peak: 0, rms: 0, rmsDbfs: Number.NEGATIVE_INFINITY };
  const buffer = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let peak = 0;
  let squareSum = 0;
  const samples = pcm.byteLength / 2;
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    const value = buffer.readInt16LE(offset);
    const magnitude = Math.abs(value);
    peak = Math.max(peak, magnitude);
    squareSum += value * value;
  }
  const rms = Math.sqrt(squareSum / samples);
  const rmsDbfs = rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms / 32_768);
  return Object.freeze({ peak, rms, rmsDbfs });
}

/** Avoid spending Whisper work on digital silence while retaining quiet speech. */
export function hasAudiblePcmSignal(pcm: Uint8Array): boolean {
  const level = pcmS16leSignalLevel(pcm);
  return level.peak >= 128 && level.rmsDbfs >= -55;
}

export function writeLivePcmChunk(chunk: PcmChunk, source: string): string {
  const safeSource = source.replace(/[^a-z0-9-]+/giu, '-').replace(/^-|-$/gu, '') || 'audio';
  const filename = `seashell-${safeSource}-${process.pid}-${randomUUID()}-${chunk.sequence}.wav`;
  const destination = join(tmpdir(), filename);
  const temporary = join(tmpdir(), `.${filename}.partial`);
  try {
    writeFileSync(temporary, pcmS16leToWav(chunk.pcm), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, destination);
    return destination;
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function permissionMessage(event: Extract<NativeSystemAudioEvent, { type: 'error' }>): string {
  if (event.code === 'permission_denied') {
    return 'Allow Sea Shell (or your terminal) in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen Sea Shell.';
  }
  if (event.code === 'unsupported_os') return event.message;
  return `${event.message} (${event.code})`;
}

export interface StartSystemAudioOptions {
  readonly sessionStartedAtUnixMs: number;
  readonly helperPath?: string;
  readonly chunkMilliseconds?: number;
  readonly minimumChunkMilliseconds?: number;
  readonly onChunk: (chunk: SystemAudioChunk) => void;
  readonly onState: (update: SystemAudioStateUpdate) => void;
  readonly onLevel?: (level: PcmSignalLevel) => void;
  readonly onDiscontinuity?: (event: LiveCaptureDiscontinuity) => void;
}

export interface SystemAudioCaptureHandle {
  readonly process?: ChildProcess;
  readonly done: Promise<void>;
  stop(): void;
}

export function startSystemAudioCapture(
  options: StartSystemAudioOptions,
): SystemAudioCaptureHandle {
  const helperPath = options.helperPath ?? SYSTEM_AUDIO_HELPER;
  if (!existsSync(helperPath)) {
    options.onState({
      state: 'unavailable',
      code: 'helper_missing',
      message: `System-audio helper is missing. Run ./install.sh (${basename(helperPath)}).`,
    });
    return { done: Promise.resolve(), stop() {} };
  }
  const chunkMilliseconds = options.chunkMilliseconds ?? LIVE_CAPTURE_CHUNK_MILLISECONDS;
  const minimumChunkMilliseconds = options.minimumChunkMilliseconds ?? 500;
  const chunker = new PcmS16leChunker(LIVE_CAPTURE_SAMPLE_RATE, chunkMilliseconds);
  let firstBufferAtUnixMs: number | undefined;
  let clock: LiveCaptureClock | undefined;
  const pendingDiscontinuities: Extract<NativeSystemAudioEvent, { type: 'discontinuity' }>[] = [];
  let requestedStop = false;
  let nativeError: Extract<NativeSystemAudioEvent, { type: 'error' }> | undefined;
  let stderr = '';
  const waiting: PcmChunk[] = [];
  let lastLevelUpdate = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const publish = (chunk: PcmChunk) => {
    if (firstBufferAtUnixMs === undefined || clock === undefined) {
      waiting.push(chunk);
      return;
    }
    const durationMilliseconds = (chunk.endFrame - chunk.startFrame) * 1_000 /
      LIVE_CAPTURE_SAMPLE_RATE;
    if (durationMilliseconds < minimumChunkMilliseconds) return;
    const level = pcmS16leSignalLevel(chunk.pcm);
    const audible = hasAudiblePcmSignal(chunk.pcm);
    const originOffset = Math.max(0, firstBufferAtUnixMs - options.sessionStartedAtUnixMs);
    const startSeconds = (originOffset + chunk.startFrame * 1_000 / LIVE_CAPTURE_SAMPLE_RATE) / 1_000;
    const endSeconds = (originOffset + chunk.endFrame * 1_000 / LIVE_CAPTURE_SAMPLE_RATE) / 1_000;
    const path = writeLivePcmChunk(chunk, 'system');
    try {
      options.onChunk(Object.freeze({
        path,
        startSeconds,
        endSeconds,
        sequence: chunk.sequence,
        source: 'system-audio' as const,
        audible,
        level,
        clock,
      }));
    } catch (error) {
      try { unlinkSync(path); } catch {}
      throw error;
    }
  };

  options.onState({ state: 'starting', message: 'Requesting system-audio access…' });
  const child = spawn(helperPath, [
    '--sample-rate', String(LIVE_CAPTURE_SAMPLE_RATE),
    '--chunk-ms', '100',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout?.on('data', (data: Buffer) => {
    try {
      const now = Date.now();
      if (options.onLevel && now - lastLevelUpdate >= 500 && data.byteLength >= 2) {
        lastLevelUpdate = now;
        options.onLevel(pcmS16leSignalLevel(data.subarray(0, data.byteLength - data.byteLength % 2)));
      }
      for (const chunk of chunker.append(data)) publish(chunk);
    } catch (error) {
      nativeError = {
        type: 'error',
        code: 'chunk_failed',
        message: error instanceof Error ? error.message : String(error),
      };
      child.kill('SIGTERM');
    }
  });

  const publishDiscontinuity = (
    event: Extract<NativeSystemAudioEvent, { type: 'discontinuity' }>,
  ) => {
    if (firstBufferAtUnixMs === undefined) {
      pendingDiscontinuities.push(event);
      return;
    }
    const originOffsetFrames = Math.max(
      0,
      Math.round((firstBufferAtUnixMs - options.sessionStartedAtUnixMs) *
        LIVE_CAPTURE_SAMPLE_RATE / 1_000),
    );
    options.onDiscontinuity?.({
      atFrame: originOffsetFrames + event.outputFrames,
      durationFrames: event.droppedFrames,
      reason: event.reason,
    });
  };

  const consumeEventLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = parseNativeSystemAudioEvent(line);
      if (event.type === 'first-buffer') {
        const firstBufferDurationMs = (event.bufferFrames ?? 0) * 1_000 /
          (event.sourceSampleRate ?? LIVE_CAPTURE_SAMPLE_RATE);
        const precedingGapMs = pendingDiscontinuities.reduce(
          (total, gap) => total + gap.droppedFrames * 1_000 / LIVE_CAPTURE_SAMPLE_RATE,
          0,
        );
        firstBufferAtUnixMs = Math.max(
          options.sessionStartedAtUnixMs,
          Math.round(
            (event.bufferStartUnixMs ?? event.capturedAtUnixMs - firstBufferDurationMs) -
            precedingGapMs,
          ),
        );
        clock = Object.freeze({
          kind: 'device-sample-clock' as const,
          originUnixMs: firstBufferAtUnixMs,
          sampleRate: LIVE_CAPTURE_SAMPLE_RATE,
          uncertaintyMs: event.bufferStartUnixMs === undefined
            ? Math.max(1, firstBufferDurationMs)
            : 2,
          ...(event.hostTime === undefined ? {} : { hostTime: event.hostTime }),
          ...(event.sampleTime === undefined ? {} : { sampleTime: event.sampleTime }),
        });
        options.onState({ state: 'active', message: 'Microphone + system audio' });
        for (const gap of pendingDiscontinuities.splice(0)) publishDiscontinuity(gap);
        for (const chunk of waiting.splice(0)) publish(chunk);
      } else if (event.type === 'discontinuity') {
        publishDiscontinuity(event);
      } else if (event.type === 'error') {
        nativeError = event;
      }
    } catch (error) {
      nativeError = {
        type: 'error',
        code: 'protocol_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString('utf8');
    const lines = stderr.split('\n');
    stderr = lines.pop() ?? '';
    for (const line of lines) consumeEventLine(line);
  });

  child.on('error', (error) => {
    nativeError = { type: 'error', code: 'spawn_failed', message: error.message };
  });
  child.on('close', (code, signal) => {
    if (stderr.trim()) consumeEventLine(stderr);
    const final = chunker.flush();
    if (final) {
      try { publish(final); } catch {}
    }
    if (requestedStop) {
      options.onState({ state: 'stopped' });
      resolveDone();
      return;
    }
    const failure = nativeError ?? {
      type: 'error' as const,
      code: 'capture_stopped',
      message: signal ? `System-audio capture stopped by ${signal}` : `System-audio capture exited ${code}`,
    };
    options.onState({
      state: 'unavailable',
      code: failure.code,
      message: permissionMessage(failure),
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
