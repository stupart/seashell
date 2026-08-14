import { diarizePreparedMedia, type DiarizeFileOptions } from './diarize.ts';
import { prepareMedia } from './media-preparation.ts';
import { createTranscriptRecord } from './transcript-record.ts';
import type {
  StructuredTranscript,
  TranscriptRecord,
} from './transcript-types.ts';
import { transcribeWithTimestamps } from './whisper-timestamps.ts';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { runHumainTranscription } from './humain-client.ts';
import {
  DEFAULT_TRANSCRIPTION_ROUTING,
  selectDraftTranscriptionRoute,
  type TranscriptionRoutingConfig,
} from './transcription-routing.ts';

export interface TranscribeMediaOptions extends DiarizeFileOptions {
  speakers?: boolean;
  title?: string;
  onStatus?: (message: string) => void;
  routing?: TranscriptionRoutingConfig;
  humainStoreDir?: string;
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

    const routing = options.routing ?? DEFAULT_TRANSCRIPTION_ROUTING;
    const route = selectDraftTranscriptionRoute(routing, 0);
    if (options.speakers && route === 'cloud') {
      throw new Error('Cloud transcription does not provide speaker diarization; choose local mode.');
    }
    if (options.speakers) {
      document = await diarizePreparedMedia(media, options);
    } else if (route === 'cloud') {
      const cloud = routing.cloud;
      if (!cloud?.uploadConsent) throw new Error('Cloud transcription requires upload consent');
      options.onStatus?.(`Uploading to ${cloud.model} through Humain…`);
      const result = await runHumainTranscription(media.path, {
        model: cloud.model,
        ...(cloud.upstreamProvider === undefined ? {} : { upstreamProvider: cloud.upstreamProvider }),
        ...(cloud.maxCostMicrousd === undefined ? {} : { maxCostMicrousd: cloud.maxCostMicrousd }),
        uploadConsent: true,
      }, {
        storeDir: options.humainStoreDir ?? join(
          homedir(), 'Library', 'Application Support', 'Sea Shell', 'Humain',
        ),
        runId: `file-${randomUUID()}`,
      });
      document = {
        transcript: result.output.segments.map((segment) => ({
          start: segment.startMs / 1_000,
          end: segment.endMs / 1_000,
          text: segment.text,
        })),
        speakers: [],
      };
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
