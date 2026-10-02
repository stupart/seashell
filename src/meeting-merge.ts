import { copyFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { readBackgroundMeetingState, readBackgroundMeetingStatus, writeBackgroundMeetingState } from './background-meeting-status.ts';
import {
  CaptureSessionStore,
  captureChunkPath,
  captureManifestPath,
  loadCaptureSession,
  readVerifiedCaptureChunk,
  type CaptureSessionManifest,
} from './capture-session.ts';
import { readMeetingWatchLog } from './launch-at-login.ts';
import { createMeetingArtifact, loadMeetingArtifact, saveMeetingArtifact } from './meeting-artifact.ts';
import { readMeetSamples } from './meet-speakers.ts';
import { createTranscriptRecord } from './transcript-record.ts';
import {
  findTranscriptRecord,
  listTranscriptRecords,
  saveTranscriptRecord,
  trashTranscriptRecord,
} from './transcript-library.ts';
import type { Speaker, TranscriptRecord, TranscriptSegment } from './transcript-types.ts';

interface Fragment {
  readonly record: TranscriptRecord;
  readonly directory: string;
  readonly manifestPath: string;
  readonly manifest: CaptureSessionManifest;
  /** What was recorded: a Meet room such as /abc-defg-hij, or an app such as audio:zoom. */
  readonly meeting?: string;
  /** The watcher's own key, e.g. meet:safari:/abc-defg-hij, when known. */
  readonly meetingKey?: string;
}

/** A Meet room is the same call in any browser; other candidates keep their ID. */
function meetingIdentity(key: string): string {
  return /^meet:[a-z]+:(\/[a-z]{3}-[a-z]{4}-[a-z]{3})$/u.exec(key)?.[1] ?? key;
}

/** Captures saved before meetingKey existed are identified by the watcher's log. */
function meetingKeysFromWatchLog(log: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of log.split('\n')) {
    if (!line.includes('"meeting.started"') && !line.includes('"meeting.resumed"')) continue;
    try {
      const event = JSON.parse(line);
      if (typeof event.sessionId === 'string' && typeof event.candidate?.id === 'string') keys.set(event.sessionId, event.candidate.id);
    } catch { /* A torn log line identifies nothing. */ }
  }
  return keys;
}

export interface MeetingMergeGroup {
  readonly ids: readonly string[];
  readonly title: string;
  readonly meeting?: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface MeetingMergeResult {
  readonly record: TranscriptRecord;
  readonly directory: string;
  readonly trashed: readonly string[];
}

function loadFragment(libraryDir: string, id: string, watchLog = new Map<string, string>()): Fragment {
  const { path, record } = findTranscriptRecord(libraryDir, id);
  const directory = dirname(path);
  const state = readBackgroundMeetingState(directory);
  if (state === 'recording' || state === 'processing') {
    throw new Error(`Meeting ${id} is still recording or processing. Wait for it to finish before merging.`);
  }
  const manifestPath = join(directory, 'capture', 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Meeting ${id} has no saved capture audio to merge.`);
  const manifest = loadCaptureSession(manifestPath);
  const key = readBackgroundMeetingStatus(directory)?.meetingKey ?? watchLog.get(manifest.sessionId);
  const meeting = readMeetSamples(manifestPath, manifest).find(sample => sample.meeting)?.meeting ??
    (key ? meetingIdentity(key) : undefined);
  return { record, directory, manifestPath, manifest, ...(meeting ? { meeting } : {}), ...(key ? { meetingKey: key } : {}) };
}

function endedAtUnixMs(fragment: Fragment): number {
  return fragment.manifest.startedAtUnixMs +
    Math.max(0, ...fragment.manifest.chunks.map(chunk => chunk.endMs));
}

/**
 * Find recorded meetings that were split into consecutive pieces: the same
 * Meet room (or, without one, the same title) with short gaps between pieces.
 */
export function planMeetingMerges(libraryDir: string, options: {
  readonly maxGapMinutes?: number;
  /** Test seam; defaults to the background watcher's own log. */
  readonly watchLog?: string;
} = {}): MeetingMergeGroup[] {
  const maxGapMs = (options.maxGapMinutes ?? 15) * 60_000;
  const watchLog = meetingKeysFromWatchLog(options.watchLog ?? readMeetingWatchLog());
  const fragments = listTranscriptRecords(libraryDir)
    .filter(entry => entry.kind === 'meeting' && entry.captureState !== 'recording' && entry.captureState !== 'processing')
    .flatMap(entry => { try { return [loadFragment(libraryDir, entry.id, watchLog)]; } catch { return []; } })
    .toSorted((left, right) => left.manifest.startedAtUnixMs - right.manifest.startedAtUnixMs);
  const key = (fragment: Fragment) => fragment.meeting ?? `title:${fragment.record.title}`;
  const groups: Fragment[][] = [];
  for (const fragment of fragments) {
    // Only consecutive pieces: another meeting in between ends the run.
    const previous = groups.at(-1)?.at(-1);
    if (previous && key(previous) === key(fragment) &&
        fragment.manifest.startedAtUnixMs - endedAtUnixMs(previous) <= maxGapMs) groups.at(-1)!.push(fragment);
    else groups.push([fragment]);
  }
  return groups.filter(group => group.length > 1).map(group => ({
    ids: group.map(fragment => fragment.record.id),
    title: group[0]!.record.title,
    ...(group[0]!.meeting ? { meeting: group[0]!.meeting } : {}),
    startedAt: new Date(group[0]!.manifest.startedAtUnixMs).toISOString(),
    endedAt: new Date(endedAtUnixMs(group.at(-1)!)).toISOString(),
  }));
}

/**
 * Join pieces of one meeting into one library entry on one timeline. The
 * merged capture bundle keeps every verified audio chunk at its wall-clock
 * offset, so later passes (speaker separation, notes) see the whole meeting.
 * The original pieces move to the library's _Trash, not deleted.
 */
export function mergeMeetingFragments(libraryDir: string, ids: readonly string[]): MeetingMergeResult {
  if (new Set(ids).size !== ids.length || ids.length < 2) throw new Error('Choose at least two different meetings to merge.');
  const fragments = ids.map(id => loadFragment(libraryDir, id, meetingKeysFromWatchLog(readMeetingWatchLog())))
    .toSorted((left, right) => left.manifest.startedAtUnixMs - right.manifest.startedAtUnixMs);
  const first = fragments[0]!;
  const origin = first.manifest.startedAtUnixMs;
  const id = `${first.record.id}-merged`;
  // Staging from an interrupted merge has no library entry yet; start over.
  const staging = dirname(captureManifestPath(libraryDir, id));
  if (existsSync(staging) && !listTranscriptRecords(libraryDir).some(entry => entry.id === id)) {
    rmSync(staging, { recursive: true, force: true });
  }
  const store = new CaptureSessionStore({
    libraryDir, sessionId: id, startedAtUnixMs: origin, createdAt: first.manifest.createdAt,
  });
  if (store.manifest.chunks.length) throw new Error(`A merge for ${first.record.id} already exists.`);

  const transcript: TranscriptSegment[] = [];
  const speakers = new Map<string, Speaker>();
  const samples: object[] = [];
  let lastSample = -1;
  for (const fragment of fragments) {
    const offsetMs = fragment.manifest.startedAtUnixMs - origin;
    const chunks = fragment.manifest.chunks.toSorted((left, right) =>
      left.trackId.localeCompare(right.trackId) || left.startMs - right.startMs || left.sequence - right.sequence);
    for (const chunk of chunks) {
      readVerifiedCaptureChunk(fragment.manifestPath, chunk);
      const staged = join(store.root, `.merge-${chunk.id}.wav`);
      copyFileSync(captureChunkPath(fragment.manifestPath, chunk), staged);
      store.commitChunk({
        sourcePath: staged, trackId: chunk.trackId,
        startSeconds: (offsetMs + chunk.startMs) / 1_000, endSeconds: (offsetMs + chunk.endMs) / 1_000,
        audible: chunk.audible, ...(chunk.clock ? { clock: chunk.clock } : {}),
      });
    }
    for (const gap of fragment.manifest.discontinuities) {
      store.recordDiscontinuity({ trackId: gap.trackId, atSeconds: (offsetMs + gap.atMs) / 1_000,
        durationSeconds: gap.durationMs / 1_000, reason: gap.reason });
    }
    for (const sample of readMeetSamples(fragment.manifestPath, fragment.manifest)) {
      const at = Number((sample.at + offsetMs / 1_000).toFixed(3));
      if (at <= lastSample) continue;
      samples.push({ ...sample, at });
      lastSample = at;
    }
    for (const { id: _id, ...segment } of fragment.record.transcript) {
      transcript.push({ ...segment, start: segment.start + offsetMs / 1_000, end: segment.end + offsetMs / 1_000 });
    }
    for (const speaker of fragment.record.speakers) if (!speakers.has(speaker.id)) speakers.set(speaker.id, { ...speaker });
  }
  if (samples.length) {
    writeFileSync(join(store.root, 'meet-speakers.jsonl'), [
      JSON.stringify({ version: 1, sessionId: id, origin }), ...samples.map(sample => JSON.stringify(sample)),
    ].join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  }

  const record = createTranscriptRecord({
    transcript: transcript.toSorted((left, right) => left.start - right.start || left.end - right.end),
    speakers: [...speakers.values()],
    ...(first.record.speakerAnalysis ? { speakerAnalysis: first.record.speakerAnalysis } : {}),
  }, {
    id, now: new Date(first.record.createdAt), title: first.record.title,
    source: {
      filename: 'Live capture session', format: 'capture-session/0.1',
      duration: Math.max(0, ...store.manifest.chunks.map(chunk => chunk.endMs)) / 1_000,
    },
  });
  const saved = saveTranscriptRecord(libraryDir, record);
  store.setStatus('completed', 'merged-fragments');
  store.attachTo(saved.directory);
  const previous = loadMeetingArtifact(libraryDir, first.record.id);
  saveMeetingArtifact(libraryDir, createMeetingArtifact(record, {
    mode: previous?.mode ?? 'hybrid', ...(previous?.calendar ? { calendar: previous.calendar } : {}),
  }));
  const meetingKey = fragments.find(fragment => fragment.meetingKey)?.meetingKey;
  writeBackgroundMeetingState(saved.directory, 'ready', meetingKey ? { meetingKey } : {});
  const trashed = fragments.map(fragment => trashTranscriptRecord(libraryDir, fragment.record.id));
  return { record, directory: saved.directory, trashed };
}
