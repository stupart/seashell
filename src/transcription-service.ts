import { diarizePreparedMedia, type DiarizeFileOptions } from './diarize.ts';
import { prepareMedia } from './media-preparation.ts';
import { createTranscriptRecord } from './transcript-record.ts';
import type {
  StructuredTranscript,
  TranscriptRecord,
} from './transcript-types.ts';
import { transcribeWithTimestamps } from './whisper-timestamps.ts';

export interface TranscribeMediaOptions extends DiarizeFileOptions {
  speakers?: boolean;
  title?: string;
  onStatus?: (message: string) => void;
}

/**
 * Universal file pipeline. Timed Whisper output is canonical; diarization
 * enriches those same units rather than launching a second ASR pass.
 */
export async function transcribeMedia(
  filePath: string,
  options: TranscribeMediaOptions = {},
): Promise<TranscriptRecord> {
  const preserveChannels = options.speakers === true || Boolean(options.channelRoles);
  const media = await prepareMedia(filePath, {
    preserveChannels,
    audioStreamIndex: options.audioStreamIndex,
    onStatus: options.onStatus ?? options.onMediaStatus,
  });

  try {
    options.onStatus?.(options.speakers ? 'Identifying speakers…' : 'Transcribing…');
    let document: StructuredTranscript;

    if (options.speakers) {
      document = await diarizePreparedMedia(media, options);
    } else {
      const units = await transcribeWithTimestamps(media.path, {
        onProgress: options.onWhisperProgress,
        onFallback: options.onWhisperFallback,
      });
      document = {
        transcript: units.map((unit) => ({
          start: unit.start,
          end: unit.end,
          text: unit.text,
        })),
        speakers: [],
      };
    }

    return createTranscriptRecord(document, {
      title: options.title,
      sourcePath: filePath,
      source: {
        filename: filePath.split('/').at(-1) || filePath,
        ...(media.probe.duration === undefined ? {} : { duration: media.probe.duration }),
        ...(media.probe.formatName === undefined ? {} : { format: media.probe.formatName }),
        audioStreamIndex: media.selectedAudioStream.index,
        ...(media.selectedAudioStream.channels === undefined
          ? {}
          : { channels: media.selectedAudioStream.channels }),
      },
    });
  } finally {
    media.cleanup();
  }
}
