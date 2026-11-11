import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { readBackgroundMeetingState } from './background-meeting-status.ts';
import { assembleCaptureTrack } from './capture-finalizer.ts';
import { loadCaptureSession } from './capture-session.ts';
import { transcriptSegmentId } from './meeting-artifact.ts';
import { detectSpeechRegions, isPhantomUnit, readMonoPcm, type SpeechRegion } from './speech-gate.ts';
import {
  findTranscriptRecord,
  listTranscriptRecords,
  renameTranscriptSpeaker,
  saveTranscriptRecord,
} from './transcript-library.ts';
import type { TranscriptRecord } from './transcript-types.ts';
import { forgetVoiceprint, sameVoiceName } from './voiceprints.ts';

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

/** history/transcripts/<time>-<why>.json: the transcript exactly as it was before a change. */
export function keepTranscriptHistory(directory: string, record: TranscriptRecord, why: string): string {
  const folder = join(directory, 'history', 'transcripts');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${new Date().toISOString().replace(/[:.]/gu, '-')}-${why}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return path;
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

/**
 * Name a speaker by ID or by the label they have now ("Remote speaker 1"), as
 * an agent does through the meetings server. The transcript as it was is kept
 * in history, and the name never teaches the voice library: an agent's name
 * is a reading of the transcript, not the owner knowing the voice.
 */
export function renameMeetingSpeaker(
  libraryDir: string, transcriptId: string, speaker: string, name: string,
): { id: string; speakerId: string; from: string; to: string } {
  const { path, record } = findTranscriptRecord(libraryDir, transcriptId);
  const wanted = speaker.trim().toLocaleLowerCase('en-US');
  const found = record.speakers.find((candidate) => candidate.id === speaker.trim())
    ?? record.speakers.find((candidate) => candidate.label.toLocaleLowerCase('en-US') === wanted);
  if (!found) {
    throw new Error(`No speaker "${speaker}" in this meeting. Speakers: ${record.speakers.map((candidate) => `${candidate.label} (${candidate.id})`).join(', ') || 'none'}`);
  }
  const from = found.label;
  if (!name.trim()) throw new Error('Speaker name cannot be empty');
  assertNotCapturing(dirname(path));
  keepTranscriptHistory(dirname(path), JSON.parse(readFileSync(path, 'utf8')) as TranscriptRecord, 'renamed-speaker');
  renameTranscriptSpeaker(libraryDir, record.id, found.id, name, { learnVoice: false });
  return { id: record.id, speakerId: found.id, from, to: name.trim() };
}

/**
 * Forget a person's voice: their voiceprint, their voice in every meeting
 * where a speaker bears their name, and the names Seashell suggested from the
 * print, which go back to the number they had. Names Tyler gave stay.
 */
export function forgetPersonVoice(
  libraryDir: string, name: string, env: NodeJS.ProcessEnv = process.env,
): { forgotten: boolean; suggestionsUndone: number } {
  const speakers: Array<{ transcriptId: string; speakerId: string }> = [];
  let suggestionsUndone = 0;
  for (const entry of listTranscriptRecords(libraryDir)) {
    let record: TranscriptRecord;
    try { record = findTranscriptRecord(libraryDir, entry.id).record; } catch { continue; }
    for (const speaker of record.speakers.filter((candidate) => sameVoiceName(candidate.label, name))) {
      speakers.push({ transcriptId: record.id, speakerId: speaker.id });
      if (speaker.suggestion?.source !== 'voice') continue;
      try {
        renameTranscriptSpeaker(libraryDir, record.id, speaker.id, speaker.suggestion.previous, { learnVoice: false });
        suggestionsUndone += 1;
      } catch { /* Still recording or processing: its label stays as it is. */ }
    }
  }
  return { forgotten: forgetVoiceprint(name, env, speakers), suggestionsUndone };
}

export interface PhantomCleanup {
  id: string;
  title: string;
  segments: number;
  /** Lines with no speech under them and no sound above a whisper. */
  phantoms: number;
  removed: boolean;
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

/**
 * Find and remove phantom lines in saved meetings, with the same speech
 * detection and loudness check new recordings get. Each line is checked
 * against its own source: the microphone for "Microphone", computer audio for
 * everyone else. A line goes only when it is phantom as a whole.
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
      const checks = new Map<string, { regions: SpeechRegion[]; pcm: Int16Array } | undefined>();
      for (const [track, wav] of Object.entries(tracks)) {
        if (!wav) continue;
        const regions = await detect(wav);
        const pcm = regions ? readMonoPcm(readFileSync(wav)) : undefined;
        checks.set(track, regions && pcm ? { regions, pcm } : undefined);
      }
      if ([...checks.values()].every((check) => check === undefined)) {
        results.push({ ...base, skipped: 'speech detection is not available' }); continue;
      }
      const { path, record } = findTranscriptRecord(libraryDir, entry.id);
      const phantom = record.transcript.map((segment) => {
        const check = checks.get(segment.speaker === 'LOCAL' ? 'microphone' : 'system-audio');
        return check ? isPhantomUnit(segment, check.regions, check.pcm) : false;
      });
      const phantoms = phantom.filter(Boolean).length;
      if (options.dryRun || phantoms === 0) { results.push({ ...base, segments: record.transcript.length, phantoms }); continue; }
      keepTranscriptHistory(dirname(path), JSON.parse(readFileSync(path, 'utf8')) as TranscriptRecord, 'before-phantom-cleanup');
      pinSegmentIds(record);
      record.transcript = record.transcript.filter((_segment, index) => !phantom[index]);
      record.updatedAt = new Date().toISOString();
      saveTranscriptRecord(libraryDir, record, { keepNotes: REMOVED_SILENT_LINES });
      results.push({ ...base, segments: record.transcript.length + phantoms, phantoms, removed: true });
    } catch (error) {
      results.push({ ...base, skipped: error instanceof Error ? error.message : String(error) });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return results;
}
