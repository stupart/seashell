import { randomUUID } from 'crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'fs';
import { dirname, join } from 'path';
import { captureManifestPath, loadCaptureSession } from './capture-session.ts';
import {
  createMeetingArtifact,
  loadMeetingArtifact,
  MeetingAiOffError,
  OWNER_NOTE_LIMITS,
  parseOwnerNote,
  saveMeetingArtifact,
  type MeetingArtifact,
  type OwnerNote,
} from './meeting-artifact.ts';
import { meetingCommandPath } from './meeting-command.ts';
import { findTranscriptRecord } from './transcript-library.ts';

/**
 * Notes the owner types about a meeting: "Dana sounded unsure about the date".
 *
 * While a call records, each note is appended to the capture bundle, beside the
 * audio, so a crash keeps it and `seashell capture finalize` finds it. When the
 * meeting is saved the notes move into meeting.json, where notes added later
 * join them. Final notes read them as the owner's own account of the meeting.
 */

export const OWNER_NOTES_FILE = 'owner-notes.jsonl';

/** One line of typed text, or a plain reason it cannot be a note. */
export function noteText(text: string): string {
  const clean = text.replace(/\s+/gu, ' ').trim();
  if (!clean) throw new Error('A note needs some text.');
  if (clean.length > OWNER_NOTE_LIMITS.text) {
    throw new Error(`A note can be up to ${OWNER_NOTE_LIMITS.text.toLocaleString('en-US')} characters; this one is ${clean.length.toLocaleString('en-US')}.`);
  }
  return clean;
}

export function createOwnerNote(text: string, at?: number, now = new Date()): OwnerNote {
  return {
    id: `n${randomUUID().replace(/-/gu, '').slice(0, 10)}`,
    text: noteText(text),
    ...(at === undefined ? {} : { at: Math.max(0, Math.round(at * 1000) / 1000) }),
    addedAt: now.toISOString(),
  };
}

/** Notes in the order they belong: by when in the meeting, then when written; notes about the whole meeting last. */
export function sortOwnerNotes(notes: readonly OwnerNote[]): OwnerNote[] {
  return notes.toSorted((left, right) => (left.at ?? Infinity) - (right.at ?? Infinity) || left.addedAt.localeCompare(right.addedAt));
}

/** Each note once, by id, keeping the first copy. */
export function mergeOwnerNotes(...lists: ReadonlyArray<readonly OwnerNote[] | undefined>): OwnerNote[] {
  const byId = new Map<string, OwnerNote>();
  for (const note of lists.flatMap((list) => list ?? [])) if (!byId.has(note.id)) byId.set(note.id, note);
  return sortOwnerNotes([...byId.values()]);
}

// MARK: - The capture bundle

/** Only whole lines were written; a torn last line is dropped, and so is one that does not read. */
export function readBundleNotes(bundleRoot: string): OwnerNote[] {
  const path = join(bundleRoot, OWNER_NOTES_FILE);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { return [parseOwnerNote(JSON.parse(line))]; } catch { return []; }
  });
}

/** Appended and flushed to disk before it counts as saved. */
export function appendBundleNote(bundleRoot: string, note: OwnerNote): void {
  if (!existsSync(bundleRoot)) throw new Error('The recording has just finished. Add the note to the meeting instead.');
  if (readBundleNotes(bundleRoot).length >= OWNER_NOTE_LIMITS.notes) {
    throw new Error(`This meeting already has ${OWNER_NOTE_LIMITS.notes} notes, the most it can keep.`);
  }
  const descriptor = openSync(join(bundleRoot, OWNER_NOTES_FILE), 'a', 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(note)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Where a recording's bundle is while it records: under _Capture, until it is saved with its meeting. */
export function recordingBundle(libraryDir: string, sessionId: string): string | undefined {
  try {
    const path = captureManifestPath(libraryDir, sessionId);
    return existsSync(path) ? dirname(path) : undefined;
  } catch { return undefined; }
}

/** A note at this moment of a recording, on its clock: seconds since its audio began. */
export function noteAtMoment(bundleRoot: string, atUnixMs: number): number {
  const manifest = loadCaptureSession(join(bundleRoot, 'manifest.json'));
  return Math.max(0, (atUnixMs - manifest.startedAtUnixMs) / 1000);
}

/** Write a note into a recording's bundle, timed by when it was typed. */
export function addRecordingNote(bundleRoot: string, text: string, typedAtUnixMs = Date.now()): OwnerNote {
  const note = createOwnerNote(text, noteAtMoment(bundleRoot, typedAtUnixMs), new Date(typedAtUnixMs));
  appendBundleNote(bundleRoot, note);
  return note;
}

// MARK: - Meetings

/**
 * Everything the owner wrote about a meeting: what is saved in meeting.json,
 * plus anything still in its capture bundle, whether that is recording or was
 * saved with the meeting and not carried over yet.
 */
export function meetingOwnerNotes(libraryDir: string, transcriptId: string, artifact?: MeetingArtifact): OwnerNote[] {
  let saved = artifact?.ownerNotes;
  let attached: OwnerNote[] = [];
  try {
    const { path } = findTranscriptRecord(libraryDir, transcriptId);
    attached = readBundleNotes(join(dirname(path), 'capture'));
    if (!artifact) saved = loadMeetingArtifact(libraryDir, transcriptId)?.ownerNotes;
  } catch { /* A meeting being written for the first time has no folder yet. */ }
  const recording = recordingBundle(libraryDir, transcriptId);
  return mergeOwnerNotes(saved, attached, recording ? readBundleNotes(recording) : []);
}

/**
 * Move the notes from a meeting's attached capture bundle into its meeting.json.
 * Safe to repeat: notes already there stay once. A meeting with notes and no
 * meeting.json yet gets one, so the notes are never only in the bundle.
 */
export function carryCaptureNotes(libraryDir: string, transcriptId: string): MeetingArtifact | undefined {
  const { path, record } = findTranscriptRecord(libraryDir, transcriptId);
  const bundled = readBundleNotes(join(dirname(path), 'capture'));
  const artifact = loadMeetingArtifact(libraryDir, transcriptId);
  if (!bundled.length) return artifact;
  const current = artifact ?? createMeetingArtifact(record);
  const merged = mergeOwnerNotes(current.ownerNotes, bundled);
  if (artifact && merged.length === (artifact.ownerNotes?.length ?? 0)) return artifact;
  const next = { ...current, ownerNotes: merged };
  saveMeetingArtifact(libraryDir, next);
  return next;
}

/**
 * Add a note to a meeting, at a moment in it or about the whole of it: into its
 * bundle while it records, otherwise into meeting.json. A private meeting still
 * takes notes: they are the owner's, and are never sent while AI is off.
 */
export function addMeetingNote(libraryDir: string, transcriptId: string, text: string, options: { at?: number; now?: Date } = {}): OwnerNote {
  const recording = recordingBundle(libraryDir, transcriptId);
  if (recording) {
    const note = createOwnerNote(text, options.at, options.now);
    appendBundleNote(recording, note);
    return note;
  }
  const { record } = findTranscriptRecord(libraryDir, transcriptId);
  const artifact = carryCaptureNotes(libraryDir, transcriptId) ?? loadMeetingArtifact(libraryDir, transcriptId) ?? createMeetingArtifact(record);
  const notes = artifact.ownerNotes ?? [];
  if (notes.length >= OWNER_NOTE_LIMITS.notes) throw new Error(`This meeting already has ${OWNER_NOTE_LIMITS.notes} notes, the most it can keep.`);
  if (options.at !== undefined && record.source.duration !== undefined && options.at > record.source.duration + 1) {
    throw new Error('That time is after the meeting ended.');
  }
  const note = createOwnerNote(text, options.at, options.now);
  saveMeetingArtifact(libraryDir, { ...artifact, ownerNotes: mergeOwnerNotes(notes, [note]) });
  return note;
}

/** The notes meeting.json holds, read without checking the transcript, as a meeting is written afresh. */
export function savedOwnerNotes(directory: string): OwnerNote[] {
  try {
    const raw = JSON.parse(readFileSync(join(directory, 'meeting.json'), 'utf8')) as { ownerNotes?: unknown };
    return Array.isArray(raw.ownerNotes) ? raw.ownerNotes.flatMap((note) => {
      try { return [parseOwnerNote(note)]; } catch { return []; }
    }) : [];
  } catch { return []; }
}

/** The notes to send with final notes, or none: a private meeting sends nothing at all. */
export function ownerNotesForAi(artifact: MeetingArtifact, notes: readonly OwnerNote[]): Array<{ id: string; text: string; at?: number }> {
  if (artifact.ai?.off) throw new MeetingAiOffError();
  return sortOwnerNotes(notes).slice(0, OWNER_NOTE_LIMITS.notes).map((note) => ({
    id: note.id, text: note.text, ...(note.at === undefined ? {} : { at: note.at }),
  }));
}

// MARK: - Notes from a terminal

/**
 * `seashell note "…"` during a recording. The background recorder owns the
 * bundle, so the terminal leaves a one-shot file for it, as `seashell record`
 * does; each note is its own file, so two in a row are both kept. The note is
 * timed by when it was typed, not by when the recorder reads it.
 */
export function noteCommandDirectory(): string {
  return join(dirname(meetingCommandPath()), 'meeting-notes');
}

interface NoteCommandFile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly text: string;
  readonly createdAtUnixMs: number;
}

export function writeNoteCommand(text: string, nowUnixMs = Date.now(), directory = noteCommandDirectory()): string {
  const value: NoteCommandFile = { schemaVersion: 1, id: randomUUID(), text: noteText(text), createdAtUnixMs: nowUnixMs };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${nowUnixMs}-${value.id}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
}

/** Read each waiting note once and delete it. One older than the recording's last few minutes is dropped. */
export function consumeNoteCommands(
  directory = noteCommandDirectory(),
  nowUnixMs = Date.now(),
  maximumAgeMs = 10 * 60_000,
): Array<{ text: string; createdAtUnixMs: number }> {
  if (!existsSync(directory)) return [];
  const notes: Array<{ text: string; createdAtUnixMs: number }> = [];
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.json')).sort()) {
    const path = join(directory, name);
    let value: Partial<NoteCommandFile> | undefined;
    try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { value = undefined; }
    finally { rmSync(path, { force: true }); }
    if (!value || value.schemaVersion !== 1 || typeof value.text !== 'string' || !Number.isSafeInteger(value.createdAtUnixMs)) continue;
    const age = nowUnixMs - Number(value.createdAtUnixMs);
    if (age < -5_000 || age > maximumAgeMs) continue;
    try { notes.push({ text: noteText(value.text), createdAtUnixMs: Number(value.createdAtUnixMs) }); } catch { continue; }
  }
  return notes;
}
