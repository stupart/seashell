import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { SpeakerVoice } from './diarize.ts';
import { anonymousSpeakerLabel } from './speaker-labeling.ts';
import type { Speaker, TranscriptRecord } from './transcript-types.ts';

/**
 * Recognise people across meetings by voice, on this Mac only.
 *
 * Every separated speaker gets a voice embedding from native/bin/seashell-speakers
 * (community-1's embedding model, up to a minute of their clean speech). Each
 * meeting's unnamed voices are kept under Voices/meetings for 90 days so that,
 * when Tyler names a speaker, that voice becomes part of the person's
 * voiceprint under Voices/people. Later meetings compare their remote voices
 * with the prints and suggest a name only for a close, unambiguous match.
 * Nothing here is uploaded, exported, or written into transcripts. A private
 * meeting keeps no voices, a meeting moved to the Trash loses its own, and
 * forgetting a person deletes their print and their voice in every meeting.
 */

export interface VoiceMatch {
  name: string;
  similarity: number;
}

interface VoiceSample {
  transcriptId: string;
  speakerId: string;
  embedding: number[];
  seconds: number;
  savedAt: string;
}

interface PersonFile {
  version: 1;
  name: string;
  samples: VoiceSample[];
}

interface MeetingVoicesFile {
  version: 1;
  transcriptId: string;
  savedAt: string;
  voices: Record<string, SpeakerVoice>;
}

// Measured on 13 AMI meetings (four meeting series, 16 people, as recorded and
// through 16 kbit/s Opus like a video call): comparing one meeting's voice of a
// person with another meeting's, with at least 10 seconds of clean speech each,
// the same person scored 0.71 to 0.98 and two different people never above 0.50
// (16,170 pairs; 99% below 0.37). Naming each person once and matching the
// series' later meetings suggested 30 of 30 named people and nobody else, and
// 44 voices of people never named stayed unnamed. Voices across Tyler's calls,
// unlabelled, split the same way, with 9 of 464 pairs between 0.5 and 0.7:
// 0.7 keeps those unnamed.
/** A voice this alike to a print is suggested as that person. */
export const VOICE_MATCH_THRESHOLD = 0.7;
/** ...and only when the next-closest person is at least this much further away. */
export const VOICE_MATCH_MARGIN = 0.1;
/** Voices from less clean speech than this are neither saved to a print nor matched. */
export const MIN_VOICE_SECONDS = 10;
/** A print keeps the voices of this many meetings, the most recent first. */
const SAMPLES_PER_PERSON = 20;
/** A meeting's voices wait this long to be named; then they go, and only prints keep a voice. */
export const MEETING_VOICES_DAYS = 90;

export function voicesDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SEASHELL_VOICES_DIR) return env.SEASHELL_VOICES_DIR;
  const home = env.HOME || homedir();
  return process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Sea Shell', 'Voices')
    : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'seashell', 'Voices');
}

function normalizedName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

/** Whether two names are the same person's, as voiceprints are looked up. */
export function sameVoiceName(left: string, right: string): boolean {
  return normalizedName(left) === normalizedName(right);
}

function personPath(directory: string, name: string): string {
  return join(directory, 'people', `${createHash('sha256').update(normalizedName(name)).digest('hex').slice(0, 24)}.json`);
}

function meetingPath(directory: string, transcriptId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(transcriptId)) throw new Error('Transcript ID is unsafe');
  return join(directory, 'meetings', `${transcriptId}.json`);
}

function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function validEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === 'number' && Number.isFinite(x));
}

function readPerson(path: string): PersonFile | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as PersonFile;
    if (raw.version !== 1 || typeof raw.name !== 'string' || !Array.isArray(raw.samples)) return undefined;
    return { version: 1, name: raw.name, samples: raw.samples.filter((sample) => validEmbedding(sample?.embedding)) };
  } catch {
    return undefined;
  }
}

function people(directory: string): Array<{ path: string; person: PersonFile }> {
  const folder = join(directory, 'people');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith('.json')).flatMap((name) => {
    const path = join(folder, name);
    const person = readPerson(path);
    return person ? [{ path, person }] : [];
  });
}

function normalize(vector: readonly number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 ? vector.map((x) => x / norm) : [...vector];
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return -1;
  let dot = 0, a = 0, b = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    a += left[index]! ** 2;
    b += right[index]! ** 2;
  }
  return a > 0 && b > 0 ? dot / Math.sqrt(a * b) : -1;
}

/** A print is the average of the person's voices in the meetings they were named in. */
function voiceprint(person: PersonFile): number[] | undefined {
  const [first] = person.samples;
  if (!first) return undefined;
  const sum = new Array<number>(first.embedding.length).fill(0);
  for (const sample of person.samples) {
    if (sample.embedding.length !== sum.length) continue;
    const unit = normalize(sample.embedding);
    for (let index = 0; index < sum.length; index += 1) sum[index]! += unit[index]!;
  }
  return normalize(sum);
}

/** Keep a meeting's voices so a speaker named later can join that person's print. */
export function saveMeetingVoices(
  transcriptId: string,
  voices: ReadonlyMap<string, SpeakerVoice>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (voices.size === 0) return;
  const file: MeetingVoicesFile = {
    version: 1, transcriptId, savedAt: new Date().toISOString(), voices: Object.fromEntries(voices),
  };
  writePrivate(meetingPath(voicesDirectory(env), transcriptId), file);
}

/** Take some speakers' voices out of a meeting's file, deleting it once none are left. */
function dropMeetingVoices(directory: string, transcriptId: string, speakerIds: ReadonlySet<string>): void {
  const file = readMeetingVoices(directory, transcriptId);
  if (!file) return;
  const voices = Object.fromEntries(Object.entries(file.voices).filter(([speakerId]) => !speakerIds.has(speakerId)));
  if (Object.keys(voices).length === Object.keys(file.voices).length) return;
  if (Object.keys(voices).length) writePrivate(meetingPath(directory, transcriptId), { ...file, voices });
  else rmSync(meetingPath(directory, transcriptId), { force: true });
}

/** Take a meeting's voices out of every print, deleting a print left with none. */
function dropFromPrints(directory: string, keep: (sample: VoiceSample) => boolean): void {
  for (const { path, person } of people(directory)) {
    const kept = person.samples.filter(keep);
    if (kept.length === person.samples.length) continue;
    if (kept.length) writePrivate(path, { ...person, samples: kept });
    else rmSync(path, { force: true });
  }
}

/**
 * Forget the voices a meeting gave: its file of voices and, unless only the
 * file should go (a meeting moved to the Trash), its voice in every print. A
 * private meeting keeps none.
 */
export function forgetMeetingVoices(transcriptId: string, options: { fromPrints?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): void {
  const directory = voicesDirectory(env);
  rmSync(meetingPath(directory, transcriptId), { force: true });
  if (options.fromPrints !== false) dropFromPrints(directory, (sample) => sample.transcriptId !== transcriptId);
}

/** Delete meetings' voices older than MEETING_VOICES_DAYS. Run as each meeting is finalized. */
export function forgetExpiredMeetingVoices(env: NodeJS.ProcessEnv = process.env, nowUnixMs = Date.now()): string[] {
  const folder = join(voicesDirectory(env), 'meetings');
  if (!existsSync(folder)) return [];
  const oldest = nowUnixMs - MEETING_VOICES_DAYS * 86_400_000;
  return readdirSync(folder).filter((name) => name.endsWith('.json')).flatMap((name) => {
    const path = join(folder, name);
    let saved: number;
    try { saved = Date.parse((JSON.parse(readFileSync(path, 'utf8')) as MeetingVoicesFile).savedAt); } catch { saved = Number.NaN; }
    // A file without a readable date is aged by when it was written.
    if (!Number.isFinite(saved)) { try { saved = statSync(path).mtimeMs; } catch { return []; } }
    if (saved >= oldest) return [];
    rmSync(path, { force: true });
    return [name.slice(0, -'.json'.length)];
  });
}

function readMeetingVoices(directory: string, transcriptId: string): MeetingVoicesFile | undefined {
  try {
    const raw = JSON.parse(readFileSync(meetingPath(directory, transcriptId), 'utf8')) as MeetingVoicesFile;
    return raw.version === 1 && raw.transcriptId === transcriptId && raw.voices && typeof raw.voices === 'object' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** How much of the speaker's saved lines fall inside the turns the voice came from. */
function sameVoice(record: Pick<TranscriptRecord, 'transcript'>, speakerId: string, voice: SpeakerVoice): boolean {
  const lines = record.transcript.filter((segment) => segment.speaker === speakerId && segment.end > segment.start);
  const total = lines.reduce((sum, line) => sum + line.end - line.start, 0);
  if (total === 0 || !Array.isArray(voice.spans)) return false;
  let inside = 0;
  for (const line of lines) {
    for (const [start, end] of voice.spans) inside += Math.max(0, Math.min(line.end, end) - Math.max(line.start, start));
  }
  return inside / total >= 0.5;
}

/**
 * Tyler named a speaker: make that voice part of the person's print. Renaming
 * a speaker again moves its voice to the new name, and a number such as
 * "Remote speaker 2" takes it out of every print. Speakers with too little
 * clean speech, or whose meeting was separated again since, add nothing.
 * Voiceprints are optional, so this never throws: naming works without them.
 */
export function rememberVoice(
  record: Pick<TranscriptRecord, 'id' | 'transcript'>,
  speakerId: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const directory = voicesDirectory(env);
    dropFromPrints(directory, (sample) => !(sample.transcriptId === record.id && sample.speakerId === speakerId));
    if (anonymousSpeakerLabel({ id: speakerId, label: name })) return false;
    const voice = readMeetingVoices(directory, record.id)?.voices[speakerId];
    if (!voice || !validEmbedding(voice.embedding) || voice.seconds < MIN_VOICE_SECONDS || !sameVoice(record, speakerId, voice)) return false;
    const path = personPath(directory, name);
    const person = readPerson(path) ?? { version: 1 as const, name: name.trim(), samples: [] };
    const sample: VoiceSample = {
      transcriptId: record.id, speakerId, embedding: normalize(voice.embedding), seconds: voice.seconds, savedAt: new Date().toISOString(),
    };
    writePrivate(path, { version: 1, name: name.trim(), samples: [sample, ...person.samples].slice(0, SAMPLES_PER_PERSON) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Known people whose prints match these voices. Conservative by design: a voice
 * is matched only above VOICE_MATCH_THRESHOLD, clear of every other print by
 * VOICE_MATCH_MARGIN, and a person goes to at most one voice per meeting (two
 * close voices are left unnamed rather than both given the name).
 */
export function matchKnownVoices(
  voices: ReadonlyMap<string, Pick<SpeakerVoice, 'embedding' | 'seconds'>>,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, VoiceMatch> {
  if (voices.size === 0) return new Map();
  let prints: Array<{ name: string; print: number[] }>;
  try {
    prints = people(voicesDirectory(env)).flatMap(({ person }) => {
      const print = voiceprint(person);
      return print ? [{ name: person.name, print }] : [];
    });
  } catch {
    return new Map();
  }
  const candidates: Array<{ speakerId: string; name: string; similarity: number }> = [];
  for (const [speakerId, voice] of voices) {
    if (voice.seconds < MIN_VOICE_SECONDS || !validEmbedding(voice.embedding)) continue;
    const ranked = prints.map(({ name, print }) => ({ name, similarity: cosine(voice.embedding, print) }))
      .sort((a, b) => b.similarity - a.similarity);
    const [best, next] = ranked;
    if (!best || best.similarity < VOICE_MATCH_THRESHOLD) continue;
    if (next && best.similarity - next.similarity < VOICE_MATCH_MARGIN) continue;
    candidates.push({ speakerId, ...best });
  }
  const matches = new Map<string, VoiceMatch>();
  for (const candidate of candidates) {
    const rivals = candidates.filter((other) => other.name === candidate.name && other.speakerId !== candidate.speakerId);
    if (rivals.length === 0) matches.set(candidate.speakerId, { name: candidate.name, similarity: candidate.similarity });
  }
  return matches;
}

/**
 * Put suggested names on unnamed speakers. The label becomes the name so every
 * view reads naturally; `suggestion` marks it as Sea Shell's guess and keeps the
 * old label, so renaming the speaker back to it undoes the suggestion.
 */
export function applyVoiceSuggestions<T extends { speakers: Speaker[] }>(document: T, matches: ReadonlyMap<string, VoiceMatch>): T {
  if (matches.size === 0) return document;
  return {
    ...document,
    speakers: document.speakers.map((speaker) => {
      const match = matches.get(speaker.id);
      if (!match || !anonymousSpeakerLabel(speaker)) return speaker;
      return { ...speaker, label: match.name, suggestion: { source: 'voice' as const, previous: speaker.label, similarity: Math.round(match.similarity * 1000) / 1000 } };
    }),
  };
}

/** The people with a voiceprint, for settings and `seashell speakers voices`. */
export function listVoiceprints(env: NodeJS.ProcessEnv = process.env): Array<{ name: string; meetings: number }> {
  return people(voicesDirectory(env)).map(({ person }) => ({ name: person.name, meetings: person.samples.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Delete a person's voiceprint and their voice in each meeting it came from,
 * plus `speakers`, the meetings' speakers that bear their name, so naming
 * someone again can't bring the voice back. Use forgetPersonVoice, which also
 * finds those speakers and undoes the names suggested from the print.
 */
export function forgetVoiceprint(
  name: string, env: NodeJS.ProcessEnv = process.env, speakers: ReadonlyArray<{ transcriptId: string; speakerId: string }> = [],
): boolean {
  const directory = voicesDirectory(env);
  const match = people(directory).find(({ person }) => normalizedName(person.name) === normalizedName(name));
  const theirs = new Map<string, Set<string>>();
  for (const { transcriptId, speakerId } of [...match?.person.samples ?? [], ...speakers]) {
    theirs.set(transcriptId, (theirs.get(transcriptId) ?? new Set()).add(speakerId));
  }
  for (const [transcriptId, speakerIds] of theirs) {
    try { dropMeetingVoices(directory, transcriptId, speakerIds); } catch { /* An unsafe ID never named a file. */ }
  }
  if (!match) return false;
  rmSync(match.path, { force: true });
  return true;
}
