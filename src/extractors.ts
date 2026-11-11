import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import {
  createMeetingArtifact,
  insightFileName,
  loadMeetingArtifact,
  MeetingAiOffError,
  parseMeetingNoteItems,
  saveMeetingArtifact,
  type MeetingArtifact,
  type MeetingInsight,
} from './meeting-artifact.ts';
import { meetingSegments, ownerInstructions, retryableRun, runSafeId, stableKey } from './meeting-enrichment.ts';
import { meaningful, parseFrontmatter, phraseMatches } from './meeting-templates.ts';
import { humainRouteRequest, olderHumainEngine, runHumainMeeting, type HumainMeetingRoute } from './humain-client.ts';
import { findTranscriptRecord } from './transcript-library.ts';
import type { TranscriptRecord } from './transcript-types.ts';

/**
 * Insight extractors: Markdown files in ~/Documents/Sea Shell/Extractors that
 * pull the same few things out of a meeting every time, each one cited.
 *
 *   ---
 *   name: Customer pains
 *   when: always
 *   fields:
 *     Pains: What is hard or slow for them today
 *     Budget: Any budget, price or spend they mentioned
 *   ---
 *   Look for what the customer says about their own work, not what we pitched.
 *
 * `when` is `always` (after every meeting's final notes), `manual` (only when
 * asked), or a list of title, attendee or app words, any of which runs it.
 * Humain runs each one; results live in meeting.json and insights/<name>.json.
 */

export interface ExtractorField {
  name: string;
  /** What counts; optional, as in Humain. */
  description?: string;
}

export type ExtractorWhen =
  | { kind: 'always' }
  | { kind: 'manual' }
  | { kind: 'match'; title: string[]; attendee: string[]; app: string[] };

export interface Extractor {
  name: string;
  when: ExtractorWhen;
  fields: ExtractorField[];
  prompt: string;
  path: string;
}

/** Humain's limits for one extractor request. */
const LIMITS = { name: 80, fields: 20, fieldName: 60, description: 500, prompt: 8_000 } as const;
const EXTRACT_TIMEOUT_MS = 16 * 60_000;

const EXAMPLE = `---
name: Customer pains
when: manual
fields:
  Pains: What is hard or slow for them today, in their words
  Tools: Products or tools they use now
  Budget: Any budget, price or spend they mentioned
---
<!--
An extractor pulls the same few things out of a meeting every time, and cites
the transcript lines behind each one. Each line under "fields" is one thing to
find: its name, a colon, then what counts.

when: always runs it after every meeting's final notes. To run it only for
some meetings, list words instead:
  when:
    title: [discovery, demo]
    attendee: [acme.com]
    app: [Zoom]
when: manual runs it only when asked:
  seashell extract <meeting-id> "Customer pains"

Write what to look for below this comment. Results show under Insights in a
meeting's notes. Private meetings are never sent.
-->
Look for what the customer says about their own work, not what we pitched.
`;

export function extractorsDirectory(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.SEASHELL_EXTRACTORS_DIR || join(dirname(libraryDir), 'Extractors');
}

/** Made with one example the first time it is asked for. The example only runs by hand. */
export function ensureExtractorsDirectory(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const directory = extractorsDirectory(libraryDir, env);
  if (existsSync(directory)) return directory;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'customer-pains.md'), EXAMPLE, { mode: 0o600 });
  return directory;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

function bounded(value: string, limit: number, label: string): string {
  if (!value) throw new Error(`${label} is empty`);
  if (value.length > limit) throw new Error(`${label} is longer than ${limit} characters`);
  return value;
}

export function parseExtractor(text: string, path: string): Extractor {
  const { fields: front, body } = parseFrontmatter(text);
  const name = bounded(typeof front.name === 'string' && front.name.trim() ? front.name.trim() : basename(path, '.md'),
    LIMITS.name, 'The extractor name');
  const raw = front.when;
  let when: ExtractorWhen;
  if (raw === undefined || raw === 'manual') when = { kind: 'manual' };
  else if (raw === 'always') when = { kind: 'always' };
  else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    when = { kind: 'match', title: list(raw.title), attendee: list(raw.attendee), app: list(raw.app) };
    if (!when.title.length && !when.attendee.length && !when.app.length) {
      throw new Error(`"${name}": when needs title, attendee or app words, or always or manual`);
    }
  } else throw new Error(`"${name}": when must be always, manual, or title, attendee or app words`);
  const declared = front.fields;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new Error(`"${name}" has no fields. Open it to add some.`);
  }
  const fields = Object.entries(declared).map(([field, raw]) => {
    const description = (Array.isArray(raw) ? raw.join(', ') : raw).trim();
    if (description.length > LIMITS.description) throw new Error(`"${name}" field "${field}" is longer than ${LIMITS.description} characters`);
    return { name: bounded(field.trim(), LIMITS.fieldName, `"${name}" field name`), ...(description ? { description } : {}) };
  });
  if (fields.length === 0) throw new Error(`"${name}" has no fields`);
  if (fields.length > LIMITS.fields) throw new Error(`"${name}" has ${fields.length} fields; the most is ${LIMITS.fields}`);
  const seen = new Set<string>();
  for (const field of fields) {
    const key = field.name.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error(`"${name}" lists the field "${field.name}" twice`);
    seen.add(key);
  }
  const prompt = meaningful(body);
  if (prompt.length > LIMITS.prompt) throw new Error(`"${name}": the instructions are longer than ${LIMITS.prompt} characters`);
  return { name, when, fields, prompt, path };
}

/** Every extractor in the folder; a file that does not parse is reported, never fatal. */
export function loadExtractors(libraryDir: string, env: NodeJS.ProcessEnv = process.env): {
  extractors: Extractor[];
  problems: { path: string; message: string }[];
} {
  const directory = extractorsDirectory(libraryDir, env);
  const extractors: Extractor[] = [];
  const problems: { path: string; message: string }[] = [];
  if (!existsSync(directory)) return { extractors, problems };
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.md') && !name.startsWith('.')).sort()) {
    const path = join(directory, file);
    try { extractors.push(parseExtractor(readFileSync(path, 'utf8'), path)); }
    catch (error) { problems.push({ path, message: error instanceof Error ? error.message : String(error) }); }
  }
  return { extractors, problems };
}

export function findExtractor(extractors: readonly Extractor[], name: string): Extractor | undefined {
  const wanted = name.trim().toLocaleLowerCase('en-US');
  return extractors.find((extractor) => extractor.name.toLocaleLowerCase('en-US') === wanted
    || basename(extractor.path, '.md').toLocaleLowerCase('en-US') === wanted);
}

export interface ExtractorDefinition {
  name: string;
  when?: 'always' | 'manual' | { title?: string[]; attendee?: string[]; app?: string[] };
  fields: ExtractorField[] | Record<string, string>;
  prompt?: string;
}

const yamlList = (values: string[]) => `[${values.map((value) => /[,[\]]/u.test(value) ? JSON.stringify(value) : value).join(', ')}]`;

/** The Markdown file for a definition, in the same shape a person would write. */
export function serializeExtractor(definition: ExtractorDefinition): string {
  const fields = Array.isArray(definition.fields) ? definition.fields
    : Object.entries(definition.fields).map(([name, description]) => ({ name, description }));
  const when = definition.when ?? 'manual';
  const whenLines = typeof when === 'string' ? [`when: ${when}`] : ['when:',
    ...(['title', 'attendee', 'app'] as const).flatMap((key) => when[key]?.length ? [`  ${key}: ${yamlList(when[key]!)}`] : [])];
  const oneLine = (value: string) => value.replace(/\s+/gu, ' ').trim();
  return ['---', `name: ${oneLine(definition.name)}`, ...whenLines, 'fields:',
    ...fields.map((field) => `  ${oneLine(field.name).replace(/:/gu, ' ')}:${field.description ? ` ${oneLine(field.description)}` : ''}`), '---',
    ...(definition.prompt?.trim() ? [definition.prompt.trim()] : []), ''].join('\n');
}

function writeExtractorFile(path: string, definition: ExtractorDefinition): Extractor {
  const text = serializeExtractor(definition);
  const parsed = parseExtractor(text, path);
  const wanted = Array.isArray(definition.fields) ? definition.fields.length : Object.keys(definition.fields).length;
  if (parsed.fields.length !== wanted) throw new Error('Each field name must start with a letter or number');
  writeFileSync(path, text, { mode: 0o600 });
  return parsed;
}

export function createExtractor(libraryDir: string, definition: ExtractorDefinition, env: NodeJS.ProcessEnv = process.env): Extractor {
  const directory = ensureExtractorsDirectory(libraryDir, env);
  if (findExtractor(loadExtractors(libraryDir, env).extractors, definition.name)) {
    throw new Error(`An extractor named "${definition.name}" already exists. Update it instead.`);
  }
  const path = join(directory, `${insightFileName(definition.name)}.md`);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  return writeExtractorFile(path, definition);
}

/** Replace the named extractor's definition; unset parts keep their current value. */
export function updateExtractor(
  libraryDir: string, name: string, changes: Partial<ExtractorDefinition>, env: NodeJS.ProcessEnv = process.env,
): Extractor {
  const current = findExtractor(loadExtractors(libraryDir, env).extractors, name);
  if (!current) throw new Error(`No extractor named "${name}" in ${extractorsDirectory(libraryDir, env)}`);
  const when: ExtractorDefinition['when'] = current.when.kind === 'match'
    ? { title: current.when.title, attendee: current.when.attendee, app: current.when.app } : current.when.kind;
  return writeExtractorFile(current.path, {
    name: changes.name ?? current.name,
    when: changes.when ?? when,
    fields: changes.fields ?? current.fields,
    prompt: changes.prompt ?? current.prompt,
  });
}

export function deleteExtractor(libraryDir: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  const current = findExtractor(loadExtractors(libraryDir, env).extractors, name);
  if (!current) throw new Error(`No extractor named "${name}" in ${extractorsDirectory(libraryDir, env)}`);
  rmSync(current.path);
  return current.path;
}

/** Whether an extractor runs by itself for this meeting after its final notes. */
export function extractorMatches(extractor: Extractor, meeting: MeetingArtifact, record?: TranscriptRecord, app?: string): boolean {
  if (extractor.when.kind === 'always') return true;
  if (extractor.when.kind === 'manual') return false;
  const titles = [meeting.title, meeting.calendar?.title, record?.title];
  const people = [...meeting.attendees, ...(meeting.calendar?.attendees ?? [])]
    .flatMap((person) => [person.name, person.email ?? ''])
    .concat(record?.speakers.map((speaker) => speaker.label) ?? [])
    .map((value) => value.toLocaleLowerCase('en-US'));
  const appName = (app ?? meeting.app ?? '').toLocaleLowerCase('en-US');
  return extractor.when.title.some((phrase) => titles.some((title) => phraseMatches(title, phrase)))
    || extractor.when.attendee.some((word) => people.some((person) => person.includes(word.toLocaleLowerCase('en-US'))))
    || extractor.when.app.some((word) => appName !== '' && appName.includes(word.toLocaleLowerCase('en-US')));
}

function parseExtractOutput(value: unknown, extractor: Extractor, validIds: Set<string>): Pick<MeetingInsight, 'summary' | 'fields'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Humain extractor output must be an object');
  const output = value as Record<string, unknown>;
  if (!Array.isArray(output.fields)) throw new Error('Humain extractor output is missing fields');
  const fields = extractor.fields.map((field, index) => {
    const raw = output.fields as unknown[];
    const found = raw[index] as Record<string, unknown> | undefined;
    if (!found || typeof found !== 'object' || found.name !== field.name) {
      throw new Error(`Humain extractor output does not answer "${field.name}" in order`);
    }
    const items = parseMeetingNoteItems(found.items, `Humain extractor field "${field.name}"`);
    const missing = items.flatMap((item) => item.evidenceSegmentIds).find((id) => !validIds.has(id));
    if (missing) throw new Error(`Humain extractor field "${field.name}" cites missing segment ${missing}`);
    return { name: field.name, items };
  });
  if (output.fields.length !== extractor.fields.length) throw new Error('Humain extractor output has extra fields');
  const summary = typeof output.summary === 'string' && output.summary.trim() ? output.summary.trim() : undefined;
  return { ...(summary ? { summary } : {}), fields };
}

export interface RunExtractorOptions {
  route: HumainMeetingRoute;
  onStatus?: (message: string) => void;
  /** Deterministic seam for tests and embedded hosts. */
  runner?: typeof runHumainMeeting;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run one extractor over one meeting and save what it found. Private meetings
 * are refused before anything is sent.
 */
export async function runExtractor(
  libraryDir: string,
  transcriptId: string,
  extractorName: string | Extractor,
  options: RunExtractorOptions,
): Promise<MeetingInsight> {
  const extractor = typeof extractorName === 'string'
    ? findExtractor(loadExtractors(libraryDir, options.env).extractors, extractorName)
    : extractorName;
  if (!extractor) {
    throw new Error(`No extractor named "${String(extractorName)}" in ${extractorsDirectory(libraryDir, options.env)}. See: seashell extractors`);
  }
  const { record, path } = findTranscriptRecord(libraryDir, transcriptId);
  const artifact = loadMeetingArtifact(libraryDir, record.id) ?? createMeetingArtifact(record);
  if (artifact.ai?.off) throw new MeetingAiOffError();
  const segments = meetingSegments(record);
  if (segments.length === 0) throw new Error('This meeting has no transcript text to read');
  const finalClaims = artifact.analysis?.claims ?? artifact.provisionalClaims;
  const context = { calendar: artifact.calendar ?? null, attendees: artifact.attendees };
  // About me and the meeting's own note still apply; the template is for notes.
  const { instructions: owner } = ownerInstructions(libraryDir, artifact, {});
  const instructions = owner ? { ...(owner.profile ? { profile: owner.profile } : {}), ...(owner.note ? { note: owner.note } : {}) } : undefined;
  const request = { name: extractor.name, prompt: extractor.prompt, fields: extractor.fields };
  const storeDir = join(dirname(path), '.humain');
  const idempotencyKey = stableKey([record.id, 'extract', request, segments, finalClaims, options.route, context,
    ...(instructions && Object.keys(instructions).length ? [instructions] : [])]);
  const { runId, idempotencyKey: attemptKey } = retryableRun(storeDir,
    runSafeId(`meeting-${record.id}-extract-${insightFileName(extractor.name)}`, idempotencyKey), idempotencyKey);
  options.onStatus?.(`Running ${extractor.name}…`);
  const run = (options.runner ?? runHumainMeeting)('extract', {
    meetingId: artifact.meetingId,
    ...humainRouteRequest(options.route),
    segments,
    finalClaims,
    context,
    ...(instructions && Object.keys(instructions).length ? { instructions } : {}),
    extractor: request,
    idempotencyKey: attemptKey,
  }, { storeDir, runId, onStatus: options.onStatus, timeoutMs: EXTRACT_TIMEOUT_MS });
  const result = await run.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw olderHumainEngine(message)
      ? new Error('This Humain version cannot run extractors yet. Install a newer engine: seashell ai install <humain-package.tgz>')
      : error;
  });
  const insight: MeetingInsight = {
    extractor: extractor.name,
    createdAt: new Date().toISOString(),
    runId: result.runId,
    ...parseExtractOutput(result.output, extractor, new Set(segments.map((segment) => segment.id))),
  };
  // Re-read: notes or chat may have been saved while this ran.
  const current = loadMeetingArtifact(libraryDir, record.id) ?? artifact;
  saveMeetingArtifact(libraryDir, {
    ...current,
    insights: [...(current.insights ?? []).filter((saved) => saved.extractor !== extractor.name), insight],
  });
  return insight;
}

/**
 * After final notes: every extractor whose `when` fits this meeting. One
 * failing extractor never stops the others or touches the notes.
 */
export async function runAutomaticExtractors(
  libraryDir: string,
  transcriptId: string,
  options: RunExtractorOptions & { app?: string },
): Promise<{ ran: MeetingInsight[]; failed: { extractor: string; message: string }[] }> {
  const ran: MeetingInsight[] = [];
  const failed: { extractor: string; message: string }[] = [];
  const { record } = findTranscriptRecord(libraryDir, transcriptId);
  const artifact = loadMeetingArtifact(libraryDir, record.id);
  if (!artifact?.analysis?.final || artifact.ai?.off) return { ran, failed };
  for (const extractor of loadExtractors(libraryDir, options.env).extractors) {
    if (!extractorMatches(extractor, artifact, record, options.app)) continue;
    try { ran.push(await runExtractor(libraryDir, record.id, extractor, options)); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ extractor: extractor.name, message });
      options.onStatus?.(`${extractor.name} failed: ${message}`);
    }
  }
  return { ran, failed };
}
