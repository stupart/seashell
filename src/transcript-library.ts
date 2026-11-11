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
import { archiveMeetingTranscript, synchronizeMeetingTranscript } from './meeting-artifact.ts';
import { readBackgroundMeetingState, readBackgroundMeetingStatus, type BackgroundMeetingState, type BackgroundDraftStatus } from './background-meeting-status.ts';
import { readCaptureHealth, type CaptureHealthSnapshot } from './capture-health.ts';
import { rememberVoice } from './voiceprints.ts';

export interface TranscriptLibraryEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  duration?: number;
  sourceFilename: string;
  speakerCount: number;
  segmentCount: number;
  kind: 'transcript' | 'meeting';
  directory: string;
  captureState?: BackgroundMeetingState;
  captureHealth?: CaptureHealthSnapshot;
  audioSavedThroughMs?: number;
  draftStatus?: BackgroundDraftStatus;
  /** From a search: the first line that says what was searched for, and when. */
  match?: { start: number; text: string };
}

export interface SavedTranscript {
  directory: string;
  jsonPath: string;
  textPath: string;
  meetingWarning?: string;
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase()
    .slice(0, 60) || 'transcript';
}

function assertTranscriptId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('Transcript ID is unsafe');
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
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
    const entries = readdirSync(current, { withFileTypes: true });
    const canonical = entries.find((entry) => entry.isFile() && entry.name === 'transcript.json');
    if (canonical) {
      paths.push(join(current, canonical.name));
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '_Trash') visit(path);
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
    (segment.id === undefined || (typeof segment.id === 'string' && segment.id.length > 0)) &&
    (segment.speaker === undefined || typeof segment.speaker === 'string') &&
    (segment.speakerSource === undefined || segment.speakerSource === 'google-meet-dom' || segment.speakerSource === 'google-meet-accessibility')
  ));
  const validSpeakers = record.speakers.every((speaker) => (
    Boolean(speaker) &&
    typeof speaker === 'object' &&
    typeof speaker.id === 'string' &&
    speaker.id.length > 0 &&
    typeof speaker.label === 'string' &&
    speaker.label.length > 0
  ));
  if (record.speakerAnalysis !== undefined && (
    !record.speakerAnalysis || typeof record.speakerAnalysis !== 'object' ||
    !['complete', 'unavailable', 'failed', 'source-only', 'platform-hints'].includes(record.speakerAnalysis.status) ||
    typeof record.speakerAnalysis.detail !== 'string' ||
    (record.speakerAnalysis.model !== undefined && typeof record.speakerAnalysis.model !== 'string')
  )) throw new Error(`${path} contains invalid speaker analysis`);
  if (!validSegments || !validSpeakers) {
    throw new Error(`${path} contains invalid transcript segments or speakers`);
  }
  assertTranscriptId(record.id);
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

/** Where a transcript with this ID is saved, from the listing cache rather than parsing every transcript. */
function existingRecordPath(libraryDir: string, id: string): string | undefined {
  return cachedTranscripts(libraryDir).find(({ cached }) => cached.summary?.id === id)?.path;
}

export function saveTranscriptRecord(
  libraryDir: string,
  record: TranscriptRecord,
  options: { provisional?: boolean; namesOnly?: { from: string; to: string }; keepNotes?: string } = {},
): SavedTranscript {
  assertTranscriptId(record.id);
  const existingPath = existingRecordPath(libraryDir, record.id);
  const date = localDateKey(record.createdAt);
  const directory = existingPath
    ? dirname(existingPath)
    : join(libraryDir, date, `${slugify(record.title)}--${record.id}`);
  const jsonPath = join(directory, 'transcript.json');
  const textPath = join(directory, 'transcript.txt');

  let meetingWarning: string | undefined;
  try {
    if (existingPath && !options.provisional && !options.namesOnly) archiveMeetingTranscript(directory, loadTranscriptPath(existingPath), record);
  } catch (error) {
    meetingWarning = `Transcript saved; meeting history needs repair: ${error instanceof Error ? error.message : String(error)}`;
  }
  atomicWrite(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  atomicWrite(textPath, `${renderText(record, {
    timestamps: true,
    speakers: record.speakers.length > 0,
  })}\n`);
  try { if (!options.provisional) synchronizeMeetingTranscript(directory, record, { namesOnly: options.namesOnly, keepNotes: options.keepNotes }); } catch (error) {
    meetingWarning = `Transcript saved; meeting notes need repair: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { directory, jsonPath, textPath, ...(meetingWarning ? { meetingWarning } : {}) };
}

type TranscriptSummary = Pick<TranscriptLibraryEntry,
  'id' | 'title' | 'createdAt' | 'updatedAt' | 'duration' | 'sourceFilename' | 'speakerCount' | 'segmentCount'>;

interface CachedTranscript {
  /** Inode, size and modification time: an atomic save always changes it. */
  readonly stamp: string;
  /** Undefined when the file is not a readable transcript. */
  readonly summary?: TranscriptSummary;
  /** Lowercase title, source, speaker names and text, built on the first search. */
  searchText?: string;
  /** Each line and when it was said, so a search can show where it matched. */
  searchLines?: ReadonlyArray<{ start: number; text: string }>;
}

/**
 * The TUI lists the library every second while the background recorder runs.
 * Parse each transcript.json once per change instead of on every listing.
 */
const transcriptCache = new Map<string, Map<string, CachedTranscript>>();

function summarize(record: TranscriptRecord): TranscriptSummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.source.duration === undefined ? {} : { duration: record.source.duration }),
    sourceFilename: record.source.filename,
    speakerCount: record.speakers.length,
    segmentCount: record.transcript.length,
  };
}

function searchText(record: TranscriptRecord): string {
  return [
    record.title,
    record.source.filename,
    ...record.speakers.map((speaker) => speaker.label),
    renderText(record),
  ].join('\n').toLocaleLowerCase();
}

/** Every transcript in the library, reparsing only files that changed since the last call. */
function cachedTranscripts(libraryDir: string, options: { search?: boolean } = {}): Array<{ path: string; cached: CachedTranscript }> {
  const previous = transcriptCache.get(libraryDir);
  const current = new Map<string, CachedTranscript>();
  const results: Array<{ path: string; cached: CachedTranscript }> = [];
  for (const path of transcriptJsonPaths(libraryDir)) {
    let stamp: string;
    try {
      const stats = statSync(path, { bigint: true });
      stamp = `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
    } catch {
      continue;
    }
    let cached = previous?.get(path);
    if (cached?.stamp !== stamp || (options.search && cached.summary && cached.searchText === undefined)) {
      try {
        const record = loadTranscriptPath(path);
        cached = { stamp, summary: summarize(record), ...(options.search ? { searchText: searchText(record),
          searchLines: record.transcript.map((segment) => ({ start: segment.start, text: segment.text.replace(/\s+/gu, ' ').trim() })) } : {}) };
      } catch {
        cached = { stamp };
      }
    }
    current.set(path, cached);
    results.push({ path, cached });
  }
  transcriptCache.set(libraryDir, current);
  return results;
}

function toEntry(path: string, summary: TranscriptSummary): TranscriptLibraryEntry {
  const directory = dirname(path);
  const background = readBackgroundMeetingStatus(directory);
  return {
    ...summary,
    kind: existsSync(join(directory, 'meeting.json')) ? 'meeting' : 'transcript',
    directory,
    captureState: background?.state,
    captureHealth: background?.captureHealth ?? readCaptureHealth(join(directory, 'capture')),
    audioSavedThroughMs: background?.audioSavedThroughMs,
    draftStatus: background?.draftStatus,
  };
}

/** The filesystem is authoritative; this derived listing can always be rebuilt. */
export function listTranscriptRecords(libraryDir: string): TranscriptLibraryEntry[] {
  return cachedTranscripts(libraryDir)
    .flatMap(({ path, cached }) => cached.summary ? [toEntry(path, cached.summary)] : [])
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * One transcript by ID, read fresh from disk. The listing cache knows which
 * file holds which ID, so only that file is parsed, not every transcript in
 * the library: a loop over meetings that looks each one up stays linear.
 */
export function findTranscriptRecord(
  libraryDir: string,
  id: string,
): { path: string; record: TranscriptRecord } {
  for (const { path, cached } of cachedTranscripts(libraryDir)) {
    if (cached.summary?.id !== id) continue;
    try {
      const record = loadTranscriptPath(path);
      if (record.id === id) return { path, record };
    } catch {
      // Match listing/search behavior: unrelated damaged records stay on disk.
    }
  }
  throw new Error(`Transcript not found: ${id}`);
}

export function searchTranscriptRecords(
  libraryDir: string,
  query: string,
): TranscriptLibraryEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return listTranscriptRecords(libraryDir);
  return cachedTranscripts(libraryDir, { search: true })
    .flatMap(({ path, cached }) => {
      if (!cached.summary || !cached.searchText?.includes(normalized)) return [];
      const match = cached.searchLines?.find((line) => line.text.toLocaleLowerCase().includes(normalized));
      return [{ ...toEntry(path, cached.summary), ...(match ? { match } : {}) }];
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
  const { path, record } = findTranscriptRecord(libraryDir, transcriptId);
  const captureState = readBackgroundMeetingState(dirname(path));
  if (captureState === 'recording' || captureState === 'processing') {
    throw new Error('This meeting is still recording or processing. Wait for it to finish before renaming a speaker.');
  }
  const speaker = record.speakers.find((candidate) => candidate.id === speakerId);
  if (!speaker) throw new Error(`Speaker ${speakerId} was not found in transcript ${transcriptId}`);
  const previous = speaker.label;
  speaker.label = trimmed;
  // A name Tyler gives, even the suggested one, is no longer a suggestion.
  delete speaker.suggestion;
  record.updatedAt = new Date().toISOString();
  saveTranscriptRecord(libraryDir, record, { namesOnly: { from: previous, to: trimmed } });
  // The name teaches the local voice library this voice (src/voiceprints.ts).
  rememberVoice(record, speakerId, trimmed);
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
  const captureState = readBackgroundMeetingState(sourceDirectory);
  if (captureState === 'recording' || captureState === 'processing') {
    throw new Error('This meeting is still recording or processing. Wait for it to finish before removing it.');
  }
  const trashDirectory = join(libraryDir, '_Trash');
  mkdirSync(trashDirectory, { recursive: true, mode: 0o700 });
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
