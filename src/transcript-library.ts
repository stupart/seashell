import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, extname, join } from 'path';
import { renderText, renderTranscript } from './transcript-renderer.ts';
import type { TranscriptFormat, TranscriptRecord } from './transcript-types.ts';

export interface TranscriptLibraryEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  duration?: number;
  sourceFilename: string;
  speakerCount: number;
  segmentCount: number;
  directory: string;
}

export interface SavedTranscript {
  directory: string;
  jsonPath: string;
  textPath: string;
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase()
    .slice(0, 60) || 'transcript';
}

function localDateKey(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid transcript date: ${isoTimestamp}`);
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function transcriptJsonPaths(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const paths: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '_Trash') visit(path);
      } else if (entry.isFile() && entry.name === 'transcript.json') {
        paths.push(path);
      }
    }
  };
  visit(directory);
  return paths;
}

export function parseTranscriptRecord(value: unknown, path = 'transcript.json'): TranscriptRecord {
  if (!value || typeof value !== 'object') {
    throw new Error(`${path} does not contain a transcript object`);
  }
  const record = value as Partial<TranscriptRecord>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.id !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    !record.source ||
    typeof record.source.filename !== 'string' ||
    !Array.isArray(record.transcript) ||
    !Array.isArray(record.speakers)
  ) {
    throw new Error(`${path} is not a supported Sea Shell transcript record`);
  }
  const validSegments = record.transcript.every((segment) => (
    Boolean(segment) &&
    typeof segment === 'object' &&
    typeof segment.start === 'number' &&
    Number.isFinite(segment.start) &&
    typeof segment.end === 'number' &&
    Number.isFinite(segment.end) &&
    segment.start >= 0 &&
    segment.end >= segment.start &&
    typeof segment.text === 'string' &&
    (segment.speaker === undefined || typeof segment.speaker === 'string')
  ));
  const validSpeakers = record.speakers.every((speaker) => (
    Boolean(speaker) &&
    typeof speaker === 'object' &&
    typeof speaker.id === 'string' &&
    speaker.id.length > 0 &&
    typeof speaker.label === 'string' &&
    speaker.label.length > 0
  ));
  if (!validSegments || !validSpeakers) {
    throw new Error(`${path} contains invalid transcript segments or speakers`);
  }
  return record as TranscriptRecord;
}

export function loadTranscriptPath(path: string): TranscriptRecord {
  try {
    return parseTranscriptRecord(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${path} contains malformed JSON`);
    throw error;
  }
}

function existingRecordPath(libraryDir: string, id: string): string | undefined {
  return transcriptJsonPaths(libraryDir).find((path) => {
    try {
      return loadTranscriptPath(path).id === id;
    } catch {
      return false;
    }
  });
}

export function saveTranscriptRecord(
  libraryDir: string,
  record: TranscriptRecord,
): SavedTranscript {
  const existingPath = existingRecordPath(libraryDir, record.id);
  const date = localDateKey(record.createdAt);
  const directory = existingPath
    ? dirname(existingPath)
    : join(libraryDir, date, `${slugify(record.title)}--${record.id}`);
  const jsonPath = join(directory, 'transcript.json');
  const textPath = join(directory, 'transcript.txt');

  atomicWrite(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  atomicWrite(textPath, `${renderText(record, {
    timestamps: true,
    speakers: record.speakers.length > 0,
  })}\n`);
  return { directory, jsonPath, textPath };
}

function toEntry(path: string, record: TranscriptRecord): TranscriptLibraryEntry {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.source.duration === undefined ? {} : { duration: record.source.duration }),
    sourceFilename: record.source.filename,
    speakerCount: record.speakers.length,
    segmentCount: record.transcript.length,
    directory: dirname(path),
  };
}

/** The filesystem is authoritative; this derived listing can always be rebuilt. */
export function listTranscriptRecords(libraryDir: string): TranscriptLibraryEntry[] {
  return transcriptJsonPaths(libraryDir)
    .flatMap((path) => {
      try {
        return [toEntry(path, loadTranscriptPath(path))];
      } catch {
        return [];
      }
    })
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findTranscriptRecord(
  libraryDir: string,
  id: string,
): { path: string; record: TranscriptRecord } {
  for (const path of transcriptJsonPaths(libraryDir)) {
    const record = loadTranscriptPath(path);
    if (record.id === id) return { path, record };
  }
  throw new Error(`Transcript not found: ${id}`);
}

export function searchTranscriptRecords(
  libraryDir: string,
  query: string,
): TranscriptLibraryEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return listTranscriptRecords(libraryDir);
  return transcriptJsonPaths(libraryDir)
    .flatMap((path) => {
      try {
        const record = loadTranscriptPath(path);
        const haystack = [
          record.title,
          record.source.filename,
          ...record.speakers.map((speaker) => speaker.label),
          renderText(record),
        ].join('\n').toLocaleLowerCase();
        return haystack.includes(normalized) ? [toEntry(path, record)] : [];
      } catch {
        return [];
      }
    })
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function renameTranscriptSpeaker(
  libraryDir: string,
  transcriptId: string,
  speakerId: string,
  label: string,
): TranscriptRecord {
  const trimmed = label.trim();
  if (!trimmed) throw new Error('Speaker name cannot be empty');
  const { record } = findTranscriptRecord(libraryDir, transcriptId);
  const speaker = record.speakers.find((candidate) => candidate.id === speakerId);
  if (!speaker) throw new Error(`Speaker ${speakerId} was not found in transcript ${transcriptId}`);
  speaker.label = trimmed;
  record.updatedAt = new Date().toISOString();
  saveTranscriptRecord(libraryDir, record);
  return record;
}

export function writeTranscriptExport(
  libraryDir: string,
  transcriptId: string,
  format: TranscriptFormat,
  outputPath?: string,
): string {
  const { path, record } = findTranscriptRecord(libraryDir, transcriptId);
  const extension = format === 'text' ? 'txt' : format;
  const pathToWrite = outputPath || join(dirname(path), `transcript.${extension}`);
  const rendered = renderTranscript(record, format, {
    timestamps: format === 'text',
    speakers: record.speakers.length > 0,
  });
  atomicWrite(pathToWrite, `${rendered}${rendered.endsWith('\n') ? '' : '\n'}`);
  return pathToWrite;
}

export function trashTranscriptRecord(libraryDir: string, transcriptId: string): string {
  const { path } = findTranscriptRecord(libraryDir, transcriptId);
  const sourceDirectory = dirname(path);
  const trashDirectory = join(libraryDir, '_Trash');
  mkdirSync(trashDirectory, { recursive: true });
  const target = join(
    trashDirectory,
    `${basename(sourceDirectory)}--${Date.now()}`,
  );
  renameSync(sourceDirectory, target);

  // Remove an empty date directory, but never recurse beyond that exact parent.
  const dateDirectory = dirname(sourceDirectory);
  if (dateDirectory !== libraryDir && readdirSync(dateDirectory).length === 0) {
    rmdirSync(dateDirectory);
  }
  return target;
}

export function transcriptDirectorySize(directory: string): number {
  return readdirSync(directory)
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile())
    .reduce((total, path) => total + statSync(path).size, 0);
}

export function formatForPath(path: string): TranscriptFormat | undefined {
  const extension = extname(path).slice(1).toLowerCase();
  return extension === 'txt' ? 'text' :
    extension === 'json' || extension === 'srt' || extension === 'vtt'
      ? extension
      : undefined;
}
