import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Note templates and the owner's standing instructions, as plain Markdown files
 * the user edits in ~/Documents/Sea Shell/Templates:
 *
 *   ---
 *   name: Customer call
 *   description: Discovery, demo or kickoff with someone outside the team.
 *   match: [discovery, demo, kickoff]
 *   ---
 *   ## Goals and pain points
 *   What they are trying to achieve, and what is hard today.
 *
 * Each heading becomes a section of the final notes and the text under it is
 * that section's guidance. `match` words pick the template from the calendar
 * title; `default: true` marks the fallback. "About me.md" in the same folder
 * is the profile every meeting's AI reads: who you are and how you like notes.
 */

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILT_IN_TEMPLATES_DIR = join(PROJECT_ROOT, 'templates');
export const PROFILE_FILE = 'About me.md';

export interface MeetingTemplate {
  name: string;
  description?: string;
  match: string[];
  default: boolean;
  /** The Markdown after the frontmatter: headings in order, with guidance under each. */
  body: string;
  path: string;
}

export interface MeetingInstructions {
  profile?: string;
  template?: { name: string; body: string };
  note?: string;
}

const PROFILE_STARTER = `<!--
Sea Shell's meeting AI reads this before writing any notes. Write who you are
and how you like notes, then delete this comment. For example:

I run a two-person design studio. My clients are early-stage founders.
Write notes in short, plain bullets. Use first names. Skip small talk.
Always capture prices, dates and anything I promised to send.
-->
`;

export function templatesDirectory(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.SEASHELL_TEMPLATES_DIR || join(dirname(libraryDir), 'Templates');
}

export type FrontmatterValue = string | string[] | Record<string, string | string[]>;

/**
 * A small, strict subset of YAML: `key: value`, `key: [a, b]`, and a key with
 * nothing after it followed by indented `name: value` lines, kept in order:
 *
 *   fields:
 *     pains: What is hard for them today
 */
export function parseFrontmatter(text: string): { fields: Record<string, FrontmatterValue>; body: string } {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/u.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, FrontmatterValue> = {};
  let nested: Record<string, string | string[]> | undefined;
  for (const line of (match[1] ?? '').split(/\r?\n/u)) {
    const pair = /^([\p{L}\p{N}][\p{L}\p{N}_ -]*?):\s*(.*)$/u.exec(line.trim());
    if (!pair) continue;
    const [, key, raw] = pair as unknown as [string, string, string];
    const value = frontmatterValue(raw);
    if (/^\s/u.test(line) && nested) { nested[key] = value; continue; }
    if (!/^[A-Za-z][\w-]*$/u.test(key)) continue;
    nested = raw.trim() ? undefined : {};
    fields[key] = nested ?? value;
  }
  return { fields, body: text.slice(match[0].length) };
}

function frontmatterValue(raw: string): string | string[] {
  const list = /^\[(.*)\]$/u.exec(raw.trim());
  return list
    ? list[1]!.split(',').map((item) => unquote(item.trim())).filter(Boolean)
    : unquote(raw.trim());
}

function unquote(value: string): string {
  return /^(['"]).*\1$/u.test(value) ? value.slice(1, -1) : value;
}

/** Comments are notes to the person editing the file, not instructions. */
export function meaningful(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/gu, '').trim();
}

export function parseMeetingTemplate(text: string, path: string): MeetingTemplate | undefined {
  const { fields, body } = parseFrontmatter(text);
  const content = meaningful(body);
  if (!content) return undefined;
  const name = typeof fields.name === 'string' && fields.name.trim()
    ? fields.name.trim()
    : basename(path, '.md');
  const match = Array.isArray(fields.match) ? fields.match : typeof fields.match === 'string' && fields.match ? [fields.match] : [];
  return {
    name,
    ...(typeof fields.description === 'string' && fields.description ? { description: fields.description } : {}),
    match,
    default: fields.default === 'true',
    body: content,
    path,
  };
}

/**
 * The user's folder, seeded with the built-in templates and a profile starter
 * when they first ask for it (`seashell templates`). Seeding never overwrites:
 * an edited or deleted template stays the user's choice. Until the folder
 * exists, meetings use the built-in templates as they ship.
 */
export function ensureTemplatesDirectory(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const directory = templatesDirectory(libraryDir, env);
  if (existsSync(directory)) return directory;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of readdirSync(BUILT_IN_TEMPLATES_DIR).filter((name) => name.endsWith('.md'))) {
    copyFileSync(join(BUILT_IN_TEMPLATES_DIR, file), join(directory, file));
  }
  writeFileSync(join(directory, PROFILE_FILE), PROFILE_STARTER, { mode: 0o600 });
  return directory;
}

export function loadMeetingTemplates(libraryDir: string, env: NodeJS.ProcessEnv = process.env): MeetingTemplate[] {
  const user = templatesDirectory(libraryDir, env);
  const directory = existsSync(user) ? user : BUILT_IN_TEMPLATES_DIR;
  return readdirSync(directory)
    .filter((file) => file.endsWith('.md') && file !== PROFILE_FILE && !file.startsWith('.'))
    .sort()
    .flatMap((file) => {
      const path = join(directory, file);
      const template = parseMeetingTemplate(readFileSync(path, 'utf8'), path);
      return template ? [template] : [];
    });
}

/** The profile file as written, comments included; the starter when there is none yet. */
export function readProfileFile(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = join(templatesDirectory(libraryDir, env), PROFILE_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8') : PROFILE_STARTER;
}

export function writeProfile(libraryDir: string, text: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = join(ensureTemplatesDirectory(libraryDir, env), PROFILE_FILE);
  writeFileSync(path, text.endsWith('\n') || !text ? text : `${text}\n`, { mode: 0o600 });
  return path;
}

/**
 * Write a template, replacing the one with this name or adding a new file.
 * The folder is seeded first, so the built-in templates stay alongside it.
 */
export function writeMeetingTemplate(
  libraryDir: string,
  template: { name: string; body: string; description?: string; match?: string[]; default?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): MeetingTemplate {
  const directory = ensureTemplatesDirectory(libraryDir, env);
  const name = template.name.replace(/\s+/gu, ' ').trim();
  if (!name || name.toLocaleLowerCase('en-US') === basename(PROFILE_FILE, '.md').toLocaleLowerCase('en-US')) {
    throw new Error('Give the template a name other than "About me"');
  }
  const existing = findMeetingTemplate(loadMeetingTemplates(libraryDir, env), name);
  const slug = name.normalize('NFKD').replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/gu, '').toLowerCase() || 'template';
  const path = existing?.path ?? join(directory, `${slug}.md`);
  const oneLine = (value: string) => value.replace(/\s+/gu, ' ').trim();
  const match = template.match ?? existing?.match ?? [];
  const description = template.description ?? existing?.description;
  const text = ['---', `name: ${oneLine(name)}`,
    ...(description ? [`description: ${oneLine(description)}`] : []),
    ...(match.length ? [`match: [${match.map(oneLine).join(', ')}]`] : []),
    ...((template.default ?? existing?.default) ? ['default: true'] : []),
    '---', template.body.trim(), ''].join('\n');
  const parsed = parseMeetingTemplate(text, path);
  if (!parsed) throw new Error('The template body is empty. Write one ## heading per section of the notes.');
  writeFileSync(path, text, { mode: 0o600 });
  return parsed;
}

export function loadProfile(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = join(templatesDirectory(libraryDir, env), PROFILE_FILE);
  if (!existsSync(path)) return undefined;
  const profile = meaningful(parseFrontmatter(readFileSync(path, 'utf8')).body);
  return profile || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Whether a phrase appears in a text as whole words, ignoring case: "demo" is in "Acme demo", not "demolition". */
export function phraseMatches(text: string | undefined, phrase: string): boolean {
  if (!text || !phrase.trim()) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(phrase.trim())}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * The template for a meeting title: the one whose longest `match` phrase
 * appears in it as whole words, else the default. "Weekly 1:1 with Sam" is a
 * One-on-one; "Acme discovery call" a Customer call.
 */
export function selectMeetingTemplate(
  templates: readonly MeetingTemplate[],
  title: string | undefined,
): MeetingTemplate | undefined {
  let best: { template: MeetingTemplate; length: number } | undefined;
  for (const template of templates) {
    for (const phrase of template.match) {
      if (phraseMatches(title, phrase) && phrase.length > (best?.length ?? 0)) best = { template, length: phrase.length };
    }
  }
  return best?.template ?? templates.find((template) => template.default);
}

export function findMeetingTemplate(templates: readonly MeetingTemplate[], name: string): MeetingTemplate | undefined {
  const wanted = name.trim().toLocaleLowerCase('en-US');
  return templates.find((template) => template.name.toLocaleLowerCase('en-US') === wanted
    || basename(template.path, '.md').toLocaleLowerCase('en-US') === wanted);
}

/** "none" turns templated notes off for one meeting; claims and summary still run. */
export const NO_TEMPLATE = 'none';

/**
 * Everything the owner asked for, for one meeting: the profile, the template
 * (a per-meeting choice wins over the calendar match) and the meeting's note.
 */
export function meetingInstructions(
  libraryDir: string,
  meeting: { title: string; calendarTitle?: string; template?: string; note?: string },
  env: NodeJS.ProcessEnv = process.env,
): { instructions?: MeetingInstructions; template?: MeetingTemplate } {
  const templates = loadMeetingTemplates(libraryDir, env);
  const chosen = meeting.template === NO_TEMPLATE
    ? undefined
    : meeting.template
      ? findMeetingTemplate(templates, meeting.template)
      : selectMeetingTemplate(templates, meeting.calendarTitle ?? meeting.title);
  if (meeting.template && meeting.template !== NO_TEMPLATE && !chosen) {
    throw new Error(`No template named "${meeting.template}" in ${templatesDirectory(libraryDir, env)}`);
  }
  const profile = loadProfile(libraryDir, env);
  const note = meeting.note?.trim();
  const instructions: MeetingInstructions = {
    ...(profile ? { profile } : {}),
    ...(chosen ? { template: { name: chosen.name, body: chosen.body } } : {}),
    ...(note ? { note } : {}),
  };
  return {
    ...(Object.keys(instructions).length ? { instructions } : {}),
    ...(chosen ? { template: chosen } : {}),
  };
}
