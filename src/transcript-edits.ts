import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { readBackgroundMeetingState } from './background-meeting-status.ts';
import { assembleCaptureTrack } from './capture-finalizer.ts';
import { loadCaptureSession, type CaptureSessionManifest, type CaptureTrackId } from './capture-session.ts';
import { transcriptSegmentId } from './meeting-artifact.ts';
import { meetingEvidence } from './meeting-evidence.ts';
import { detectSpeechRegions, isPhantomUnit, readMonoPcm, type SpeechRegion } from './speech-gate.ts';
import {
  findTranscriptRecord,
  listTranscriptRecords,
  loadTranscriptPath,
  renameTranscriptSpeaker,
  saveTranscriptRecord,
} from './transcript-library.ts';
import type { TranscriptRecord } from './transcript-types.ts';

/**
 * Changes to a saved transcript that keep its notes: a corrected line, a
 * speaker's name, lines Whisper heard in silence. The old transcript is kept
 * in the meeting's history folder first, segment IDs never move, and the
 * notes stay, marked as possibly out of date until notes run again.
 */

function assertNotCapturing(directory: string): void {
  const state = readBackgroundMeetingState(directory);
  if (state === 'recording' || state === 'processing') {
    throw new Error('This meeting is still recording or processing. Wait for it to finish before changing its transcript.');
  }
}

/** Copies kept per meeting; older ones are removed as new ones are kept. */
export const TRANSCRIPT_HISTORY_LIMIT = 20;

function historyFolder(directory: string): string {
  return join(directory, 'history', 'transcripts');
}

/** The kept copies, oldest first: each name starts with the time it was kept. */
function historyFiles(folder: string): string[] {
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort() : [];
}

/**
 * history/transcripts/<time>-<why>.json: the transcript exactly as it was
 * before a change. The 20 most recent copies stay.
 */
export function keepTranscriptHistory(directory: string, record: TranscriptRecord, why: string): string {
  const folder = historyFolder(directory);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${new Date().toISOString().replace(/[:.]/gu, '-')}-${why}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const files = historyFiles(folder);
  for (const old of files.slice(0, Math.max(0, files.length - TRANSCRIPT_HISTORY_LIMIT))) rmSync(join(folder, old), { force: true });
  return path;
}

export interface TranscriptHistoryCopy {
  file: string;
  /** When it was kept: just before the change named in `why`. */
  savedAt: string;
  why: string;
  segments: number;
}

/** The copies kept of a meeting's transcript, newest first. */
export function listTranscriptHistory(libraryDir: string, transcriptId: string): TranscriptHistoryCopy[] {
  const folder = historyFolder(dirname(findTranscriptRecord(libraryDir, transcriptId).path));
  return historyFiles(folder).reverse().flatMap((file) => {
    let segments: number;
    try { segments = loadTranscriptPath(join(folder, file)).transcript.length; } catch { return []; }
    const named = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)-[0-9a-f]{8}\.json$/u.exec(file);
    return [{ file, segments,
      savedAt: named ? `${named[1]}:${named[2]}:${named[3]}.${named[4]}Z` : statSync(join(folder, file)).mtime.toISOString(),
      why: named?.[5] ?? 'unknown' }];
  });
}

export const RESTORED_TRANSCRIPT = 'An earlier transcript was restored';

/**
 * Put back a copy from the meeting's history: its lines and speakers. The
 * transcript as it is now is kept in history first, so a restore can be
 * undone the same way. The notes stay, marked as possibly out of date, and
 * cite again any line the copy brings back.
 */
export function restoreTranscript(
  libraryDir: string, transcriptId: string, file: string,
): { id: string; file: string; segments: number; restored: boolean } {
  const { path, record } = findTranscriptRecord(libraryDir, transcriptId);
  const directory = dirname(path);
  assertNotCapturing(directory);
  const folder = historyFolder(directory);
  const wanted = file.endsWith('.json') ? file : `${file}.json`;
  // Only a file the folder lists: never a path that leads out of it.
  if (!historyFiles(folder).includes(wanted)) {
    throw new Error(`No copy "${file}" in this meeting's history. See: seashell meeting restore ${record.id} --list`);
  }
  const copy = loadTranscriptPath(join(folder, wanted));
  if (copy.id !== record.id) throw new Error(`${wanted} is a copy of another meeting's transcript.`);
  const { speakerAnalysis: _current, ...kept } = record;
  const restored: TranscriptRecord = { ...kept, transcript: copy.transcript, speakers: copy.speakers,
    ...(copy.speakerAnalysis ? { speakerAnalysis: copy.speakerAnalysis } : {}), updatedAt: new Date().toISOString() };
  if (meetingEvidence(restored).revision === meetingEvidence(record).revision &&
      JSON.stringify(restored.speakers) === JSON.stringify(record.speakers)) {
    return { id: record.id, file: wanted, segments: record.transcript.length, restored: false };
  }
  keepTranscriptHistory(directory, JSON.parse(readFileSync(path, 'utf8')) as TranscriptRecord, 'before-restore');
  saveTranscriptRecord(libraryDir, restored, { keepNotes: RESTORED_TRANSCRIPT });
  return { id: record.id, file: wanted, segments: restored.transcript.length, restored: true };
}

/**
 * Positional IDs ("s000007") would shift when a line is removed and point old
 * citations at the wrong moment, so each line keeps the ID it has now. The
 * evidence hash already uses that same ID, so nothing else changes.
 */
function pinSegmentIds(record: TranscriptRecord): void {
  record.transcript.forEach((segment, index) => { segment.id = transcriptSegmentId(record, index); });
}

export const CORRECTED_LINE = 'A transcript line was corrected';
export const REMOVED_SILENT_LINES = 'Lines heard in silence were removed';

export function editTranscriptSegment(
  libraryDir: string, transcriptId: string, segmentId: string, text: string,
): { id: string; segmentId: string; before: string; after: string } {
  const after = text.replace(/\s+/gu, ' ').trim();
  if (!after) throw new Error('The corrected text is empty.');
  const { path, record } = findTranscriptRecord(libraryDir, transcriptId);
  assertNotCapturing(dirname(path));
  const index = record.transcript.findIndex((_segment, position) => transcriptSegmentId(record, position) === segmentId);
  if (index < 0) throw new Error(`Segment ${segmentId} is not in this meeting`);
  const before = record.transcript[index]!.text;
  if (before === after) return { id: record.id, segmentId, before, after };
  keepTranscriptHistory(dirname(path), JSON.parse(readFileSync(path, 'utf8')) as TranscriptRecord, 'corrected-line');
  pinSegmentIds(record);
  record.transcript[index]!.text = after;
  record.updatedAt = new Date().toISOString();
  saveTranscriptRecord(libraryDir, record, { keepNotes: CORRECTED_LINE });
  return { id: record.id, segmentId, before, after };
}

/** Name a speaker by ID or by the label they have now ("Remote speaker 1"). */
export function renameMeetingSpeaker(
  libraryDir: string, transcriptId: string, speaker: string, name: string,
): { id: string; speakerId: string; from: string; to: string } {
  const { record } = findTranscriptRecord(libraryDir, transcriptId);
  const wanted = speaker.trim().toLocaleLowerCase('en-US');
  const found = record.speakers.find((candidate) => candidate.id === speaker.trim())
    ?? record.speakers.find((candidate) => candidate.label.toLocaleLowerCase('en-US') === wanted);
  if (!found) {
    throw new Error(`No speaker "${speaker}" in this meeting. Speakers: ${record.speakers.map((candidate) => `${candidate.label} (${candidate.id})`).join(', ') || 'none'}`);
  }
  const from = found.label;
  renameTranscriptSpeaker(libraryDir, record.id, found.id, name);
  return { id: record.id, speakerId: found.id, from, to: name.trim() };
}

export interface PhantomCleanup {
  id: string;
  title: string;
  segments: number;
  /** Lines with no speech under them and no sound above a whisper. */
  phantoms: number;
  removed: boolean;
  /** Lines with no recorded audio under them, in a gap or past the end: not known to be silent, so kept. */
  unrecorded?: number;
  skipped?: string;
}

export interface CleanPhantomsOptions {
  dryRun?: boolean;
  /** Only these meetings; every meeting with saved audio when unset. */
  ids?: string[];
  onStatus?: (message: string) => void;
  /** Seams for tests: speech detection and track assembly. */
  detect?: (wavPath: string) => Promise<SpeechRegion[] | undefined>;
  assemble?: typeof assembleCaptureTrack;
}

/** Chunks this close together are one stretch of audio: their times are rounded to the millisecond. */
const CHUNK_JOIN_SECONDS = 0.1;

/**
 * When a track has audio, in seconds: its chunks, less any gap the capture
 * reported inside them. The assembled track is digital silence everywhere
 * else, which says nothing about what was said there.
 */
function recordedSpans(manifest: CaptureSessionManifest, trackId: CaptureTrackId): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const chunk of manifest.chunks.filter((candidate) => candidate.trackId === trackId).toSorted((a, b) => a.startMs - b.startMs)) {
    const [start, end] = [chunk.startMs / 1_000, chunk.endMs / 1_000];
    const last = spans.at(-1);
    if (last && start <= last.end + CHUNK_JOIN_SECONDS) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  }
  return manifest.discontinuities.filter((gap) => gap.trackId === trackId).reduce((kept, gap) => {
    const [from, to] = [gap.atMs / 1_000, (gap.atMs + gap.durationMs) / 1_000];
    return kept.flatMap((span) => span.end <= from || span.start >= to ? [span]
      : [...(span.start < from ? [{ start: span.start, end: from }] : []), ...(span.end > to ? [{ start: to, end: span.end }] : [])]);
  }, spans);
}

/**
 * Find and remove phantom lines in saved meetings, with the same speech
 * detection and loudness check new recordings get. Each line is checked
 * against its own source: the microphone for "Microphone", computer audio for
 * everyone else. A line goes only when it is phantom as a whole, and only
 * where that source has recorded audio for all of it: a gap in the recording,
 * or a line past its end, is unknown, not silent.
 */
export async function cleanPhantoms(libraryDir: string, options: CleanPhantomsOptions = {}): Promise<PhantomCleanup[]> {
  const detect = options.detect ?? detectSpeechRegions;
  const assemble = options.assemble ?? assembleCaptureTrack;
  const wanted = options.ids?.length ? new Set(options.ids) : undefined;
  const entries = listTranscriptRecords(libraryDir).filter((entry) => !wanted || wanted.has(entry.id));
  if (wanted) {
    const missing = [...wanted].find((id) => !entries.some((entry) => entry.id === id));
    if (missing) throw new Error(`Transcript not found: ${missing}`);
  }
  const results: PhantomCleanup[] = [];
  for (const entry of entries) {
    const base = { id: entry.id, title: entry.title, segments: entry.segmentCount, phantoms: 0, removed: false };
    const manifestPath = join(entry.directory, 'capture', 'manifest.json');
    if (!existsSync(manifestPath)) { results.push({ ...base, skipped: 'no saved audio' }); continue; }
    if (entry.captureState === 'recording' || entry.captureState === 'processing') {
      results.push({ ...base, skipped: 'still recording or processing' }); continue;
    }
    options.onStatus?.(`Checking ${entry.title}…`);
    const scratch = join(tmpdir(), `seashell-phantoms-${randomUUID()}`);
    try {
      const manifest = loadCaptureSession(manifestPath);
      // The microphone is checked the way it was transcribed: quiet input raised first.
      const tracks = {
        microphone: assemble(manifestPath, manifest, 'microphone', join(scratch, 'microphone.wav'), { normalizeQuiet: true }),
        'system-audio': assemble(manifestPath, manifest, 'system-audio', join(scratch, 'system-audio.wav')),
      };
      const checks = new Map<string, { regions: SpeechRegion[]; pcm: Int16Array; recorded: Array<{ start: number; end: number }> } | undefined>();
      for (const [track, wav] of Object.entries(tracks)) {
        if (!wav) continue;
        const regions = await detect(wav);
        const pcm = regions ? readMonoPcm(readFileSync(wav)) : undefined;
        checks.set(track, regions && pcm ? { regions, pcm, recorded: recordedSpans(manifest, track as CaptureTrackId) } : undefined);
      }
      if ([...checks.values()].every((check) => check === undefined)) {
        results.push({ ...base, skipped: 'speech detection is not available' }); continue;
      }
      const { path, record } = findTranscriptRecord(libraryDir, entry.id);
      let unrecorded = 0;
      const phantom = record.transcript.map((segment) => {
        const check = checks.get(segment.speaker === 'LOCAL' ? 'microphone' : 'system-audio');
        if (!check) return false;
        if (!check.recorded.some((span) => span.start <= segment.start && segment.end <= span.end)) { unrecorded += 1; return false; }
        return isPhantomUnit(segment, check.regions, check.pcm);
      });
      const phantoms = phantom.filter(Boolean).length;
      const counted = { phantoms, ...(unrecorded ? { unrecorded } : {}) };
      if (options.dryRun || phantoms === 0) { results.push({ ...base, segments: record.transcript.length, ...counted }); continue; }
      keepTranscriptHistory(dirname(path), JSON.parse(readFileSync(path, 'utf8')) as TranscriptRecord, 'before-phantom-cleanup');
      pinSegmentIds(record);
      record.transcript = record.transcript.filter((_segment, index) => !phantom[index]);
      record.updatedAt = new Date().toISOString();
      saveTranscriptRecord(libraryDir, record, { keepNotes: REMOVED_SILENT_LINES });
      results.push({ ...base, segments: record.transcript.length + phantoms, ...counted, removed: true });
    } catch (error) {
      results.push({ ...base, skipped: error instanceof Error ? error.message : String(error) });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return results;
}
