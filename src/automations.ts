import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  writeFileSync, writeSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { approvalKey, signApproval, validApproval } from './approval-key.ts';
import { defaultConfigPath } from './config.ts';
import { runAutomaticExtractors, runExtractor } from './extractors.ts';
import type { HumainMeetingRoute, runHumainMeeting } from './humain-client.ts';
import { insightFileName, loadMeetingArtifact, saveMeetingArtifact, transcriptSegmentId, type MeetingArtifact } from './meeting-artifact.ts';
import { meaningful, parseFrontmatter, phraseMatches } from './meeting-templates.ts';
import { HEADING, meetingViewLines, plainMeetingLines, SUBHEADING } from './meeting-tui.ts';
import { findTranscriptRecord } from './transcript-library.ts';
import { renderText, speakerLabel } from './transcript-renderer.ts';
import type { TranscriptRecord } from './transcript-types.ts';
import { postWebhook, webhookAddressProblem } from './webhook-post.ts';

/**
 * Automations: Markdown files in ~/Documents/Sea Shell/Automations that do
 * something when a meeting is ready.
 *
 *   ---
 *   name: File customer calls
 *   when: meeting ready
 *   title: [discovery, demo]
 *   ---
 *   - extract: Customer pains
 *   - write: ~/Documents/Customer calls
 *   - shell: ~/bin/file-call.sh
 *   - webhook: https://hooks.example.com/meetings
 *
 * title, attendee, app and calendar narrow which meetings it runs for; every
 * one listed must match. Anything that leaves Seashell (shell, webhook, or a
 * write outside the Sea Shell folder) asks the owner first, once per version
 * of the file. A write never replaces a file Seashell did not make. One an
 * agent adds or changes is off until the owner turns it on in the file.
 * Private meetings never run. Every run is logged to automation-runs.jsonl in
 * the library.
 */

export type AutomationAction =
  | { kind: 'extract'; extractor: string }
  | { kind: 'write'; target: string }
  | { kind: 'shell'; command: string }
  | { kind: 'webhook'; url: string };

export interface AutomationFilters {
  title: string[];
  attendee: string[];
  app: string[];
  calendar: string[];
}

export interface Automation {
  name: string;
  enabled: boolean;
  /** "agent" when an agent added or last changed it, through the meetings server. */
  by?: 'agent';
  filters: AutomationFilters;
  actions: AutomationAction[];
  path: string;
  /** Of the whole file: any edit asks again before sending anything outside. */
  hash: string;
}

const SHELL_TIMEOUT_MS = 2 * 60_000;
const WEBHOOK_TIMEOUT_MS = 20_000;

const example = (notes: string) => `---
name: Save notes to a folder
when: meeting ready
enabled: false
---
<!--
An automation runs by itself when a meeting is ready. This one is off until
you change "enabled: false" to "enabled: true".

Only run it for some meetings by listing words; every list given must match:
  title: [standup, sync]
  attendee: [acme.com]
  app: [Zoom]
  calendar: [Work]

Actions, one per line, run in order:
  - extract: Customer pains           run an extractor
  - write: ~/Documents/Meeting notes  save the notes as Markdown in a folder
  - shell: ~/bin/file-meeting.sh      run a command; the meeting's JSON is on stdin
  - webhook: https://example.com/hook post the meeting's JSON

shell, webhook, and write to a folder outside the Sea Shell folder send the
meeting outside Seashell, so Seashell asks you before the first one runs, and
again whenever this file changes. write never replaces a file Seashell did not
make: it saves beside it instead. Private meetings never run. Each run is
logged in automation-runs.jsonl in your library.
-->
- write: ${notes}
`;

export function automationsDirectory(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.SEASHELL_AUTOMATIONS_DIR || join(dirname(libraryDir), 'Automations');
}

export function ensureAutomationsDirectory(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const directory = automationsDirectory(libraryDir, env);
  if (existsSync(directory)) return directory;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The example saves inside the Sea Shell folder, so it never needs asking about.
  const notes = join(seashellFolder(libraryDir), 'Notes');
  const home = homedir();
  writeFileSync(join(directory, 'save-notes.md'), example(notes.startsWith(`${home}${sep}`) ? `~/${relative(home, notes)}` : notes), { mode: 0o600 });
  return directory;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

/** Control and invisible formatting characters (bidi overrides, zero-width), and line separators. */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Why a write: target cannot be used, or undefined: a folder or .md path from / or ~/, never stepping up with "..". */
function writeTargetProblem(target: string): string | undefined {
  if (UNSAFE_CHARACTERS.test(target)) return 'write: paths cannot contain control characters';
  if (target !== '~' && !target.startsWith('~/') && !target.startsWith('/')) {
    return 'write: give a folder or .md file starting with ~/ or /, e.g. ~/Documents/Meeting notes';
  }
  if (target.split('/').includes('..')) return 'write: a path cannot step up a folder with ..';
  return undefined;
}

function parseAction(line: string, name: string, number: number): AutomationAction {
  const match = /^[-*]\s*(extract|write|shell|webhook)\s*:\s*(.+)$/iu.exec(line);
  if (!match) throw new Error(`"${name}" line ${number} is not an action. Use extract:, write:, shell: or webhook:`);
  const kind = match[1]!.toLowerCase() as AutomationAction['kind'];
  const value = match[2]!.trim();
  if (kind === 'write') {
    const problem = writeTargetProblem(value);
    if (problem) throw new Error(`"${name}": ${problem}`);
  }
  if (kind === 'webhook') {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`"${name}": ${value} is not a web address`); }
    const problem = webhookAddressProblem(url);
    if (problem) throw new Error(`"${name}": ${problem}`);
    return { kind, url: url.toString() };
  }
  return kind === 'extract' ? { kind, extractor: value } : kind === 'write' ? { kind, target: value } : { kind, command: value };
}

export function parseAutomation(text: string, path: string): Automation {
  const { fields, body } = parseFrontmatter(text);
  const name = typeof fields.name === 'string' && fields.name.trim() ? fields.name.trim() : basename(path, '.md');
  const when = typeof fields.when === 'string' ? fields.when.trim().toLowerCase().replace(/[-_]/gu, ' ') : 'meeting ready';
  if (when !== 'meeting ready') throw new Error(`"${name}": the only trigger so far is "when: meeting ready"`);
  if (fields.enabled !== undefined && fields.enabled !== 'true' && fields.enabled !== 'false') {
    throw new Error(`"${name}": enabled must be true or false`);
  }
  const by = fields['made-by'] === 'agent' ? { by: 'agent' as const } : {};
  const actions = meaningful(body).split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line)
    .map(({ line, number }) => parseAction(line, name, number));
  if (!actions.length) throw new Error(`"${name}" has no actions`);
  return {
    name,
    enabled: fields.enabled !== 'false',
    ...by,
    filters: { title: list(fields.title), attendee: list(fields.attendee), app: list(fields.app), calendar: list(fields.calendar) },
    actions,
    path,
    hash: createHash('sha256').update(text).digest('hex'),
  };
}

export function loadAutomations(libraryDir: string, env: NodeJS.ProcessEnv = process.env): {
  automations: Automation[];
  problems: { path: string; message: string }[];
} {
  const directory = automationsDirectory(libraryDir, env);
  const automations: Automation[] = [];
  const problems: { path: string; message: string }[] = [];
  if (!existsSync(directory)) return { automations, problems };
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.md') && !name.startsWith('.')).sort()) {
    const path = join(directory, file);
    try { automations.push(parseAutomation(readFileSync(path, 'utf8'), path)); }
    catch (error) { problems.push({ path, message: error instanceof Error ? error.message : String(error) }); }
  }
  return { automations, problems };
}

export function findAutomation(automations: readonly Automation[], name: string): Automation | undefined {
  const wanted = name.trim().toLocaleLowerCase('en-US');
  return automations.find((automation) => automation.name.toLocaleLowerCase('en-US') === wanted
    || basename(automation.path, '.md').toLocaleLowerCase('en-US') === wanted);
}

export interface AutomationDefinition {
  name: string;
  enabled?: boolean;
  /** An agent's automation is saved off, and says so, until the owner turns it on in the file. */
  by?: 'agent';
  filters?: Partial<AutomationFilters>;
  actions: AutomationAction[];
}

const MADE_BY_AGENT = '<!-- An agent made or changed this automation, so it is off. Read the actions below, then change "enabled: false" to "enabled: true" to turn it on. -->';

const yamlList = (values: string[]) => `[${values.map((value) => /[,[\]]/u.test(value) ? JSON.stringify(value) : value).join(', ')}]`;

export function serializeAutomation(definition: AutomationDefinition): string {
  const oneLine = (value: string) => value.replace(/\s+/gu, ' ').trim();
  const filters = (['title', 'attendee', 'app', 'calendar'] as const)
    .flatMap((key) => definition.filters?.[key]?.length ? [`${key}: ${yamlList(definition.filters[key]!.map(oneLine))}`] : []);
  const actions = definition.actions.map((action) => `- ${action.kind}: ${oneLine(
    action.kind === 'extract' ? action.extractor : action.kind === 'write' ? action.target : action.kind === 'shell' ? action.command : action.url)}`);
  const agent = definition.by === 'agent';
  return ['---', `name: ${oneLine(definition.name)}`, 'when: meeting ready', ...filters,
    ...(definition.enabled === false || agent ? ['enabled: false'] : []), ...(agent ? ['made-by: agent'] : []), '---',
    ...(agent ? [MADE_BY_AGENT] : []), ...actions, ''].join('\n');
}

function writeAutomationFile(path: string, definition: AutomationDefinition): Automation {
  const text = serializeAutomation(definition);
  const parsed = parseAutomation(text, path);
  writeFileSync(path, text, { mode: 0o600 });
  return parsed;
}

export function createAutomation(libraryDir: string, definition: AutomationDefinition, env: NodeJS.ProcessEnv = process.env): Automation {
  const directory = ensureAutomationsDirectory(libraryDir, env);
  if (findAutomation(loadAutomations(libraryDir, env).automations, definition.name)) {
    throw new Error(`An automation named "${definition.name}" already exists. Update it instead.`);
  }
  const path = join(directory, `${insightFileName(definition.name)}.md`);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  return writeAutomationFile(path, definition);
}

export function updateAutomation(
  libraryDir: string, name: string, changes: Partial<AutomationDefinition>, env: NodeJS.ProcessEnv = process.env,
): Automation {
  const current = findAutomation(loadAutomations(libraryDir, env).automations, name);
  if (!current) throw new Error(`No automation named "${name}" in ${automationsDirectory(libraryDir, env)}`);
  return writeAutomationFile(current.path, {
    name: changes.name ?? current.name,
    enabled: changes.enabled ?? current.enabled,
    ...(changes.by ?? current.by ? { by: 'agent' as const } : {}),
    filters: { ...current.filters, ...changes.filters },
    actions: changes.actions ?? current.actions,
  });
}

export function deleteAutomation(libraryDir: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  const current = findAutomation(loadAutomations(libraryDir, env).automations, name);
  if (!current) throw new Error(`No automation named "${name}" in ${automationsDirectory(libraryDir, env)}`);
  rmSync(current.path);
  return current.path;
}

/** Every filter given must match; within one, any word does. */
export function automationMatches(automation: Automation, meeting: MeetingArtifact | undefined, record: TranscriptRecord, app?: string): boolean {
  const { title, attendee, app: apps, calendar } = automation.filters;
  const lower = (value: string) => value.toLocaleLowerCase('en-US');
  const titles = [meeting?.title, meeting?.calendar?.title, record.title];
  const people = [...(meeting?.attendees ?? []), ...(meeting?.calendar?.attendees ?? [])]
    .flatMap((person) => [person.name, person.email ?? ''])
    .concat(record.speakers.map((speaker) => speaker.label)).map(lower);
  const appName = lower(app ?? meeting?.app ?? '');
  const calendarName = lower(meeting?.calendar?.calendar ?? '');
  return (!title.length || title.some((phrase) => titles.some((candidate) => phraseMatches(candidate, phrase))))
    && (!attendee.length || attendee.some((word) => people.some((person) => person.includes(lower(word)))))
    && (!apps.length || apps.some((word) => appName !== '' && appName.includes(lower(word))))
    && (!calendar.length || calendar.some((word) => calendarName !== '' && calendarName.includes(lower(word))));
}

/** Approvals live beside Seashell's settings, outside the folder agents can edit. */
export function automationApprovalsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultConfigPath(env)), 'automation-approvals.json');
}

type Decision = 'allow' | 'deny';

interface StoredApproval { name: string; decision: Decision; at: string; signature?: string }

function readApprovals(env: NodeJS.ProcessEnv): Record<string, StoredApproval> {
  try {
    const value = JSON.parse(readFileSync(automationApprovalsPath(env), 'utf8'));
    return value?.schemaVersion === 2 && value.approvals && typeof value.approvals === 'object' ? value.approvals : {};
  } catch { return {}; }
}

/** All a command gets of Seashell's own environment: where programs are, home, language and scratch space. */
export function shellEnvironment(env: NodeJS.ProcessEnv = process.env): { PATH: string; HOME: string; LANG: string; TMPDIR: string } {
  return {
    PATH: env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', HOME: env.HOME || homedir(),
    LANG: env.LANG || 'en_US.UTF-8', TMPDIR: env.TMPDIR || tmpdir(),
  };
}

/** The program a command starts, as the shell would find it, or undefined when it can't be told before running. */
export function commandProgram(command: string, cwd?: string, path = shellEnvironment().PATH): string | undefined {
  let rest = command.trimStart();
  for (;;) {
    let word = '';
    let index = 0;
    for (; index < rest.length && !/[\s;&|<>()]/u.test(rest[index]!); index++) {
      const character = rest[index]!;
      if (character === '$' || character === '`') return undefined; // Expanded only when it runs.
      if (character === '\\') { word += rest[++index] ?? ''; continue; }
      if (character === "'" || character === '"') {
        const end = rest.indexOf(character, index + 1);
        if (end < 0) return undefined;
        const quoted = rest.slice(index + 1, end);
        if (character === '"' && /[$`\\]/u.test(quoted)) return undefined;
        word += quoted;
        index = end;
        continue;
      }
      word += character;
    }
    // NAME=value before a command sets its environment; the program is the word after.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(rest.slice(0, index)) && index < rest.length && /\s/u.test(rest[index]!)) {
      rest = rest.slice(index).trimStart();
      continue;
    }
    if (!word) return undefined;
    const expanded = word === '~' ? homedir() : word.startsWith('~/') ? join(homedir(), word.slice(2)) : word;
    const candidates = expanded.includes('/') ? isAbsolute(expanded) ? [expanded] : cwd ? [join(cwd, expanded)] : []
      : path.split(':').filter(Boolean).map((folder) => join(folder, expanded));
    for (const candidate of candidates) {
      try {
        const real = realpathSync(candidate);
        if (lstatSync(real).isFile()) return real;
      } catch { /* Not this one. */ }
    }
    return undefined;
  }
}

/** Files macOS seals with the system: an update changes them, never another program. */
const SYSTEM_FILES = /^\/(?:System|bin|sbin|usr\/(?!local\/)[^/]+)\//u;

/**
 * What an approval covers: this version of the automation's file and, for each
 * command whose program is a file, that file's contents as they are now. An
 * edited script asks again, as an edited automation does.
 */
function approvalId(automation: Automation, cwd?: string): string {
  const programs = automation.actions.flatMap((action) => {
    const program = action.kind === 'shell' ? commandProgram(action.command, cwd) : undefined;
    if (!program || SYSTEM_FILES.test(program)) return [];
    try { return [[program, sha256(readFileSync(program))]]; } catch { return [[program, 'unreadable']]; }
  });
  return sha256(JSON.stringify({ file: automation.hash, programs }));
}

/** The owner's answer for this version, if one was given here: a stored answer without Seashell's signature counts for nothing. */
export function automationDecision(automation: Automation, env: NodeJS.ProcessEnv = process.env, cwd?: string): Decision | undefined {
  const id = approvalId(automation, cwd);
  const stored = readApprovals(env)[id];
  if (!stored || (stored.decision !== 'allow' && stored.decision !== 'deny')) return undefined;
  return validApproval(approvalKey(automationApprovalsPath(env), env).key, id, stored.decision, stored.signature) ? stored.decision : undefined;
}

export function rememberAutomationDecision(automation: Automation, decision: Decision, env: NodeJS.ProcessEnv = process.env, cwd?: string): void {
  const path = automationApprovalsPath(env);
  const id = approvalId(automation, cwd);
  const signature = signApproval(approvalKey(path, env).key, id, decision);
  const approvals = { ...readApprovals(env), [id]: { name: automation.name, decision, at: new Date().toISOString(), signature } };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 2, approvals }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Said when the signing key had to go in a file because the Keychain was not there. */
export function automationApprovalNote(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return approvalKey(automationApprovalsPath(env), env).note;
}

/** What the owner is asked to allow: everything this automation would send outside. */
export interface AutomationApprovalRequest {
  automation: string;
  meeting: string;
  actions: string[];
}

export type AutomationAsk = (request: AutomationApprovalRequest, signal?: AbortSignal) => Promise<Decision | undefined>;

/** Whether `path` is `folder` or inside it. */
function inside(path: string, folder: string): boolean {
  const between = relative(folder, path);
  return between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between));
}

/** The path with every link in the part that exists resolved, so a linked folder counts where it really is. */
function realPath(path: string): string {
  const missing: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try { return join(realpathSync(current), ...missing.reverse()); } catch { /* Not there yet: try its folder. */ }
    if (dirname(current) === current) return resolve(path);
    missing.push(basename(current));
  }
}

/**
 * The Sea Shell folder, which holds the library, Automations, Prompts and the
 * rest: notes saved anywhere in it need no asking. A library kept straight in
 * the home folder must not make all of it count, so then only the library does.
 */
function seashellFolder(libraryDir: string): string {
  const library = resolve(libraryDir);
  const parent = dirname(library);
  return parent === library || inside(resolve(homedir()), parent) ? library : parent;
}

/** A write: target outside the Sea Shell folder sends the meeting out, so it asks first. */
function writesOutside(target: string, libraryDir: string): boolean {
  // A filled {title}, {date} or {id} is one plain name, so a stand-in decides the folder as well as the real one would.
  const sample = writeTargetPath(target, { id: 'meeting', createdAt: '2000-01-01' }, 'Meeting');
  return !inside(realPath(sample), realPath(seashellFolder(libraryDir)));
}

/** What the owner is asked to allow for an action, or undefined when it needs no asking. */
function approvalLabel(action: AutomationAction, libraryDir: string, cwd?: string): string | undefined {
  if (action.kind === 'shell') {
    const program = commandProgram(action.command, cwd);
    return `Run: ${action.command}${program ? ` (runs ${program})` : ''}`;
  }
  if (action.kind === 'webhook') return `Send to: ${action.url}`;
  return action.kind === 'write' && writesOutside(action.target, libraryDir) ? `Save to: ${action.target}` : undefined;
}

/** Whether any of its actions waits for the owner's yes. */
export function automationNeedsApproval(automation: Automation, libraryDir: string): boolean {
  return automation.actions.some((action) => approvalLabel(action, libraryDir) !== undefined);
}

/** The meeting as automations see it: notes, insights and transcript, every point cited. */
export function automationPayload(directory: string, artifact: MeetingArtifact | undefined, record: TranscriptRecord) {
  const claims = artifact?.analysis?.claims ?? artifact?.provisionalClaims ?? [];
  return {
    schemaVersion: 1,
    id: record.id,
    title: artifact?.title ?? record.title,
    startedAt: record.createdAt,
    ...(record.source.duration === undefined ? {} : { durationSeconds: Math.round(record.source.duration) }),
    ...(artifact?.app ? { app: artifact.app } : {}),
    directory,
    ...(artifact?.calendar ? { calendar: artifact.calendar } : {}),
    attendees: artifact?.attendees ?? [],
    notes: {
      status: artifact?.analysis?.final ? 'final' : artifact?.analysis ? 'draft' : claims.length ? 'live-draft' : 'none',
      ...(artifact?.analysis?.summary ? { summary: artifact.analysis.summary } : {}),
      ...(artifact?.notesOutdated ? { possiblyOutOfDate: artifact.notesOutdated.reason } : {}),
      items: claims.map((claim) => ({ type: claim.type, text: claim.text, ...(claim.person ? { person: claim.person } : {}),
        ...(claim.due ? { due: claim.due } : {}), evidenceSegmentIds: claim.evidenceSegmentIds })),
      ...(artifact?.analysis?.notes ? { template: artifact.analysis.template ?? null, sections: artifact.analysis.notes } : {}),
    },
    insights: artifact?.insights ?? [],
    transcript: record.transcript.map((segment, index) => ({
      id: transcriptSegmentId(record, index), start: segment.start, end: segment.end,
      speaker: speakerLabel(record, segment.speaker) ?? segment.speaker ?? 'Unknown', text: segment.text,
    })),
  };
}

/** The notes as a Markdown file, the way the Notes view lays them out, then the transcript. */
export function meetingMarkdown(artifact: MeetingArtifact | undefined, record: TranscriptRecord): string {
  const day = record.createdAt.slice(0, 10);
  const notes = artifact?.analysis
    ? meetingViewLines(artifact, 'notes', record).map((line) => line.startsWith(SUBHEADING) ? `### ${line.slice(SUBHEADING.length)}`
      : line.startsWith(HEADING) ? `## ${line.slice(HEADING.length)}` : plainMeetingLines([line])[0]!)
      .filter((line) => !/Press g\b/u.test(line))
    : ['No AI notes for this meeting.'];
  return [`# ${artifact?.title ?? record.title}`, '', `_${day}_`, '', ...notes, '', '## Transcript', '',
    renderText(record, { timestamps: true, speakers: true }), ''].join('\n');
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * A folder gets "2026-11-10 Weekly sync.md"; a .md path may use {date}, {title} and {id}.
 * The title comes from the calendar, so it is reduced to letters, numbers and
 * spaces: it can never name another folder, step up one, or hide characters.
 */
export function writeTargetPath(target: string, record: Pick<TranscriptRecord, 'id' | 'createdAt'>, title: string): string {
  const problem = writeTargetProblem(target.trim());
  if (problem) throw new Error(problem);
  const name = Array.from(title.normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()).slice(0, 100).join('').trim() || 'Meeting';
  const day = /^\d{4}-\d{2}-\d{2}/u.exec(record.createdAt)?.[0] ?? 'undated';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(record.id)) throw new Error('The meeting ID cannot be part of a path');
  const filled = expandHome(target.trim()).replaceAll('{date}', day).replaceAll('{title}', name).replaceAll('{id}', record.id);
  const path = filled.toLowerCase().endsWith('.md') ? filled : join(filled, `${day} ${name}.md`);
  if (path.split(sep).includes('..') || UNSAFE_CHARACTERS.test(path)) throw new Error('write: that path is not safe to fill in');
  return resolve(path);
}

interface WrittenFile { meetingId: string; sha256: string; at: string }

/** The files automations wrote, so Seashell replaces only its own, and only unchanged. */
export function automationFilesPath(libraryDir: string): string {
  return join(libraryDir, 'automation-files.json');
}

function readWrittenFiles(libraryDir: string): Record<string, WrittenFile> {
  try {
    const value = JSON.parse(readFileSync(automationFilesPath(libraryDir), 'utf8'));
    return value && typeof value.files === 'object' && !Array.isArray(value.files) ? value.files : {};
  } catch { return {}; }
}

function rememberWrittenFile(libraryDir: string, path: string, meetingId: string, contents: string): void {
  // Files since removed by hand are dropped, so the list stays as long as what is there.
  const files = Object.fromEntries(Object.entries(readWrittenFiles(libraryDir)).filter(([file]) => existsSync(file)));
  files[path] = { meetingId, sha256: sha256(contents), at: new Date().toISOString() };
  const manifest = automationFilesPath(libraryDir);
  const temporary = `${manifest}.${process.pid}.tmp`;
  mkdirSync(libraryDir, { recursive: true, mode: 0o700 });
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, manifest);
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Write a new file, failing rather than following a link or replacing anything already there. */
function writeNewFile(path: string, contents: string): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(descriptor, contents); }
  catch (error) { rmSync(path, { force: true }); throw error; }
  finally { closeSync(descriptor); }
}

/**
 * Save the notes for one meeting at `file`, or beside it as "name (2).md" when
 * something else is there. Seashell replaces a file only when it wrote it, for
 * this meeting, and nobody has changed it since; it never writes through a link.
 */
export function saveNotesFile(libraryDir: string, file: string, contents: string, meetingId: string): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const written = readWrittenFiles(libraryDir);
  const stem = file.slice(0, -'.md'.length);
  for (let copy = 1; copy <= 100; copy++) {
    const candidate = copy === 1 ? file : `${stem} (${copy}).md`;
    const key = realPath(candidate);
    let found: ReturnType<typeof lstatSync> | undefined;
    try { found = lstatSync(candidate); } catch { found = undefined; }
    if (!found) {
      try { writeNewFile(candidate, contents); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      rememberWrittenFile(libraryDir, key, meetingId, contents);
      return candidate;
    }
    const ours = written[key];
    if (!found.isFile() || ours?.meetingId !== meetingId || ours.sha256 !== sha256(readFileSync(candidate))) continue;
    // Replace by renaming a new file over it: a link put there since is replaced, never followed.
    const temporary = join(dirname(candidate), `.${basename(candidate)}.${process.pid}.tmp`);
    rmSync(temporary, { force: true });
    writeNewFile(temporary, contents);
    renameSync(temporary, candidate);
    rememberWrittenFile(libraryDir, key, meetingId, contents);
    return candidate;
  }
  throw new Error(`${file} and 99 files beside it already exist`);
}

export interface ShellResult { code: number | null; detail?: string }

/** Run one command with the meeting's JSON on stdin and a minimal environment, bounded in time. Output is not kept. */
export function runShellAction(command: string, payload: string, env: Record<string, string>, cwd: string): Promise<ShellResult> {
  return new Promise((resolvePromise) => {
    // Nothing Seashell was started with beyond the basics: no tokens or keys from its own environment.
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...shellEnvironment(), ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, SHELL_TIMEOUT_MS);
    child.stderr?.on('data', (data) => { stderr = (stderr + String(data)).slice(-2_000); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(payload);
    child.once('error', (error) => { clearTimeout(timer); resolvePromise({ code: null, detail: error.message }); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const line = stderr.trim().split('\n').at(-1)?.slice(0, 200);
      resolvePromise({ code, ...(code === 0 ? {} : { detail: signal ? `stopped (${signal})` : line || `exit ${code}` }) });
    });
  });
}

export interface AutomationActionResult {
  kind: AutomationAction['kind'];
  target: string;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
}

export interface AutomationRun {
  at: string;
  automation: string;
  hash: string;
  meetingId: string;
  trigger: 'meeting-ready' | 'manual';
  status: 'ok' | 'failed' | 'skipped';
  actions: AutomationActionResult[];
  detail?: string;
}

/** Who a web address belongs to, in the automation's own words: "Post to the CRM" posts to "The CRM". */
function webhookName(automation: string, url: string): string {
  const named = /^(?:post|send|push)(?:\s+\w+)?\s+to\s+(.+)$/iu.exec(automation.trim())?.[1];
  if (named) return named.charAt(0).toUpperCase() + named.slice(1);
  try { return `The server at ${new URL(url).hostname}`; } catch { return 'The server'; }
}

/**
 * Why a run failed, in plain words, and whether trying again could help: a server that did not
 * answer may next time, while one that refused it, or a broken command, needs its file fixed.
 */
export function runFailure(run: AutomationRun): { text: string; retry: boolean } | undefined {
  if (run.status !== 'failed') return undefined;
  const failed = run.actions.find((action) => action.status === 'failed');
  const detail = run.detail ?? failed?.detail ?? 'It failed.';
  if (failed?.kind !== 'webhook') return { text: detail, retry: false };
  const who = webhookName(run.automation, failed.target);
  const refused = /refused it \((\d+)\)/u.exec(detail);
  return refused ? { text: `${who} refused it (${refused[1]}).`, retry: false } : { text: `${who} didn't answer.`, retry: true };
}

export function automationRunsPath(libraryDir: string): string {
  return join(libraryDir, 'automation-runs.jsonl');
}

export function readAutomationRuns(libraryDir: string): AutomationRun[] {
  try {
    return readFileSync(automationRunsPath(libraryDir), 'utf8').split('\n').flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line) as AutomationRun] : []; } catch { return []; }
    });
  } catch { return []; }
}

function logRun(libraryDir: string, run: AutomationRun): void {
  mkdirSync(libraryDir, { recursive: true, mode: 0o700 });
  appendFileSync(automationRunsPath(libraryDir), `${JSON.stringify(run)}\n`, { mode: 0o600 });
}

export interface RunAutomationsOptions {
  trigger?: 'meeting-ready' | 'manual';
  /** A manual run of one automation by name: it runs whatever its filters say. */
  only?: string;
  /** The app the call ran in, from the background recorder. */
  app?: string;
  /** Ask the owner before anything leaves Seashell. Without it, those actions wait. */
  ask?: AutomationAsk;
  signal?: AbortSignal;
  /** For extract actions: the final-notes route. */
  route?: HumainMeetingRoute;
  runner?: typeof runHumainMeeting;
  /** Posts webhooks; postWebhook() unless a test stands in. */
  fetch?: typeof fetch;
  shell?: typeof runShellAction;
  env?: NodeJS.ProcessEnv;
  onStatus?: (message: string) => void;
}

/**
 * Run the automations that fit a ready meeting. A meeting-ready run happens
 * once per automation and meeting, so notes written again do not post twice.
 */
export async function runAutomations(libraryDir: string, transcriptId: string, options: RunAutomationsOptions = {}): Promise<AutomationRun[]> {
  const trigger = options.trigger ?? 'meeting-ready';
  const env = options.env ?? process.env;
  const { path, record } = findTranscriptRecord(libraryDir, transcriptId);
  const directory = dirname(path);
  let artifact = loadMeetingArtifact(libraryDir, record.id);
  const { automations } = loadAutomations(libraryDir, env);
  const chosen = options.only
    ? [findAutomation(automations, options.only) ?? (() => {
      throw new Error(`No automation named "${options.only}" in ${automationsDirectory(libraryDir, env)}`);
    })()]
    : automations.filter((automation) => automation.enabled && automationMatches(automation, artifact, record, options.app));
  if (!chosen.length) return [];
  const runs: AutomationRun[] = [];
  const now = () => new Date().toISOString();
  if (artifact?.ai?.off) {
    for (const automation of chosen) {
      const run: AutomationRun = { at: now(), automation: automation.name, hash: automation.hash, meetingId: record.id,
        trigger, status: 'skipped', actions: [], detail: 'This meeting is private.' };
      logRun(libraryDir, run); runs.push(run);
    }
    return runs;
  }
  const done = trigger === 'meeting-ready'
    ? new Set(readAutomationRuns(libraryDir).filter((run) => run.meetingId === record.id && run.trigger === 'meeting-ready' && run.status !== 'skipped')
      .map((run) => run.automation))
    : new Set<string>();
  for (const automation of chosen) {
    if (done.has(automation.name)) continue;
    options.onStatus?.(`Automation: ${automation.name}…`);
    const results: AutomationActionResult[] = [];
    const outward = automation.actions.flatMap((action) => approvalLabel(action, libraryDir, directory) ?? []);
    let decision = outward.length ? automationDecision(automation, env, directory) : 'allow';
    let asked = false;
    for (const action of automation.actions) {
      const target = action.kind === 'extract' ? action.extractor : action.kind === 'write' ? action.target
        : action.kind === 'shell' ? action.command : action.url;
      const result = (status: AutomationActionResult['status'], detail?: string) =>
        results.push({ kind: action.kind, target, status, ...(detail ? { detail } : {}) });
      try {
        if (action.kind === 'extract') {
          if (!options.route) { result('failed', 'No AI is set up for final notes. Choose one with seashell ai setup.'); continue; }
          await runExtractor(libraryDir, record.id, action.extractor,
            { route: options.route, runner: options.runner, onStatus: options.onStatus, env });
          artifact = loadMeetingArtifact(libraryDir, record.id);
          result('ok');
          continue;
        }
        // Anything that leaves Seashell waits for the owner's yes, once per version of this file.
        if (approvalLabel(action, libraryDir) !== undefined) {
          if (decision === undefined && !asked && options.ask) {
            asked = true;
            decision = await options.ask({ automation: automation.name, meeting: artifact?.title ?? record.title, actions: outward }, options.signal);
            if (decision) {
              rememberAutomationDecision(automation, decision, env, directory);
              const note = automationApprovalNote(env);
              if (note) options.onStatus?.(note);
            }
          }
          if (decision === 'deny') { result('skipped', 'You chose not to allow this automation to send meetings outside Seashell.'); continue; }
          if (decision !== 'allow') {
            result('skipped', `Waiting for your approval. To be asked now: seashell automations run ${record.id} "${automation.name}"`);
            continue;
          }
        }
        if (action.kind === 'write') {
          const file = writeTargetPath(action.target, record, artifact?.title ?? record.title);
          result('ok', saveNotesFile(libraryDir, file, meetingMarkdown(artifact, record), record.id));
          continue;
        }
        const payload = JSON.stringify(automationPayload(directory, artifact, record));
        if (action.kind === 'shell') {
          const outcome = await (options.shell ?? runShellAction)(action.command, payload,
            { SEASHELL_MEETING_ID: record.id, SEASHELL_MEETING_DIR: directory }, directory);
          result(outcome.code === 0 ? 'ok' : 'failed', outcome.detail);
        } else {
          // Only to the address in the file: a redirect is an answer, never followed.
          const response = await (options.fetch ?? postWebhook())(action.url, {
            method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Seashell' }, body: payload,
            redirect: 'error', signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          });
          // In words, with the code for whoever runs the server: never just "HTTP 502".
          result(response.ok ? 'ok' : 'failed', response.ok ? `sent (${response.status})`
            : response.status >= 500 ? `the server failed (${response.status})`
            : response.status >= 300 && response.status < 400 ? `the server refused it (${response.status}): it asked for the meeting to go to another address, and Seashell never follows that`
            : `the server refused it (${response.status})`);
        }
      } catch (error) {
        result('failed', (error instanceof Error ? error.message : String(error)).slice(0, 300));
      }
    }
    const run: AutomationRun = {
      at: now(), automation: automation.name, hash: automation.hash, meetingId: record.id, trigger,
      status: results.some((item) => item.status === 'failed') ? 'failed'
        : results.every((item) => item.status === 'skipped') ? 'skipped' : 'ok',
      actions: results,
    };
    logRun(libraryDir, run);
    runs.push(run);
  }
  return runs;
}

/**
 * Everything that happens once a meeting is ready: remember which app it ran
 * in, run the extractors that fit it (after final notes), then automations.
 * Each step reports its own failures; none of them touches the transcript.
 */
export async function afterMeetingReady(
  libraryDir: string,
  transcriptId: string,
  options: Omit<RunAutomationsOptions, 'trigger' | 'only'> = {},
): Promise<{ extracted: string[]; extractorFailures: { extractor: string; message: string }[]; automations: AutomationRun[] }> {
  if (options.app) {
    try {
      const artifact = loadMeetingArtifact(libraryDir, transcriptId);
      if (artifact && !artifact.app) saveMeetingArtifact(libraryDir, { ...artifact, app: options.app });
    } catch (error) {
      options.onStatus?.(`Could not note the meeting's app: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const extracted = options.route
    ? await runAutomaticExtractors(libraryDir, transcriptId, { route: options.route, runner: options.runner, app: options.app, env: options.env, onStatus: options.onStatus })
    : { ran: [], failed: [] };
  const automations = await runAutomations(libraryDir, transcriptId, { ...options, trigger: 'meeting-ready' });
  return { extracted: extracted.ran.map((insight) => insight.extractor), extractorFailures: extracted.failed, automations };
}

/**
 * The login agent has no window, so it asks with a dialog, naming the
 * automation, the meeting, and exactly what would run or where it would go.
 */
export async function askAutomationApprovalWithDialog(request: AutomationApprovalRequest, signal?: AbortSignal): Promise<Decision | undefined> {
  const question = `The automation “${request.automation}” wants to send “${request.meeting}” outside Seashell:\n\n${request.actions.join('\n')}\n\nAllow it? Seashell asks again if the automation changes.`;
  const child = Bun.spawn(['osascript',
    '-e', 'on run argv',
    '-e', 'set answer to display dialog (item 1 of argv) with title "Seashell" buttons {"Don’t allow", "Allow"} default button "Don’t allow" giving up after 120 with icon caution',
    '-e', 'if gave up of answer then return ""',
    '-e', 'return button returned of answer',
    '-e', 'end run', question], { stdout: 'pipe', stderr: 'ignore' });
  const stop = () => child.kill();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const answer = (await new Response(child.stdout).text()).trim();
    await child.exited;
    return answer === 'Allow' ? 'allow' : answer ? 'deny' : undefined;
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}
