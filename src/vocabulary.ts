import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { loadConfig, resolveLibraryDir } from './config.ts';

/**
 * Words the owner wants spelled right: people, companies, products, jargon.
 * One term per line in ~/Documents/Sea Shell/Vocabulary.txt, next to Prompts.
 * A line starting with # is a note to the person editing the file.
 *
 * Every meeting AI run gets the terms as `instructions.vocabulary`, so notes,
 * chat, briefs and drafts spell them as written here. Whisper gets them too, as
 * its initial prompt, live and for the final transcript. A prompt is known to
 * make Whisper invent words over silence, so scripts/gym-vocabulary.ts checks
 * it: on jfk.wav padded with long silence, 50 unusual names in the prompt were
 * never written anywhere, and the stray lines it added on a whole unpacked track
 * ("Sous-titrage Société Radio-Canada") were all removed by the phantom gate.
 */

/** Humain's limits for `instructions.vocabulary`. */
export const VOCABULARY_LIMITS = { terms: 200, termLength: 80 } as const;

const STARTER = `# Words for Seashell to spell right: names, companies, products, jargon.
# One per line. Lines starting with # are notes to you and are never sent.
#
# The AI that writes notes, answers questions, writes briefs and drafts
# follow-ups uses these spellings. At most 200 words, each up to 80 characters.
#
# For example:
# Priya Raman
# Northwind
# OKRs
`;

export function vocabularyPath(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.SEASHELL_VOCABULARY_FILE || join(dirname(libraryDir), 'Vocabulary.txt');
}

/** Made with a short explanation the first time it is asked for; never overwritten. */
export function ensureVocabularyFile(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = vocabularyPath(libraryDir, env);
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, STARTER, { mode: 0o600 });
  return path;
}

export interface Vocabulary {
  path: string;
  /** In file order, each once, ready to send. */
  terms: string[];
  /** Lines that are not sent, and why, in plain words. */
  problems: string[];
}

/** The terms in a file's text: comments and blank lines skipped, repeats once, limits kept. */
export function parseVocabulary(text: string): Pick<Vocabulary, 'terms' | 'problems'> {
  const terms: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/u)) {
    const term = raw.replace(/\s+/gu, ' ').trim();
    if (!term || term.startsWith('#')) continue;
    if (term.length > VOCABULARY_LIMITS.termLength) {
      problems.push(`"${term.slice(0, 24)}…" is longer than ${VOCABULARY_LIMITS.termLength} characters, so it is left out.`);
      continue;
    }
    const key = term.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  if (terms.length > VOCABULARY_LIMITS.terms) {
    problems.push(`Only the first ${VOCABULARY_LIMITS.terms} of ${terms.length} words are used.`);
    terms.length = VOCABULARY_LIMITS.terms;
  }
  return { terms, problems };
}

export function loadVocabulary(libraryDir: string, env: NodeJS.ProcessEnv = process.env): Vocabulary {
  const path = vocabularyPath(libraryDir, env);
  if (!existsSync(path)) return { path, terms: [], problems: [] };
  try {
    return { path, ...parseVocabulary(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { path, terms: [], problems: [`It could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** The file as written, comments included; the starter when there is none yet. */
export function readVocabularyFile(libraryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = vocabularyPath(libraryDir, env);
  return existsSync(path) ? readFileSync(path, 'utf8') : STARTER;
}

/**
 * Replace the file. Comments the owner wrote are kept when the agent sends only
 * terms: a text with no comment lines keeps the file's leading comment block.
 */
export function writeVocabulary(libraryDir: string, text: string, env: NodeJS.ProcessEnv = process.env): Vocabulary {
  const path = ensureVocabularyFile(libraryDir, env);
  const hasComments = text.split(/\r?\n/u).some((line) => line.trim().startsWith('#'));
  const header = hasComments ? '' : readFileSync(path, 'utf8').split(/\r?\n/u)
    .filter((line, index, lines) => lines.slice(0, index + 1).every((earlier) => earlier.trim().startsWith('#'))).join('\n');
  const body = text.endsWith('\n') || !text ? text : `${text}\n`;
  writeFileSync(path, header ? `${header}\n${body}` : body, { mode: 0o600 });
  return loadVocabulary(libraryDir, env);
}

/**
 * Whisper reads at most half its 448-token context as a prompt, and unusual
 * names cost about a token for every three characters. Terms go in file order,
 * whole, until the next would pass this many characters.
 */
export const WHISPER_PROMPT_CHARACTERS = 550;

/** About how many tokens a prompt of unusual names takes; Whisper reads at most 224. */
export function whisperPromptTokens(prompt: string): number {
  return Math.min(224, Math.ceil(prompt.length / 2.5));
}

/** The terms as Whisper's initial prompt: "Priya Raman, Northwind, OKRs." Empty when there are none. */
export function whisperVocabularyPrompt(terms: readonly string[]): string {
  let prompt = '';
  for (const term of terms) {
    const next = prompt ? `${prompt}, ${term}` : term;
    if (next.length + 1 > WHISPER_PROMPT_CHARACTERS) break;
    prompt = next;
  }
  return prompt ? `${prompt}.` : '';
}

/**
 * The owner's vocabulary as Whisper's prompt, read from where the library is.
 * Undefined with no terms, or when the file or settings cannot be read: a
 * transcript never waits on its vocabulary.
 */
export function defaultWhisperPrompt(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return whisperVocabularyPrompt(loadVocabulary(resolveLibraryDir(undefined, env, loadConfig()), env).terms) || undefined;
  } catch { return undefined; }
}
