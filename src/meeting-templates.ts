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

/** A small, strict subset of YAML: `key: value` and `key: [a, b]`. */
function parseFrontmatter(text: string): { fields: Record<string, string | string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string | string[]> = {};
  for (const line of match[1]!.split(/\r?\n/u)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line.trim());
    if (!pair) continue;
    const [, key, raw] = pair as unknown as [string, string, string];
    const list = /^\[(.*)\]$/u.exec(raw);
    fields[key] = list
      ? list[1]!.split(',').map((item) => unquote(item.trim())).filter(Boolean)
      : unquote(raw.trim());
  }
  return { fields, body: text.slice(match[0].length) };
}

function unquote(value: string): string {
  return /^(['"]).*\1$/u.test(value) ? value.slice(1, -1) : value;
}

/** Comments are notes to the person editing the file, not instructions. */
function meaningful(body: string): string {
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

export function loadProfile(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = join(templatesDirectory(libraryDir, env), PROFILE_FILE);
  if (!existsSync(path)) return undefined;
  const profile = meaningful(parseFrontmatter(readFileSync(path, 'utf8')).body);
  return profile || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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
      const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}($|[^\\p{L}\\p{N}])`, 'iu');
      if (title && pattern.test(title) && phrase.length > (best?.length ?? 0)) best = { template, length: phrase.length };
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
