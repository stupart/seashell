import { randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  captureChunkPath,
  type CaptureSessionStore,
  loadCaptureSession,
  readVerifiedCaptureChunk,
  type CaptureSessionManifest,
  type CaptureTrackId,
} from './capture-session.ts';
import { diarizationEnvironment, diarizationStatus } from './diarization-environment.ts';
import { isLikelySystemAudioLeak } from './live-echo.ts';
import { amplifyPcm, hasAudiblePcmSignal, pcmS16leSignalLevel, pcmS16leToWav, quietAudioGain } from './live-system-audio.ts';
import { createTranscriptRecord } from './transcript-record.ts';
import { saveTranscriptRecord } from './transcript-library.ts';
import { coalesceTranscriptSegments } from './transcript-renderer.ts';
import type {
  StructuredTranscript,
  TranscriptRecord,
  TranscriptSegment,
} from './transcript-types.ts';
import { transcribeMedia } from './transcription-service.ts';
import { transcribeWithTimestamps } from './whisper-timestamps.ts';
import {
  runHumainTranscription,
  type HumainTranscriptionRoute,
} from './humain-client.ts';

const SAMPLE_RATE = 16_000;
const BYTES_PER_FRAME = 2;

function wavPcm(wav: Buffer, path: string): Buffer {
  if (wav.length < 44 || wav.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      wav.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error(`Capture chunk is not a WAV file: ${path}`);
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString('ascii');
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) throw new Error(`Capture chunk has a truncated ${id} section: ${path}`);
    if (id === 'data') return wav.subarray(start, end);
    offset = end + (size % 2);
  }
  throw new Error(`Capture chunk has no PCM data section: ${path}`);
}

function writeZeros(descriptor: number, bytes: number): void {
  const block = Buffer.alloc(Math.min(64 * 1024, Math.max(0, bytes)));
  let remaining = bytes;
  while (remaining > 0) {
    const length = Math.min(remaining, block.length);
    writeSync(descriptor, block, 0, length);
    remaining -= length;
  }
}

/** Build a continuous track without loading the whole meeting into memory. */
export function assembleCaptureTrack(
  manifestPath: string,
  manifest: CaptureSessionManifest,
  trackId: CaptureTrackId,
  destination?: string,
  options: { normalizeQuiet?: boolean } = {},
): string | undefined {
  const chunks = manifest.chunks.filter((chunk) => chunk.trackId === trackId)
    .toSorted((left, right) => left.startMs - right.startMs || left.sequence - right.sequence);
  if (chunks.length === 0) return undefined;
  let peak = 0;
  if (options.normalizeQuiet) {
    for (const chunk of chunks) {
      const pcm = wavPcm(readVerifiedCaptureChunk(manifestPath, chunk), captureChunkPath(manifestPath, chunk));
      peak = Math.max(peak, pcmS16leSignalLevel(pcm).peak);
    }
  }
  const gain = options.normalizeQuiet ? quietAudioGain(peak) : 1;
  const output = destination ?? join(
    tmpdir(),
    `seashell-final-${manifest.sessionId}-${trackId}-${randomUUID()}.wav`,
  );
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.partial`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  let writtenFrames = 0;
  try {
    writeSync(descriptor, Buffer.alloc(44));
    for (const chunk of chunks) {
      const desiredStartFrame = Math.round(chunk.startMs * SAMPLE_RATE / 1_000);
      if (desiredStartFrame > writtenFrames) {
        writeZeros(descriptor, (desiredStartFrame - writtenFrames) * BYTES_PER_FRAME);
        writtenFrames = desiredStartFrame;
      }
      const pcm = amplifyPcm(wavPcm(readVerifiedCaptureChunk(manifestPath, chunk), captureChunkPath(manifestPath, chunk)), gain);
      const overlapFrames = Math.max(0, writtenFrames - desiredStartFrame);
      const offset = Math.min(pcm.length, overlapFrames * BYTES_PER_FRAME);
      if (offset < pcm.length) {
        writeSync(descriptor, pcm, offset, pcm.length - offset);
        writtenFrames += (pcm.length - offset) / BYTES_PER_FRAME;
      }
    }
    const dataBytes = writtenFrames * BYTES_PER_FRAME;
    const header = pcmS16leToWav(Buffer.alloc(0));
    header.writeUInt32LE(36 + dataBytes, 4);
    header.writeUInt32LE(dataBytes, 40);
    writeSync(descriptor, header, 0, header.length, 0);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(descriptor);
  renameSync(temporary, output);
  return output;
}

function trackSegments(
  units: Awaited<ReturnType<typeof transcribeWithTimestamps>>,
  speaker: 'LOCAL' | 'SYSTEM',
): TranscriptSegment[] {
  return coalesceTranscriptSegments({
    transcript: units.map((unit) => ({
      start: unit.start,
      end: unit.end,
      text: unit.text,
      speaker,
    })),
    speakers: [],
  });
}

function remoteSpeakerId(id: string): string {
  return `REMOTE_${id.replace(/[^A-Za-z0-9._-]+/gu, '_')}`;
}

/** Reconcile speaker playback while preserving remote diarization identities. */
export function reconcileCaptureEcho(
  existing: readonly TranscriptSegment[],
  incoming: TranscriptSegment,
): readonly TranscriptSegment[] {
  if (incoming.speaker === 'LOCAL') {
    const duplicate = existing.some((segment) => (
      segment.speaker !== undefined && segment.speaker !== 'LOCAL' &&
      isLikelySystemAudioLeak(incoming, { ...segment, speaker: 'SYSTEM' })
    ));
    return duplicate ? existing : [...existing, incoming].toSorted((left, right) =>
      left.start - right.start || left.end - right.end);
  }
  const systemShadow = { ...incoming, speaker: 'SYSTEM' };
  const retained = existing.filter((segment) => !(
    segment.speaker === 'LOCAL' && isLikelySystemAudioLeak(segment, systemShadow)
  ));
  return [...retained, incoming].toSorted((left, right) =>
    left.start - right.start || left.end - right.end);
}

export interface FinalizeCaptureOptions {
  readonly onStatus?: (message: string) => void;
  readonly title?: string;
  /** Defaults to true only when the fully local pyannote capability is ready. */
  readonly diarizeSystemAudio?: boolean;
  /** Explicit retry should report a failure; automatic finalization keeps source text. */
  readonly strictSpeakers?: boolean;
  /** Test/provider seam; output timing must use the supplied track's clock. */
  readonly systemDiarizer?: (path: string) => Promise<StructuredTranscript>;
  readonly localTranscriber?: typeof transcribeWithTimestamps;
  /** Explicit pinned remote canonical route. Omit to keep the final fully local. */
  readonly remoteRoute?: HumainTranscriptionRoute;
  /** Test/provider seam. Production defaults to the Humain CLI boundary. */
  readonly remoteTranscriber?: typeof runHumainTranscription;
}

/** A stopped draft queue is not a complete transcript. Publish only a canonical
 * pass over the durable audio, or a canonical record already produced by the
 * meeting flow. Failures leave the bundle in the recoverable capture store. */
export async function saveFinalizedCapture(
  store: CaptureSessionStore,
  libraryDir: string,
  reason: string,
  options: FinalizeCaptureOptions & { readonly finalizedRecord?: TranscriptRecord } = {},
): Promise<TranscriptRecord> {
  try {
    await store.drainCommits();
    const record = options.finalizedRecord ?? await finalizeCaptureTranscript(store.manifestPath, options);
    const saved = saveTranscriptRecord(libraryDir, record);
    store.setStatus('completed', reason);
    store.attachTo(saved.directory);
    return record;
  } catch (error) {
    store.setStatus('interrupted', 'finalization-failed');
    throw error;
  }
}

async function remoteTrackSegments(
  manifestPath: string,
  manifest: CaptureSessionManifest,
  trackId: CaptureTrackId,
  speaker: 'LOCAL' | 'SYSTEM',
  route: HumainTranscriptionRoute,
  transcriber: typeof runHumainTranscription,
  onStatus?: (message: string) => void,
): Promise<TranscriptSegment[]> {
  const chunks = manifest.chunks.filter((chunk) => chunk.trackId === trackId && chunk.audible)
    .toSorted((left, right) => left.startMs - right.startMs || left.sequence - right.sequence);
  const segments: TranscriptSegment[] = [];
  for (const [index, chunk] of chunks.entries()) {
    onStatus?.(`Cloud final ${trackId} ${index + 1}/${chunks.length}…`);
    const result = await transcriber(captureChunkPath(manifestPath, chunk), route, {
      storeDir: join(dirname(manifestPath), 'humain-runs'),
      runId: `final-${manifest.sessionId}-${trackId}-${chunk.sequence}-${randomUUID().slice(0, 8)}`,
    });
    segments.push(...result.output.segments.map((segment) => ({
      start: (chunk.startMs + segment.startMs) / 1_000,
      end: (chunk.startMs + segment.endMs) / 1_000,
      text: segment.text,
      speaker,
    })));
  }
  return coalesceTranscriptSegments({ transcript: segments, speakers: [] });
}

/** Re-run ASR over each complete source track and publish one canonical record. */
export async function finalizeCaptureTranscript(
  manifestPath: string,
  options: FinalizeCaptureOptions = {},
): Promise<TranscriptRecord> {
  const absoluteManifest = resolve(manifestPath);
  const manifest = loadCaptureSession(absoluteManifest);
  const temporaryTracks: string[] = [];
  try {
    const hasMicrophone = manifest.chunks.some((chunk) => chunk.trackId === 'microphone');
    const hasSystem = manifest.chunks.some((chunk) => chunk.trackId === 'system-audio');
    // Older captures used a whole-chunk average that dropped quiet/short speech.
    // Re-evaluate local raw audio instead of treating that old draft flag as truth.
    const audibleMicrophone = manifest.chunks.some((chunk) => chunk.trackId === 'microphone' &&
      (chunk.audible || (!options.remoteRoute && hasAudiblePcmSignal(wavPcm(
        readVerifiedCaptureChunk(absoluteManifest, chunk), captureChunkPath(absoluteManifest, chunk),
      )))));
    const audibleSystem = manifest.chunks.some((chunk) =>
      chunk.trackId === 'system-audio' && chunk.audible);
    if (!hasMicrophone && !hasSystem) throw new Error('Capture session has no audio chunks');

    if (options.remoteRoute) {
      // Check the entire bundle before the first potentially paid/uploading
      // dispatch. A damaged later chunk must not produce a partial cloud run.
      for (const chunk of manifest.chunks) readVerifiedCaptureChunk(absoluteManifest, chunk);
    }

    let microphone: string | undefined;
    let system: string | undefined;
    if (!options.remoteRoute) {
      options.onStatus?.('Assembling microphone track…');
      microphone = assembleCaptureTrack(absoluteManifest, manifest, 'microphone', undefined, { normalizeQuiet: true });
      if (microphone) temporaryTracks.push(microphone);
      options.onStatus?.('Assembling system-audio track…');
      system = assembleCaptureTrack(absoluteManifest, manifest, 'system-audio');
      if (system) temporaryTracks.push(system);
    }

    const segments: TranscriptSegment[] = [];
    let speakerAnalysis: NonNullable<StructuredTranscript['speakerAnalysis']> = {
      status: 'source-only', detail: 'Labels identify audio sources, not individual people.',
    };
    if (audibleMicrophone) {
      if (options.remoteRoute) {
        segments.push(...await remoteTrackSegments(
          absoluteManifest, manifest, 'microphone', 'LOCAL', options.remoteRoute,
          options.remoteTranscriber ?? runHumainTranscription, options.onStatus,
        ));
      } else if (microphone) {
        options.onStatus?.('Final microphone transcription…');
        segments.push(...trackSegments(await (options.localTranscriber ?? transcribeWithTimestamps)(microphone), 'LOCAL'));
      }
    }
    if (audibleSystem) {
      const useDiarization = options.remoteRoute === undefined &&
        (options.diarizeSystemAudio ?? diarizationStatus().ready);
      let separated = false;
      if (useDiarization && system) {
        options.onStatus?.('Separating remote speakers…');
        try {
          const document = options.systemDiarizer
            ? await options.systemDiarizer(system)
            : await transcribeMedia(system, { speakers: true, title: options.title, onStatus: options.onStatus });
          const speakerIds = new Map(document.speakers.map((speaker) => [speaker.id, remoteSpeakerId(speaker.id)]));
          // The final combined timeline needs fresh evidence IDs. Per-track IDs can collide.
          segments.push(...document.transcript.map(({ id: _id, ...segment }) => ({ ...segment,
            speaker: speakerIds.get(segment.speaker ?? '') ?? remoteSpeakerId('UNKNOWN'),
          })));
          separated = true;
          speakerAnalysis = { status: 'complete', model: diarizationEnvironment().model,
            detail: 'Remote voices separated locally. Microphone is a separate source; names need confirmation.' };
        } catch (error) {
          if (options.strictSpeakers) throw error;
          speakerAnalysis = { status: 'failed', detail: 'Speaker separation failed. Transcript kept with source labels. Press V to check setup or retry.' };
          options.onStatus?.(speakerAnalysis.detail);
        }
      } else if (!options.remoteRoute && options.diarizeSystemAudio !== false) {
        speakerAnalysis = { status: 'unavailable', detail: 'Source labels only. Press V to set up local speaker separation.' };
      }
      if (!separated) {
        if (options.remoteRoute) {
          segments.push(...await remoteTrackSegments(
            absoluteManifest, manifest, 'system-audio', 'SYSTEM', options.remoteRoute,
            options.remoteTranscriber ?? runHumainTranscription, options.onStatus,
          ));
        } else if (system) {
          options.onStatus?.('Final system-audio transcription…');
          segments.push(...trackSegments(await (options.localTranscriber ?? transcribeWithTimestamps)(system), 'SYSTEM'));
        }
      }
    }
    const reconciled = segments.toSorted((left, right) => left.start - right.start)
      .reduce<readonly TranscriptSegment[]>((current, segment) => (
        reconcileCaptureEcho(current, segment)
      ), []);
    const remoteSpeakerIds = [...new Set(reconciled.flatMap((segment) => (
      segment.speaker?.startsWith('REMOTE_') ? [segment.speaker] : []
    )))];
    const duration = Math.max(0, ...manifest.chunks.map((chunk) => chunk.endMs)) / 1_000;
    return createTranscriptRecord({
      speakerAnalysis,
      transcript: [...reconciled],
      speakers: [
        ...(hasMicrophone
          ? [{ id: 'LOCAL', label: 'Microphone' }]
          : []),
        ...(hasSystem
          ? remoteSpeakerIds.length > 0
            ? remoteSpeakerIds.map((id, index) => ({ id, label: id === 'REMOTE_UNKNOWN' ? 'Unknown remote speaker' : `Remote speaker ${index + 1}` }))
            : [{ id: 'SYSTEM', label: 'System audio' }]
          : []),
      ],
    }, {
      id: manifest.sessionId,
      now: new Date(manifest.createdAt),
      title: options.title ?? `Recovered live capture ${new Date(manifest.createdAt).toLocaleString()}`,
      source: { filename: 'Live capture session', duration, format: 'capture-session/0.1' },
    });
  } finally {
    for (const path of temporaryTracks) {
      if (existsSync(path)) rmSync(path, { force: true });
    }
  }
}
