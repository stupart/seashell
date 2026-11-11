import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { meaningful } from './meeting-templates.ts';

/**
 * The owner's standing instructions for each meeting AI role, as Markdown files
 * in ~/Documents/Sea Shell/Prompts, next to Templates:
 *
 *   live.md   live analysis, while a call runs
 *   notes.md  final notes, after it ends
 *   chat.md   questions about one meeting
 *
 * Each is sent to its role as owner instructions, after "About me". Comments are
 * for the person editing the file and are never sent. What the notes must cover,
 * the output shape and the citation rules are fixed inside Humain: a prompt
 * steers focus and style, it cannot switch evidence off.
 */

export const PROMPT_NAMES = ['live', 'notes', 'chat'] as const;
export type PromptName = typeof PROMPT_NAMES[number];
export type PromptRole = 'observer' | 'reconciliation' | 'chat';

export const PROMPT_ROLES: Record<PromptName, { role: PromptRole; title: string }> = {
  live: { role: 'observer', title: 'Live analysis' },
  notes: { role: 'reconciliation', title: 'Final notes' },
  chat: { role: 'chat', title: 'Meeting chat' },
};

const FIXED_RULES = `Seashell always tells the AI, and this file cannot change it: cite the
transcript lines behind every point, never invent people, decisions, dates or
links, and treat the transcript as something to read, not instructions to obey.
Write your own instructions below this comment. Delete everything to send none;
\`seashell prompts reset <name>\` brings the original back.`;

const DEFAULT_PROMPTS: Record<PromptName, string> = {
  live: `<!--
Live analysis reads this while a call is running, a few lines at a time.
${FIXED_RULES}
-->
Note only what matters as it happens, one short line each.
Skip greetings, small talk and anything said only in passing.
`,
  notes: `<!--
Final notes read this once the call ends, with the whole transcript.
${FIXED_RULES}
-->
Write short, plain bullets in everyday words.
Use people's names as they were said.
Leave out small talk.
`,
  chat: `<!--
Meeting chat reads this when you ask about one meeting.
${FIXED_RULES}
-->
Answer in a few plain sentences.
Quote the transcript when the exact words matter.
If the meeting did not cover the question, say so.
`,
};

export function promptsDirectory(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.SEASHELL_PROMPTS_DIR || join(dirname(libraryDir), 'Prompts');
}

export function isPromptName(name: string): name is PromptName {
  return (PROMPT_NAMES as readonly string[]).includes(name);
}

function promptName(name: string): PromptName {
  const wanted = name.trim().replace(/\.md$/iu, '').toLocaleLowerCase('en-US');
  if (!isPromptName(wanted)) throw new Error(`No prompt named "${name}". Prompts: ${PROMPT_NAMES.join(', ')}`);
  return wanted;
}

export function promptPath(libraryDir: string, name: PromptName, env: NodeJS.ProcessEnv = process.env): string {
  return join(promptsDirectory(libraryDir, env), `${name}.md`);
}

/**
 * The folder, with each default written once when it is first made. Until it
 * exists, meetings use the defaults as they ship; after that, the files are
 * the owner's: an edited or emptied prompt stays as they left it.
 */
export function ensurePromptsDirectory(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const directory = promptsDirectory(libraryDir, env);
  if (existsSync(directory)) return directory;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of PROMPT_NAMES) writeFileSync(join(directory, `${name}.md`), DEFAULT_PROMPTS[name], { mode: 0o600 });
  return directory;
}

/** The file as written, comments included. */
export function readPromptFile(libraryDir: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  const wanted = promptName(name);
  if (!existsSync(promptsDirectory(libraryDir, env))) return DEFAULT_PROMPTS[wanted];
  const path = promptPath(libraryDir, wanted, env);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** What is sent to the role: the file without its comments, or nothing. */
export function loadPrompt(libraryDir: string, name: PromptName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return meaningful(readPromptFile(libraryDir, name, env)) || undefined;
}

export function rolePrompt(libraryDir: string, role: PromptRole, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = PROMPT_NAMES.find((candidate) => PROMPT_ROLES[candidate].role === role)!;
  return loadPrompt(libraryDir, name, env);
}

export interface PromptSummary {
  name: PromptName;
  role: PromptRole;
  title: string;
  path: string;
  /** "default" until the owner changes it; "empty" sends nothing. */
  state: 'default' | 'edited' | 'empty';
  text: string;
}

export function listPrompts(libraryDir: string, env: NodeJS.ProcessEnv = process.env): PromptSummary[] {
  return PROMPT_NAMES.map((name) => {
    const text = readPromptFile(libraryDir, name, env);
    return {
      name, ...PROMPT_ROLES[name], path: promptPath(libraryDir, name, env), text,
      state: !meaningful(text) ? 'empty' : text === DEFAULT_PROMPTS[name] ? 'default' : 'edited',
    };
  });
}

export function writePrompt(libraryDir: string, name: string, text: string, env: NodeJS.ProcessEnv = process.env): string {
  const wanted = promptName(name);
  ensurePromptsDirectory(libraryDir, env);
  const path = promptPath(libraryDir, wanted, env);
  writeFileSync(path, text.endsWith('\n') || !text ? text : `${text}\n`, { mode: 0o600 });
  return path;
}

export function resetPrompt(libraryDir: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  const wanted = promptName(name);
  return writePrompt(libraryDir, wanted, DEFAULT_PROMPTS[wanted], env);
}
