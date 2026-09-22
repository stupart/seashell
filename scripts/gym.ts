import { spawn, spawnSync } from 'child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { OwnedWhisperServer } from '../src/local-asr-scheduler.ts';
import { DEFAULT_WHISPER_MODEL_FILENAME } from '../src/model-config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let rounds = 1;
let native = false;
let asr = false;
let captureSoak = false;
let meetingSoak = false;
let humain: string | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--') continue;
  if (arg === '--native') native = true;
  else if (arg === '--capture-soak') captureSoak = true;
  else if (arg === '--meeting-soak') meetingSoak = true;
  else if (arg === '--asr') { asr = true; native = true; }
  else if (arg === '--rounds') rounds = Number(args[++i]);
  else if (arg === '--humain' && args[i + 1]) humain = resolve(args[++i]!);
  else if (arg === '--help') {
    console.log('bun run gym [--rounds 1..10] [--native] [--asr] [--capture-soak] [--meeting-soak] [--humain /path/to/dist/cli.js]');
    process.exit(0);
  } else throw new Error(`Unknown or incomplete gym option: ${arg}`);
}
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('--rounds must be 1..10');
if (native && process.platform !== 'darwin') throw new Error('--native and --asr require macOS');

const output = join(root, '.gym-results', `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
mkdirSync(output, { recursive: true, mode: 0o700 });
const config = join(output, 'config.json');
writeFileSync(config, JSON.stringify({ libraryDir: join(output, 'library'), meeting: { automation: { enabled: false } } }), { mode: 0o600 });
const environment = { ...process.env, SEASHELL_CONFIG: config, SEASHELL_LIBRARY_DIR: join(output, 'library'), SEASHELL_REQUIRE_MEDIA_TESTS: '1' };
type Result = { name: string; status: 'passed' | 'failed'; durationMs: number; error?: string };
const results: Result[] = [];
const metadata = {
  schemaVersion: 1, createdAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  bun: Bun.version, node: spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout?.trim(),
  revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim(),
  dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout?.trim()),
  requested: { rounds, native, asr, captureSoak, meetingSoak, humain: Boolean(humain) },
};
function report() {
  writeFileSync(join(output, 'results.json'), JSON.stringify({ ...metadata, results }, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(output, 'report.md'), [
    '# Sea Shell reliability gym', '', `Revision: ${metadata.revision}${metadata.dirty ? ' (working changes)' : ''}`,
    `Runtime: Bun ${Bun.version}; ${process.platform}/${process.arch}`, '',
    ...results.map((r) => `- ${r.status.toUpperCase()} ${r.name} (${r.durationMs} ms)${r.error ? `: ${r.error}` : ''}`),
    '', 'Logs are adjacent. This run does not establish real-device permissions, diarization quality, cloud-route behavior, or a long-call soak result.', '',
  ].join('\n'), { mode: 0o600 });
}
async function check(name: string, action: () => Promise<void>) {
  const start = Date.now();
  console.log(`Running ${name}…`);
  try {
    await action();
    results.push({ name, status: 'passed', durationMs: Date.now() - start });
  } catch (error) {
    results.push({ name, status: 'failed', durationMs: Date.now() - start, error: String(error) });
    throw error;
  } finally { report(); }
}
async function command(name: string, argv: string[], timeoutMs = 120_000, overrides: NodeJS.ProcessEnv = {}): Promise<string> {
  const stdoutPath = join(output, `${name}.stdout.log`);
  const out = openSync(stdoutPath, 'w', 0o600);
  const err = openSync(join(output, `${name}.stderr.log`), 'w', 0o600);
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: root, env: { ...environment, ...overrides }, detached: true, stdio: ['ignore', out, err] });
      let failure: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid) { try { process.kill(-child.pid, signal); } catch {} }
      };
      const stop = (error: Error) => {
        failure ??= error;
        killGroup('SIGTERM');
        killTimer ??= setTimeout(() => killGroup('SIGKILL'), 2_000);
      };
      // The local CI parent can be interrupted while this command owns a
      // separate process group. Forward cancellation before leaving the gym.
      const interrupt = () => stop(new Error(`${name} interrupted by SIGINT`));
      const terminate = () => stop(new Error(`${name} interrupted by SIGTERM`));
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', terminate);
      const timer = setTimeout(() => stop(new Error(`${name} exceeded ${timeoutMs} ms`)), timeoutMs);
      child.once('error', (error) => { failure = error; });
      child.once('close', (code) => {
        clearTimeout(timer);
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
        if (killTimer) { clearTimeout(killTimer); killGroup('SIGKILL'); }
        if (failure || code !== 0) reject(failure ?? new Error(`${name} exited ${code}; inspect its logs`));
        else resolvePromise();
      });
    });
  } finally { closeSync(out); closeSync(err); }
  return readFileSync(stdoutPath, 'utf8');
}
function assertSpeech(text: string) {
  const normalized = text.toLowerCase();
  for (const word of ['tuesday', 'alice', 'release', 'bob', 'audio']) {
    if (!normalized.includes(word)) throw new Error(`Speech fixture is missing expected word: ${word}`);
  }
}
try {
  await check('prerequisites', async () => {
    for (const binary of ['ffmpeg', 'ffprobe', 'node', 'python3']) {
      if (!Bun.which(binary)) throw new Error(`Install ${binary} before running the gym`);
    }
  });
  await check('typecheck', async () => { await command('typecheck', [process.execPath, 'run', 'typecheck']); });
  for (let round = 1; round <= rounds; round++) {
    await check(`tests-${round}`, async () => {
      await command(`tests-${round}`, [process.execPath, 'run', 'test'], 120_000, {
        SEASHELL_CONFIG: undefined, SEASHELL_LIBRARY_DIR: undefined,
      });
    });
  }
  if (native) await check('native-build', async () => { await command('native-build', ['bash', 'scripts/build-native.sh']); });
  if (captureSoak) await check('capture-storage-soak', async () => {
    await command('capture-storage-soak', [process.execPath, 'scripts/gym-capture-soak.ts', join(output, 'capture-soak')], 180_000);
  });
  if (meetingSoak) await check('meeting-lifecycle-soak', async () => {
    await command('meeting-lifecycle-soak', [process.execPath, 'scripts/gym-meeting-soak.ts', join(output, 'meeting-soak')], 180_000);
  });
  if (humain) await check('humain-meeting-contract', async () => {
    await command('humain-meeting-contract', [process.execPath, 'scripts/gym-humain.ts', humain!, join(output, 'humain-contract')]);
  });
  if (asr) {
    const aiff = join(output, 'speech.aiff');
    const wav = join(output, 'speech.wav');
    await check('speech-fixture', async () => {
      await command('say', ['say', '-o', aiff, 'The project meeting is on Tuesday. Alice will prepare the release notes. Bob will test the audio recorder.']);
      await command('ffmpeg', ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '16000', '-ac', '1', wav]);
    });
    await check('batch-asr', async () => {
      const record = JSON.parse(await command('batch-asr', [process.execPath, 'src/cli.tsx', 'transcribe', wav, '--format', 'json', '--quiet']));
      assertSpeech(record.transcript.map((s: { text: string }) => s.text).join(' '));
      const srt = await command('export-srt', [process.execPath, 'src/cli.tsx', 'library', 'show', record.id, '--format', 'srt']);
      if (!srt.includes('-->')) throw new Error('Subtitle rendering is missing timestamps');
      await command('meeting-create', [process.execPath, 'src/cli.tsx', 'meeting', 'create', record.id]);
    });
    await check('warm-asr', async () => {
      const server = new OwnedWhisperServer(join(root, 'whisper.cpp/build/bin/whisper-server'), {
        id: 'gym', modelPath: join(root, 'models', DEFAULT_WHISPER_MODEL_FILENAME), threads: 4,
        requestTimeoutMs: 60_000, idleTimeoutMs: 1_000,
      });
      try {
        const text = await server.transcribe(wav);
        assertSpeech(text);
        writeFileSync(join(output, 'warm-transcript.txt'), text, { mode: 0o600 });
      } finally { await server.stop(); }
    });
    if (humain) await check('humain-local-transcription', async () => {
      const result = await command('humain-local-transcription', ['env',
        `HUMAIN_SEASHELL_CLI=${join(root, 'seashell')}`, 'node', humain!, 'transcribe', wav,
        '--store', join(output, 'humain-runs'), '--run-id', 'gym-local-transcription']);
      const artifact = JSON.parse(result);
      if (artifact.status !== 'succeeded' || artifact.output?.provider?.boundary !== 'local') throw new Error('Humain local contract failed');
      assertSpeech(artifact.output.segments.map((s: { text: string }) => s.text).join(' '));
    });
  }
  console.log(`PASS: ${results.length} checks. ${join(output, 'report.md')}`);
} catch (error) {
  console.error(`${String(error)}\nEvidence: ${join(output, 'report.md')}`);
  process.exitCode = 1;
}
