import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommittedCaptureChunk } from './capture-session.ts';
import { reconcileLiveEcho } from './live-echo.ts';
import { loadLocalAsrProfile } from './local-asr-profile.ts';
import { LiveAsrScheduler, OwnedWhisperServer } from './local-asr-scheduler.ts';
import type { MeetSpeaker } from './meet-speakers.ts';
import { DEFAULT_WHISPER_MODEL_FILENAME } from './model-config.ts';
import { saveTranscriptRecord } from './transcript-library.ts';
import type { TranscriptRecord, TranscriptSegment } from './transcript-types.ts';

export interface BackgroundLiveTranscriptStatus {
  readonly stage: 'waiting' | 'transcribing' | 'live' | 'delayed' | 'stopped';
  readonly detail: string;
  readonly queueDepth: number;
}
export interface BackgroundDraftTranscriber {
  transcribe(path: string, signal: AbortSignal): Promise<string>;
  /** Must terminate only resources owned by this transcriber, with a bounded wait. */
  stop(): Promise<void>;
}
export interface BackgroundLiveTranscriptOptions {
  readonly libraryDir: string;
  /** The already-published provisional record; keep its capture session ID. */
  readonly record: TranscriptRecord;
  readonly onStatus?: (status: BackgroundLiveTranscriptStatus) => void;
  readonly speakerFor?: (segment: TranscriptSegment) => MeetSpeaker | undefined;
  readonly publishIntervalMs?: number;
  readonly maxPending?: number;
  readonly maxSegments?: number;
  readonly maxTextCharacters?: number;
  readonly dependencies?: {
    readonly createTranscriber?: () => BackgroundDraftTranscriber;
    readonly saveRecord?: typeof saveTranscriptRecord;
    readonly now?: () => Date;
  };
}
export interface BackgroundLiveTranscriptHandle {
  readonly status: BackgroundLiveTranscriptStatus;
  /** Called only after a durable commit; never deletes or modifies chunk audio. */
  enqueue(chunk: CommittedCaptureChunk): void;
  /** Immediately blocks new/late draft writes, then closes owned inference. */
  close(): Promise<void>;
}

function createLocalTranscriber(): BackgroundDraftTranscriber {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const profile = loadLocalAsrProfile(join(root, 'models', DEFAULT_WHISPER_MODEL_FILENAME));
  return new OwnedWhisperServer(join(root, 'whisper.cpp', 'build', 'bin', 'whisper-server'), {
    ...profile, requestTimeoutMs: 120_000, idleTimeoutMs: 60_000,
    disableGpu: process.env.SEASHELL_DISABLE_GPU === '1',
  });
}
function positiveBound(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be from 1 to ${maximum}`);
  return value;
}

/**
 * Optional local drafts over committed chunks. Canonical finalization still
 * reprocesses durable audio; queue pressure may skip drafts, never capture data.
 */
export function startBackgroundLiveTranscript(options: BackgroundLiveTranscriptOptions): BackgroundLiveTranscriptHandle {
  const interval = positiveBound(options.publishIntervalMs ?? 1000, 'Draft publish interval', 60_000);
  const maxPending = positiveBound(options.maxPending ?? 4, 'Draft pending limit', 32);
  const maxSegments = positiveBound(options.maxSegments ?? 10_000, 'Draft segment limit', 20_000);
  const maxCharacters = positiveBound(options.maxTextCharacters ?? 2_000_000, 'Draft text limit', 4_000_000);
  const now = options.dependencies?.now ?? (() => new Date());
  const save = options.dependencies?.saveRecord ?? saveTranscriptRecord;
  let record = structuredClone(options.record);
  let characters = record.transcript.reduce((total, segment) => total + segment.text.length, 0);
  let closed = false, limited = record.transcript.length >= maxSegments || characters >= maxCharacters;
  let dirty = false, saveFailed = false, delay: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let transcriber: BackgroundDraftTranscriber | undefined;
  let transcriberStop: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let statusPublished = false;
  let lastStatus: BackgroundLiveTranscriptStatus = Object.freeze({
    stage: 'waiting', detail: 'Waiting for speech. Audio is saved as it arrives.', queueDepth: 0,
  });
  const latestSequence = { microphone: 0, 'system-audio': 0 };
  const scheduler = new LiveAsrScheduler({
    maxPending,
    transcribe: (path, signal) => {
      if (closed || limited || signal.aborted) return Promise.resolve('');
      transcriber ??= (options.dependencies?.createTranscriber ?? createLocalTranscriber)();
      return transcriber.transcribe(path, signal);
    },
    onDepth: () => report(),
  });

  function report() {
    const queueDepth = closed ? 0 : scheduler.depth;
    const stage = closed ? 'stopped' : delay ? 'delayed' : queueDepth > 0 ? 'transcribing'
      : record.transcript.length ? 'live' : 'waiting';
    const detail = closed ? 'Live draft stopped. Preparing the final transcript.'
      : delay ?? (stage === 'transcribing' ? 'Preparing live text. Audio is already saved.'
        : stage === 'live' ? 'Live transcript updating; the final pass refines timing and speakers.'
          : 'Waiting for speech. Audio is saved as it arrives.');
    if (statusPublished && lastStatus.stage === stage && lastStatus.queueDepth === queueDepth && lastStatus.detail === detail) return;
    lastStatus = Object.freeze({ stage, detail, queueDepth });
    statusPublished = true;
    // A display failure must not reject a committed audio chunk or inference job.
    try { options.onStatus?.(lastStatus); } catch { /* The recorder owns its display errors. */ }
  }
  function delayed(message: string) {
    if (closed) return;
    delay = message; report();
  }
  function schedulePublish(wait = interval) {
    if (closed || timer || !dirty) return;
    timer = setTimeout(() => { timer = undefined; publish(); }, wait);
    timer.unref();
  }
  function publish(finalDraft = false) {
    if ((!finalDraft && closed) || !dirty) return;
    try {
      const saved = save(options.libraryDir, record, { provisional: true });
      dirty = false;
      if (saveFailed) {
        saveFailed = false;
        if (!limited) delay = undefined;
        report();
      }
      if (saved.meetingWarning) delayed(`Live text is saved; meeting notes need repair. ${saved.meetingWarning}`);
    } catch {
      saveFailed = true;
      delayed('Live text could not be saved yet. Recorded audio remains available for the final transcript.');
      schedulePublish(Math.max(5000, interval));
    }
  }
  function stopTranscriber(): Promise<void> {
    if (transcriberStop) return transcriberStop;
    transcriberStop = transcriber ? Promise.resolve().then(() => transcriber!.stop()) : Promise.resolve();
    return transcriberStop;
  }
  function limitDraft() {
    limited = true;
    delayed('Live draft reached its size limit. Audio recording continues; the final transcript includes the rest.');
    scheduler.cancelGeneration(1);
    void stopTranscriber().catch(() => delayed('Live draft stopped; its local engine needs cleanup. Audio recording continues.'));
  }
  function append(chunk: CommittedCaptureChunk, text: string) {
    if (closed || limited) return;
    const cleaned = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(cleaned)) return;
    // Bound a malformed provider response before retaining it in the record.
    if (cleaned.length > 16_000) {
      delayed('A live draft was too large to display. Audio is saved for the final transcript.');
      return;
    }
    let segment: TranscriptSegment = {
      id: `draft-${chunk.id}`, start: chunk.startMs / 1000, end: chunk.endMs / 1000,
      text: cleaned, speaker: chunk.trackId === 'microphone' ? 'LOCAL' : 'SYSTEM',
    };
    const hint = segment.speaker === 'SYSTEM' ? options.speakerFor?.(segment) : undefined;
    if (hint) segment = { ...segment, speaker: hint.id, speakerSource: hint.source ?? 'google-meet-accessibility' };
    const transcript = reconcileLiveEcho(record.transcript, segment);
    if (transcript === record.transcript) return;
    const nextCharacters = transcript.reduce((total, unit) => total + unit.text.length, 0);
    if (transcript.length > maxSegments || nextCharacters > maxCharacters) { limitDraft(); return; }
    const speaker = segment.speaker!;
    const speakers = record.speakers.some(entry => entry.id === speaker) ? record.speakers : [
      ...record.speakers, { id: speaker, label: hint?.label ?? (speaker === 'LOCAL' ? 'Microphone' : 'System audio') },
    ];
    record = {
      ...record, transcript: [...transcript], speakers,
      updatedAt: now().toISOString(),
      source: { ...record.source, duration: Math.max(record.source.duration ?? 0, segment.end) },
      ...(hint ? { speakerAnalysis: { status: 'platform-hints',
        detail: 'Live names follow meeting speaking indicators; final transcription reviews timing and overlap.' } as const } : {}),
    };
    characters = nextCharacters;
    if (!saveFailed) delay = undefined;
    dirty = true;
    report(); schedulePublish();
  }

  if (limited) delay = 'Live draft reached its size limit. Audio recording continues; the final transcript includes the rest.';
  report();
  return {
    get status() { return lastStatus; },
    enqueue(chunk) {
      if (closed || limited || !chunk.audible) return;
      if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence <= latestSequence[chunk.trackId] ||
          !Number.isFinite(chunk.startMs) || !Number.isFinite(chunk.endMs) ||
          chunk.startMs < 0 || chunk.endMs <= chunk.startMs || chunk.bytes < 44) return;
      latestSequence[chunk.trackId] = chunk.sequence;
      if (chunk.bytes > 32 * 1024 * 1024) {
        delayed('A saved chunk is too large for live preview. It remains available for final transcription.');
        return;
      }
      void scheduler.enqueue({
        id: chunk.id, audioFile: chunk.path, start: chunk.startMs / 1000, end: chunk.endMs / 1000,
        speaker: chunk.trackId === 'microphone' ? 'LOCAL' : 'SYSTEM', sessionGeneration: 1,
      }).then(result => {
        if (closed || limited) return;
        if (result.status === 'completed') append(chunk, result.text);
        else if (result.status === 'superseded') delayed('Live text is catching up. Audio is saved; the final pass fills draft gaps.');
      }).catch(() => delayed('Live transcription is delayed. Audio is saved; the final pass will retry locally.'));
    },
    close() {
      if (closing) return closing;
      // Set the write barrier before the first await, including during startup.
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      publish(true);
      report();
      closing = Promise.allSettled([scheduler.stop(), stopTranscriber()]).then(async results => {
        // An aborted request may run its idle-timer finally block while the
        // first stop is closing the server. Clear that timer after the lane ends.
        await transcriber?.stop();
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      });
      return closing;
    },
  };
}
