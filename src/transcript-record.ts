import { randomUUID } from 'crypto';
import { basename, extname, resolve } from 'path';
import type {
  StructuredTranscript,
  TranscriptRecord,
  TranscriptSource,
} from './transcript-types.ts';

export interface CreateTranscriptRecordOptions {
  id?: string;
  now?: Date;
  title?: string;
  sourcePath?: string;
  source?: Partial<TranscriptSource>;
}

function defaultTitle(filename: string): string {
  const extension = extname(filename);
  return (extension ? filename.slice(0, -extension.length) : filename) || 'Untitled transcript';
}

function createId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export function createTranscriptRecord(
  document: StructuredTranscript,
  options: CreateTranscriptRecordOptions = {},
): TranscriptRecord {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const sourcePath = options.sourcePath ? resolve(options.sourcePath) : options.source?.path;
  const filename = options.source?.filename || (sourcePath ? basename(sourcePath) : 'Live session');

  return {
    schemaVersion: 1,
    id: options.id ?? createId(now),
    title: options.title?.trim() || defaultTitle(filename),
    createdAt,
    updatedAt: createdAt,
    source: {
      ...(sourcePath ? { path: sourcePath } : {}),
      filename,
      ...(options.source?.duration === undefined ? {} : { duration: options.source.duration }),
      ...(options.source?.format === undefined ? {} : { format: options.source.format }),
      ...(options.source?.audioStreamIndex === undefined
        ? {}
        : { audioStreamIndex: options.source.audioStreamIndex }),
      ...(options.source?.channels === undefined ? {} : { channels: options.source.channels }),
    },
    transcript: document.transcript.map((segment) => ({ ...segment })),
    speakers: document.speakers.map((speaker) => ({ ...speaker })),
    ...(document.summary === undefined ? {} : { summary: document.summary }),
    ...(document.decisions === undefined ? {} : { decisions: [...document.decisions] }),
    ...(document.action_items === undefined
      ? {}
      : { action_items: document.action_items.map((item) => ({ ...item })) }),
  };
}
