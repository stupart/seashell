import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import {
  addVocabularyTerm,
  defaultWhisperPrompt,
  ensureVocabularyFile,
  loadVocabulary,
  parseVocabulary,
  removeVocabularyTerm,
  vocabularyPath,
  whisperPromptTokens,
  whisperVocabularyPrompt,
  WHISPER_PROMPT_CHARACTERS,
  writeVocabulary,
} from '../src/vocabulary.ts';
import { transcribeWithTimestamps } from '../src/whisper-timestamps.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function home() {
  const root = mkdtempSync(join(tmpdir(), 'seashell-vocabulary-'));
  roots.push(root);
  const library = join(root, 'Transcripts');
  mkdirSync(library);
  return { root, library };
}

test('one term per line: comments and blank lines are skipped, repeats kept once, in order', () => {
  expect(parseVocabulary('# people\nPriya Raman\n\n  Northwind  \npriya raman\n#OKRs\nOKRs\n')).toEqual({
    terms: ['Priya Raman', 'Northwind', 'OKRs'], problems: [],
  });
});

test('a term over 80 characters, or past the 200th, is left out and said so', () => {
  const long = 'x'.repeat(81);
  expect(parseVocabulary(`${long}\nKept`)).toEqual({ terms: ['Kept'], problems: [expect.stringContaining('longer than 80 characters')] });
  const many = parseVocabulary(Array.from({ length: 205 }, (_, index) => `Term ${index}`).join('\n'));
  expect(many.terms).toHaveLength(200);
  expect(many.terms.at(-1)).toBe('Term 199');
  expect(many.problems).toEqual(['Only the first 200 of 205 words are used.']);
});

test('the file sits beside Prompts, starts with an explanation, and keeps it when an agent writes terms', () => {
  const { root, library } = home();
  expect(vocabularyPath(library, {})).toBe(join(root, 'Vocabulary.txt'));
  expect(loadVocabulary(library, {})).toEqual({ path: join(root, 'Vocabulary.txt'), terms: [], problems: [] });
  const path = ensureVocabularyFile(library, {});
  expect(readFileSync(path, 'utf8')).toStartWith('# Words for Seashell to spell right');
  expect(loadVocabulary(library, {}).terms).toEqual([]);
  const saved = writeVocabulary(library, 'Priya Raman\nNorthwind', {});
  expect(saved.terms).toEqual(['Priya Raman', 'Northwind']);
  expect(readFileSync(path, 'utf8')).toStartWith('# Words for Seashell to spell right');
  // Text with comments of its own replaces the file whole.
  writeVocabulary(library, '# mine\nAcme', {});
  expect(readFileSync(path, 'utf8')).toBe('# mine\nAcme\n');
});

test('a word added in the app goes at the end, once, and removing it keeps your notes in the file', () => {
  const { library } = home();
  const first = addVocabularyTerm(library, '  Humain ', {});
  expect(first).toMatchObject({ term: 'Humain', added: true });
  const path = vocabularyPath(library, {});
  expect(readFileSync(path, 'utf8')).toStartWith('# Words for Seashell to spell right');
  expect(addVocabularyTerm(library, 'humain', {}).added).toBe(false);
  addVocabularyTerm(library, 'Priya Raman', {});
  expect(loadVocabulary(library, {}).terms).toEqual(['Humain', 'Priya Raman']);
  expect(() => addVocabularyTerm(library, '   ', {})).toThrow('Type a word');
  expect(() => addVocabularyTerm(library, 'x'.repeat(81), {})).toThrow('under 80 characters');
  expect(removeVocabularyTerm(library, 'HUMAIN', {}).terms).toEqual(['Priya Raman']);
  expect(readFileSync(path, 'utf8')).toStartWith('# Words for Seashell to spell right');
});

test('Whisper gets whole terms in file order, within the room its prompt has', () => {
  expect(whisperVocabularyPrompt([])).toBe('');
  expect(whisperVocabularyPrompt(['Priya Raman', 'Northwind', 'OKRs'])).toBe('Priya Raman, Northwind, OKRs.');
  const prompt = whisperVocabularyPrompt(Array.from({ length: 200 }, (_, index) => `Quenbrook${index}`));
  expect(prompt.length).toBeLessThanOrEqual(WHISPER_PROMPT_CHARACTERS);
  expect(prompt).toStartWith('Quenbrook0, Quenbrook1,');
  expect(prompt).toEndWith('.');
  expect(whisperPromptTokens(prompt)).toBeLessThanOrEqual(224);
  expect(whisperPromptTokens('Northwind.')).toBe(4);
});

test('the default prompt is read from the vocabulary beside the library, and nothing when there is none', () => {
  const { root, library } = home();
  const env = { SEASHELL_LIBRARY_DIR: library, SEASHELL_CONFIG: join(root, 'config.json') } as NodeJS.ProcessEnv;
  expect(defaultWhisperPrompt(env)).toBeUndefined();
  writeFileSync(join(root, 'Vocabulary.txt'), '# names\nPriya Raman\nNorthwind\n');
  expect(defaultWhisperPrompt(env)).toBe('Priya Raman, Northwind.');
});

/** A whisper-cli that logs its arguments and writes one made-up line. */
function fakeWhisper() {
  const root = mkdtempSync(join(tmpdir(), 'seashell-vocabulary-whisper-'));
  roots.push(root);
  const cli = join(root, 'whisper-cli');
  const calls = join(root, 'calls.log');
  writeFileSync(cli, `#!/bin/sh
for argument in "$@"; do printf '%s\\n' "$argument" >> '${calls}'; done
echo '--' >> '${calls}'
while [ $# -gt 0 ]; do [ "$1" = -of ] && out="$2"; shift; done
printf '%s' '{"transcription":[{"text":" Priya Raman joined.","offsets":{"from":0,"to":900}}]}' > "$out.json"
`);
  chmodSync(cli, 0o755);
  const model = join(root, 'model.bin');
  writeFileSync(model, '');
  const pcm = Buffer.alloc(16_000 * 2);
  for (let index = 0; index < 16_000; index++) pcm.writeInt16LE(Math.round(Math.sin(index / 8) * 16_000), index * 2);
  const audio = join(root, 'audio.wav');
  writeFileSync(audio, pcmS16leToWav(pcm));
  return { cli, model, audio, calls: () => readFileSync(calls, 'utf8').trim().split('--\n').map((call) => call.trim().split('\n')) };
}

test('a vocabulary reaches every window of the final pass, with room for only about itself', async () => {
  const whisper = fakeWhisper();
  const hardware = { appleSilicon: true, performanceCores: 6, memoryBytes: 16 * 2 ** 30 };
  await transcribeWithTimestamps(whisper.audio, { whisperCli: whisper.cli, modelPath: whisper.model, hardware,
    detectSpeech: async () => undefined, prompt: 'Priya Raman, Northwind.' });
  // With none, earlier text never conditions the next window, as before.
  await transcribeWithTimestamps(whisper.audio, { whisperCli: whisper.cli, modelPath: whisper.model, hardware,
    detectSpeech: async () => undefined, prompt: '' });
  const [withWords, without] = whisper.calls();
  expect(withWords).toContain('--carry-initial-prompt');
  expect(withWords![withWords!.indexOf('--prompt') + 1]).toBe('Priya Raman, Northwind.');
  expect(withWords![withWords!.indexOf('-mc') + 1]).toBe(String(whisperPromptTokens('Priya Raman, Northwind.')));
  expect(without).not.toContain('--prompt');
  expect(without![without!.indexOf('-mc') + 1]).toBe('0');
});
