/**
 * Does a vocabulary prompt make Whisper invent words? Whisper treats an initial
 * prompt as text already said, and over silence it is known to "continue" it.
 * This builds synthetic tracks from whisper.cpp's jfk.wav with long silences
 * around it, transcribes each with and without a prompt full of unusual names
 * the clip never says, and counts:
 *
 * - names from the prompt anywhere in the output: every one is invented;
 * - lines outside the speech, before and after the phantom gate (speech-gate.ts);
 * - words inside the speech that differ from the run without a prompt.
 *
 * Paths: the whole track with no gate (Whisper alone); the whole track through
 * the gate; the final pass as it ships (speech packed together with 1 s gaps,
 * times mapped back, then the gate); and the live draft server on 5-second
 * chunks with Silero's skip.
 *
 * Tracks: two copies of the clip in long silence (digital zeros, then quiet room
 * tone), and the clip cut into phrases with 4–20 s of room tone between them, so
 * packed audio has many gaps.
 *
 *   bun run scripts/gym-vocabulary.ts [jfk.wav] [whisper model .bin]
 *
 * Made-up names only; no meeting audio is read.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { OwnedWhisperServer } from '../src/local-asr-scheduler.ts';
import { detectSpeechRegions, dropPhantomUnits, readMonoPcm } from '../src/speech-gate.ts';
import { transcribeWithTimestamps } from '../src/whisper-timestamps.ts';
import type { TimedTranscriptUnit } from '../src/transcript-types.ts';
import { whisperVocabularyPrompt } from '../src/vocabulary.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 16_000;
const jfkPath = process.argv[2] ?? [join(ROOT, 'whisper.cpp', 'samples', 'jfk.wav'),
  '/opt/homebrew/opt/seashell/share/seashell/jfk.wav'].find(existsSync);
const modelPath = process.argv[3] ?? [join(ROOT, 'models', 'ggml-large-v3-turbo-q5_0.bin'),
  '/opt/homebrew/opt/seashell/libexec/models/ggml-large-v3-turbo-q5_0.bin'].find(existsSync);
const whisperCli = join(ROOT, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const whisperServer = join(ROOT, 'whisper.cpp', 'build', 'bin', 'whisper-server');
if (!jfkPath || !modelPath) throw new Error('Pass the path to jfk.wav and to the Whisper model.');

/** Unusual names a person might really keep in a vocabulary file; JFK says none of them. */
const TERMS = ['Zyxolotl', 'Quenbrook', 'Teixeira-Vandenberg', 'Okonkwo', 'Brightwater Labs', 'Tlalnepantla',
  'Nakamura-Hughes', 'Vesperline', 'Kubernetes', 'Szczepański', 'Aoife', 'Ngozi Adebayo', 'Pellucid', 'Xanthe',
  'Fjordbank', 'Rhiannon', 'Moreau-Delacroix', 'Quillfeather', 'Ibrahimović', 'Saoirse', 'Thistlewood', 'Gwendolyn Ap-Rhys',
  'Ouagadougou', 'Krzysztof', 'Halvorsen', 'Zanzibar Analytics', 'Oyelaran', 'Murchison', 'Vantablack', 'Eskildsen',
  'Przybylski', 'Nkemelu', 'Lindqvist', 'Abernathy-Kwan', 'Solenne', 'Draxford', 'Quetzalli', 'Brannigan', 'Iolanthe',
  'Wrenfield', 'Okafor-Hale', 'Tamsin', 'Cholmondeley', 'Vukovich', 'Ysolde', 'Harrowgate', 'Pemberton-Oyelowo',
  'Zelenska', 'Marchetti', 'Aurelio'];
const PROMPT = whisperVocabularyPrompt(TERMS);
const WORDS = TERMS.flatMap((term) => term.toLocaleLowerCase().split(/[\s-]+/u)).filter((word) => word.length > 3);

const jfk = readMonoPcm(readFileSync(jfkPath));
if (!jfk) throw new Error(`${jfkPath} is not 16 kHz mono 16-bit`);

/** About -55 dBFS of noise: far below speech, well under the gate's quiet line, as a quiet room is. */
function roomTone(samples: number, seed: number): Int16Array {
  const tone = new Int16Array(samples);
  let state = seed;
  const random = () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
  for (let index = 0; index < samples; index += 1) {
    tone[index] = Math.round(Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random()) * 58);
  }
  return tone;
}

type Piece = number | Int16Array;
/** Seconds of silence or room tone, and pieces of speech, end to end; where the speech is, on the track's clock. */
function track(pieces: readonly Piece[], tone: 'zeros' | 'room'): { pcm: Int16Array; speech: Array<[number, number]> } {
  const total = pieces.reduce<number>((sum, piece) => sum + (typeof piece === 'number' ? piece * RATE : piece.length), 0);
  const pcm = tone === 'room' ? roomTone(total, 7) : new Int16Array(total);
  const speech: Array<[number, number]> = [];
  let at = 0;
  for (const piece of pieces) {
    if (typeof piece === 'number') { at += piece * RATE; continue; }
    for (let index = 0; index < piece.length; index += 1) pcm[at + index] = Math.max(-32768, Math.min(32767, pcm[at + index]! + piece[index]!));
    speech.push([at / RATE, (at + piece.length) / RATE]);
    at += piece.length;
  }
  return { pcm, speech };
}

const names = (units: readonly TimedTranscriptUnit[]) =>
  units.filter((unit) => WORDS.some((word) => unit.text.toLocaleLowerCase().includes(word)));
const outside = (units: readonly TimedTranscriptUnit[], speech: Array<[number, number]>) => units.filter((unit) =>
  !speech.some(([start, end]) => (unit.start + unit.end) / 2 >= start - 0.5 && (unit.start + unit.end) / 2 <= end + 0.5));
const words = (units: readonly TimedTranscriptUnit[]) =>
  units.map((unit) => unit.text).join(' ').toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
/** Word-level edit distance: how many words a prompt changed. */
function changed(left: readonly string[], right: readonly string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [row, word] of left.entries()) {
    const next = [row + 1];
    for (const [column, other] of right.entries()) next.push(Math.min(previous[column + 1]! + 1, next[column]! + 1, previous[column]! + (word === other ? 0 : 1)));
    previous = next;
  }
  return previous[right.length]!;
}

const directory = mkdtempSync(join(tmpdir(), 'seashell-vocabulary-gym-'));
const rows: string[][] = [['Track', 'Path', 'Prompt', 'Names', 'Outside speech', 'Words changed', 'What it wrote outside speech']];
const said = (units: readonly TimedTranscriptUnit[]) => [...new Set(units.map((unit) => unit.text.trim()))].slice(0, 4).join(' ');
try {
  // First, that a prompt reaches Whisper at all on this path: a prompt in capitals turns the clip's words to capitals.
  const probe = await transcribeWithTimestamps(jfkPath, { modelPath, whisperCli, detectSpeech: async () => undefined,
    prompt: 'THE FOLLOWING IS SHOUTED IN CAPITALS WITH NO PUNCTUATION' });
  const applied = probe.some((unit) => /[A-Z]{3}/u.test(unit.text)) && !probe.some((unit) => /[a-z]{3}/u.test(unit.text));
  console.log(`A prompt reaches the final pass: ${applied ? 'yes' : 'NO — the counts below say nothing about prompts'}.`);
  const phrases = (await detectSpeechRegions(jfkPath)) ?? [];
  if (phrases.length < 2) throw new Error('Speech detection found no phrases in the clip');
  const cut = phrases.map((region) => jfk.slice(Math.max(0, Math.round((region.start - 0.15) * RATE)), Math.round((region.end + 0.15) * RATE)));
  const gaps = [9, 4, 14, 6, 20, 5, 11, 8];
  const tracks: Array<[string, ReturnType<typeof track>]> = [
    ['two clips, zeros', track([40, jfk, 90, jfk, 60], 'zeros')],
    ['two clips, room', track([40, jfk, 90, jfk, 60], 'room')],
    ['phrases, room', track([12, ...[...cut, ...cut].flatMap((phrase, index) => [phrase, gaps[index % gaps.length]!])], 'room')],
    // Many 30-second windows of speech, where earlier text could start to steer later windows.
    ['eight clips, room', track([5, ...Array.from({ length: 8 }, () => [jfk, 4] as const).flat()], 'room')],
  ];
  for (const [name, { pcm, speech }] of tracks) {
    const path = join(directory, `${name.replace(/\W+/gu, '-')}.wav`);
    writeFileSync(path, pcmS16leToWav(new Uint8Array(pcm.buffer)));
    const baseline = new Map<string, string[]>();
    for (const prompt of [undefined, PROMPT]) {
      const whole = await transcribeWithTimestamps(path, { modelPath, whisperCli, detectSpeech: async () => undefined, ...(prompt ? { prompt } : {}) });
      const gated = await dropPhantomUnits(whole, path);
      const shipped = await transcribeWithTimestamps(path, { modelPath, whisperCli, ...(prompt ? { prompt } : {}) });
      for (const [label, units] of [['whole track, no gate', whole], ['whole track + gate', gated], ['packed + gate (ships)', shipped]] as const) {
        const inside = words(units.filter((unit) => !outside([unit], speech).length));
        if (!prompt) baseline.set(label, inside);
        rows.push([name, label, prompt ? 'names' : 'none', String(names(units).length), String(outside(units, speech).length),
          prompt ? String(changed(baseline.get(label) ?? [], inside)) : '–', said([...outside(units, speech), ...names(units)])]);
      }
    }
  }

  // The live draft: 5-second chunks through the same server and Silero skip the app uses.
  const { pcm: room } = track([40, jfk, 90, jfk, 60], 'room');
  const { pcm: sparse } = tracks[2]![1];
  const chunk = 5 * RATE;
  const chunks = [
    ...Array.from({ length: 6 }, () => new Int16Array(chunk)),
    ...Array.from({ length: 6 }, (_, index) => room.slice(index * chunk, (index + 1) * chunk)),
    ...Array.from({ length: Math.floor(sparse.length / chunk) }, (_, index) => sparse.slice(index * chunk, (index + 1) * chunk)),
  ];
  const liveBaseline: string[] = [];
  for (const prompt of [undefined, PROMPT]) {
    const server = new OwnedWhisperServer(whisperServer, { id: 'gym', modelPath, threads: 4, requestTimeoutMs: 120_000, idleTimeoutMs: 60_000,
      ...(prompt ? { prompt } : {}) });
    let invented = 0, quiet = 0, changedWords = 0;
    const heard: string[] = [];
    try {
      for (const [index, piece] of chunks.entries()) {
        const path = join(directory, `chunk-${index}.wav`);
        writeFileSync(path, pcmS16leToWav(new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength)));
        const text = await server.transcribe(path);
        const spoken = text.toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
        if (!prompt) liveBaseline[index] = spoken.join(' ');
        else changedWords += changed((liveBaseline[index] ?? '').split(' ').filter(Boolean), spoken);
        const found = WORDS.filter((word) => text.toLocaleLowerCase().includes(word)).length;
        invented += found;
        if (index < 12 && text) { quiet += 1; heard.push(text); }
        else if (found) heard.push(text);
      }
    } finally { await server.stop(); }
    rows.push([`${chunks.length} chunks of 5 s`, 'live draft server', prompt ? 'names' : 'none', String(invented), String(quiet), prompt ? String(changedWords) : '–', heard.slice(0, 4).join(' | ')]);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(`Prompt: ${PROMPT.length} characters, ${TERMS.length} names.\n`);
const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => Math.min(48, row[column]!.length))));
for (const row of rows) console.log(row.map((cell, column) => (cell.length > 48 ? `${cell.slice(0, 47)}…` : cell).padEnd(widths[column]!)).join('  '));
