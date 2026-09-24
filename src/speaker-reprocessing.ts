import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { diarizationStatus } from './diarization-environment.ts';
import { finalizeCaptureTranscript } from './capture-finalizer.ts';
import { findTranscriptRecord, saveTranscriptRecord } from './transcript-library.ts';
import { createTranscriptRecord } from './transcript-record.ts';
import { transcribeMedia } from './transcription-service.ts';
import type { TranscriptRecord } from './transcript-types.ts';

/** Produce a review copy. Never replace corrected words, names, notes or capture. */
export async function identifySavedSpeakers(library: string, id: string, options: {
  onStatus?: (message: string) => void;
  ready?: () => boolean;
  finalize?: typeof finalizeCaptureTranscript;
  transcribe?: typeof transcribeMedia;
} = {}): Promise<TranscriptRecord> {
  if (!(options.ready?.() ?? diarizationStatus().ready)) {
    throw new Error('Speaker setup is required. Press V or run seashell setup --speakers.');
  }
  const { record, path } = findTranscriptRecord(library, id);
  const capture = join(dirname(path), 'capture', 'manifest.json');
  let result: TranscriptRecord;
  if (existsSync(capture)) {
    result = await (options.finalize ?? finalizeCaptureTranscript)(capture, {
      diarizeSystemAudio: true, strictSpeakers: true, onStatus: options.onStatus,
    });
  } else if (record.source.path && existsSync(record.source.path)) {
    result = await (options.transcribe ?? transcribeMedia)(record.source.path, {
      speakers: true, audioStreamIndex: record.source.audioStreamIndex, onStatus: options.onStatus,
    });
  } else {
    throw new Error('Original audio is unavailable. Open the original recording or import it with Shift+F.');
  }
  if (!['complete', 'platform-hints'].includes(result.speakerAnalysis?.status ?? '')) {
    throw new Error('No remote voices were available to separate. Your original transcript is unchanged.');
  }
  // New evidence IDs and a new meeting identity; no stale analysis or guessed names.
  const copy = createTranscriptRecord({ transcript: result.transcript.map(({ id: _, ...s }) => s),
    speakers: result.speakers, speakerAnalysis: result.speakerAnalysis,
  }, { title: `${record.title} — speakers (review)`, source: record.source });
  saveTranscriptRecord(library, copy);
  return copy;
}
