import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { saveFinalizedCapture } from '../src/capture-finalizer.ts';
import { findTranscriptRecord } from '../src/transcript-library.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { evaluateSpeakerAttribution, type SpeakerReferenceTurn } from '../src/speaker-evaluation.ts';
import type { MeetSample } from '../src/meet-speakers.ts';
import type { TimedTranscriptUnit } from '../src/transcript-types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rate = 16_000;
const meeting = '/abc-defg-hij';
const alice = { id: 'MEET_aaaaaaaaaaaaaaaaaaaa', label: 'Alice' };
const bob = { id: 'MEET_bbbbbbbbbbbbbbbbbbbb', label: 'Bob' };

// A separate child uses the actual local adapter and its model from an explicit,
// trusted Seashell source/install root. No duplicate Whisper invocation logic.
const transcribeScript = `import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [runtime, audio] = process.argv.slice(1);
const { transcribeWithTimestamps } = await import(pathToFileURL(join(runtime, 'src/whisper-timestamps.ts')).href);
console.log(JSON.stringify(await transcribeWithTimestamps(audio)));
`;

/** Every tool owns a process group; abort/timeout kills only that group. */
async function command(argv: string[], signal: AbortSignal, timeoutMs = 30_000): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolveCommand, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', error: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, signal); } catch {} }
    };
    const stop = (reason: Error) => {
      error ??= reason;
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 1500);
    };
    const abort = () => stop(new Error('Speaker ASR gym cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error(`Timed out: ${argv[0]}`)), timeoutMs);
    child.stdout.on('data', (chunk) => {
      const next = stdout + chunk;
      stdout = next.slice(0, 8 * 1024 * 1024);
      if (next.length > stdout.length) stop(new Error('Tool output exceeded 8 MiB'));
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', cause => { error = cause; });
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (escalation) { clearTimeout(escalation); kill('SIGKILL'); }
      if (error || code !== 0) reject(error ?? new Error(`${argv[0]} exited ${code}: ${stderr}`));
      else resolveCommand(stdout);
    });
    if (signal.aborted) abort();
  });
}

async function run(runtimeRoot: string, longPauses: boolean) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const resultsRoot = join(root, '.gym-results', 'speaker-asr');
  mkdirSync(resultsRoot, { recursive: true, mode: 0o700 });
  const output = mkdtempSync(join(resultsRoot, 'run-'));
  const media = join(output, 'media'), library = join(output, 'library');
  mkdirSync(media, { mode: 0o700 });
  const json = (name: string, value: unknown) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const started = performance.now();
  const limits = 'Generated voices + scripted platform observations with real local Whisper and saved transcript. This is not live Meet detection, a human-speaker diarization score, or a hardware capture test.';
  try {
    const packageInfo = JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8'));
    if (packageInfo.name !== 'seashell') throw new Error('--runtime-root must be a trusted Seashell source or installed package');
    const phrases = [
      { voice: 'Samantha', speaker: alice, text: 'The launch review is scheduled for Tuesday. I will prepare the release notes.' },
      { voice: 'Daniel', speaker: bob, text: 'We should test the microphone and computer audio. I will check the recording quality.' },
      { voice: 'Samantha', speaker: alice, text: 'Please create a ticket for the missing speaker names. The follow up is on Friday.' },
    ];
    const synthesize = async (id: string, voice: string, text: string) => {
      const aiff = join(media, `${id}.aiff`), raw = join(media, `${id}.pcm`);
      await command(['/usr/bin/say', '-v', voice, '-r', '155', '-o', aiff, text], controller.signal);
      await command(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', aiff,
        '-ar', String(rate), '-ac', '1', '-f', 's16le', raw], controller.signal);
      const pcm = readFileSync(raw);
      if (pcm.length < rate || pcm.length > rate * 2 * 45 || pcm.length % 2) throw new Error('Speech synthesis produced invalid audio');
      return pcm;
    };
    const reference: SpeakerReferenceTurn[] = [];
    const turns: Array<{ start: number; end: number; speaker: typeof alice }> = [];
    const pieces: Buffer[] = [];
    let frames = 0;
    const pauseFrames = rate * (longPauses ? 15 : 1);
    const silence = () => { pieces.push(Buffer.alloc(pauseFrames * 2)); frames += pauseFrames; };
    for (const [i, phrase] of phrases.entries()) {
      silence();
      const pcm = await synthesize(`remote-${i}`, phrase.voice, phrase.text);
      const start = frames / rate;
      pieces.push(pcm); frames += pcm.length / 2;
      const end = frames / rate;
      reference.push({ id: `remote-${i}`, start, end, channel: 'system-audio', speakers: [phrase.speaker.label] });
      turns.push({ start, end, speaker: phrase.speaker });
      silence();
    }
    const mic = await synthesize('local', 'Karen', 'I can own the installation checklist and the final review.');
    const microphoneStart = (longPauses ? 15 : 1) + 1;
    reference.push({ id: 'local', start: microphoneStart, end: microphoneStart + mic.length / (rate * 2),
      channel: 'microphone', speakers: [] });
    json('reference.json', { phrases, turns: reference, limits });
    const systemPath = join(media, 'system.wav'), microphonePath = join(media, 'microphone.wav');
    writeFileSync(systemPath, pcmS16leToWav(Buffer.concat(pieces)), { mode: 0o600 });
    writeFileSync(microphonePath, pcmS16leToWav(mic), { mode: 0o600 });
    const store = new CaptureSessionStore({ libraryDir: library, sessionId: 'speaker-asr', startedAtUnixMs: 1000 });
    store.commitChunk({ sourcePath: systemPath, trackId: 'system-audio', startSeconds: 0, endSeconds: frames / rate, audible: true });
    store.commitChunk({ sourcePath: microphonePath, trackId: 'microphone', startSeconds: microphoneStart,
      endSeconds: microphoneStart + mic.length / (rate * 2), audible: true });
    const samples: MeetSample[] = [];
    for (let at = 0; at <= frames / rate + .5; at += .5) {
      const turn = turns.find(turn => at >= turn.start && at <= turn.end);
      samples.push({ at, meeting, browser: 'chrome', source: 'google-meet-accessibility',
        ...(turn ? { speaker: turn.speaker } : {}) });
    }
    writeFileSync(join(store.root, 'meet-speakers.jsonl'), [
      JSON.stringify({ version: 1, sessionId: store.manifest.sessionId, origin: store.manifest.startedAtUnixMs }),
      ...samples.map(sample => JSON.stringify(sample)), '',
    ].join('\n'), { mode: 0o600 });
    const record = await saveFinalizedCapture(store, library, 'speaker-asr-gym', {
      diarizeSystemAudio: false,
      localTranscriber: async path => {
        console.log(`Transcribing ${path.includes('microphone') ? 'microphone' : 'remote turns'} with local Whisper…`);
        const result = await command([process.execPath, '-e', transcribeScript, runtimeRoot, path], controller.signal, 180_000);
        return JSON.parse(result) as TimedTranscriptUnit[];
      },
    });
    const saved = findTranscriptRecord(library, record.id);
    const actual = JSON.parse(readFileSync(saved.path, 'utf8'));
    const evaluation = evaluateSpeakerAttribution(reference, actual, { expectedNamedSource: 'google-meet-accessibility' });
    json('transcript.json', actual);
    json('evaluation.json', evaluation);
    const textFor = (label: string) => actual.transcript.filter((segment: { speaker?: string }) =>
      actual.speakers.some((speaker: { id: string; label: string }) => speaker.id === segment.speaker && speaker.label === label))
      .map((segment: { text: string }) => segment.text).join(' ').toLowerCase();
    for (const [label, words] of [['Alice', ['tuesday', 'release', 'friday']], ['Bob', ['microphone', 'recording']],
      ['Microphone', ['installation', 'checklist']]] as const) {
      for (const word of words) if (!textFor(label).includes(word)) throw new Error(`Expected ${label}'s saved transcript to contain '${word}'`);
    }
    if (evaluation.wrongNameSeconds > 0 || evaluation.unsafeNameSeconds > 0 || evaluation.provenanceViolationSeconds > 0)
      throw new Error('Saved transcript contains a wrong/unsafe name or lost speaker provenance');
    if ((evaluation.transcriptCoverage ?? 0) < .8 || (evaluation.transcribedNamedCoverage ?? 0) < .8)
      throw new Error('Healthy speaker ASR fixture fell below 80% timing or transcribed-name coverage');
    if (evaluation.turns.some(turn => turn.transcribedSeconds / turn.referenceSeconds < .7))
      throw new Error('At least one known utterance lost more than 30% of its reference timing');
    json('result.json', { status: 'passed', durationMs: performance.now() - started, runtimeRoot, longPauses, evaluation, limits });
    rmSync(media, { recursive: true, force: true });
    rmSync(library, { recursive: true, force: true });
    console.log(`PASS ${join(output, 'result.json')}`);
  } catch (error) {
    json('result.json', { status: 'failed', durationMs: performance.now() - started, error: String(error), runtimeRoot, longPauses, limits });
    console.error(`Evidence: ${output}`);
    throw error;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('bun scripts/gym-speaker-asr.ts [--runtime-root /trusted/seashell/root] [--long-pauses]\nRequires macOS voices, FFmpeg and an installed local Whisper model. No microphone, playback, browser, or cloud calls.');
  } else {
    let runtime = root, longPauses = false;
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      seen.add(arg);
      if (arg === '--long-pauses') longPauses = true;
      else if (arg === '--runtime-root' && args[i + 1] && !args[i + 1]!.startsWith('--')) runtime = resolve(args[++i]!);
      else throw new Error('Usage: bun scripts/gym-speaker-asr.ts [--runtime-root /trusted/seashell/root] [--long-pauses]');
    }
    await run(runtime, longPauses);
  }
}
