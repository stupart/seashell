import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkComputerAudio, type LevelSource } from '../src/audio-levels.ts';
import {
  computerAudioConfirmed, countSilentOwnStart, forgetAudioCheck, readAudioChecks, rememberAudioCheck,
  rememberInheritedComputerAudio, resetSilentOwnStarts,
} from '../src/audio-checks.ts';
import {
  OWN_IDENTITY_WARNINGS,
  startSystemAudioCapture,
  systemAudioIdentity,
  type SystemAudioChunk,
  type SystemAudioStateUpdate,
} from '../src/live-system-audio.ts';

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

/** A pretend helper that logs its arguments; the body decides what it does, per attempt and identity. */
function fakeHelper(root: string, body: string) {
  const path = join(root, 'helper.ts');
  const log = join(root, 'launches');
  writeFileSync(log, '');
  writeFileSync(path, `
import { appendFileSync, readFileSync } from 'fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const own = !process.argv.includes('--no-disclaim');
const attempt = readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;
const event = value => process.stderr.write(JSON.stringify(value) + '\\n');
${body}
`);
  return { path, launches: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) };
}

const sound = (level: number) => `
event({ type: 'first-buffer', capturedAtUnixMs: Date.now(), bufferStartUnixMs: Date.now() });
const pcm = Buffer.alloc(3200); for (let i = 0; i < 1600; i++) pcm.writeInt16LE(i % 2 ? ${level} : -${level}, i * 2);
setInterval(() => process.stdout.write(pcm), 100);`;

test('the recorder keeps the inherited permission until a check confirms the helper\'s own', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-identity-'));
  try {
    const runtime = join(root, 'Seashell System Audio');
    writeFileSync(runtime, '');
    const installed = new Date('2026-11-10T12:00:00Z');
    utimesSync(runtime, installed, installed);
    // Never checked: inherited, which the background recorder already has permission for.
    expect(systemAudioIdentity(runtime, { runtimeHelper: runtime, checks: {} })).toBe('inherited');
    // Checked with an older copy of the helper: macOS may need asking again.
    expect(systemAudioIdentity(runtime, { runtimeHelper: runtime, checks: { computer: '2026-11-09T12:00:00Z' } })).toBe('inherited');
    // Checked at the Mac with the copy installed now: its own identity.
    expect(systemAudioIdentity(runtime, { runtimeHelper: runtime, checks: { computer: '2026-11-10T13:00:00Z' } })).toBe('own');
    // Any other copy never holds the permission the check confirmed.
    expect(systemAudioIdentity(join(root, 'elsewhere'), { runtimeHelper: runtime, checks: { computer: '2026-11-10T13:00:00Z' } })).toBe('inherited');
    expect(computerAudioConfirmed({ computer: '2026-11-10T13:00:00Z' }, undefined)).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unconfirmed records inherited, and confirmed records with its own identity', async () => {
  for (const identity of ['inherited', 'own'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'seashell-identity-start-'));
    const fake = fakeHelper(root, sound(8000));
    const chunks: SystemAudioChunk[] = [];
    const warnings: string[] = [];
    const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], identity,
      sessionStartedAtUnixMs: Date.now(), chunkMilliseconds: 200, minimumChunkMilliseconds: 20,
      onChunk: (chunk) => chunks.push(chunk), onState() {}, onWarning: (message) => warnings.push(message) });
    try {
      await until(() => chunks.length >= 2);
      expect(fake.launches()).toHaveLength(1);
      expect(fake.launches()[0]!.includes('--no-disclaim')).toBe(identity === 'inherited');
      expect(warnings).toEqual([]);
    } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
  }
});

test('when macOS refuses the own identity, the recording goes on inherited and says so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-identity-refused-'));
  // Its own identity is refused; inherited works.
  const fake = fakeHelper(root, `if (own) { event({ type: 'error', code: 'permission_denied', message: 'Not allowed' }); process.exit(1); }
${sound(8000)}`);
  const chunks: SystemAudioChunk[] = [];
  const states: SystemAudioStateUpdate[] = [];
  const warnings: string[] = [];
  let refused = 0;
  const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], identity: 'own',
    sessionStartedAtUnixMs: Date.now(), chunkMilliseconds: 200, minimumChunkMilliseconds: 20, restartDelayMs: 10,
    onChunk: (chunk) => chunks.push(chunk), onState: (state) => states.push(state),
    onWarning: (message) => warnings.push(message), onOwnIdentityRefused: () => { refused++; } });
  try {
    await until(() => chunks.length >= 2);
    expect(fake.launches().map((args) => args.includes('--no-disclaim'))).toEqual([false, true]);
    expect(warnings).toEqual([OWN_IDENTITY_WARNINGS.refused]);
    expect(refused).toBe(1);
    // The recording never reported computer audio as unavailable: nothing upstream gives up on it.
    expect(states.some((state) => state.state === 'unavailable')).toBe(false);
    expect(chunks.every((chunk) => chunk.audible)).toBe(true);
  } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
});

/** A made-up history of earlier recordings, as audio-checks.json keeps it. */
function history(inheritedHeard = false) {
  const value = { inheritedHeard, silentStarts: 0, inheritedNoted: 0,
    noteInheritedHeard() { value.inheritedNoted++; },
    noteOwnHeard() { value.silentStarts = 0; },
    noteOwnSilent() { return ++value.silentStarts; } };
  return value;
}

test('when the own identity hears only silence and the inherited one then hears the call, macOS refused it: the check goes, said once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-identity-silent-'));
  const fake = fakeHelper(root, `if (own) {${sound(0)}} else {${sound(8000)}}`);
  const chunks: SystemAudioChunk[] = [];
  const gaps: number[] = [];
  const states: SystemAudioStateUpdate[] = [];
  const warnings: string[] = [];
  const past = history();
  let refused = 0;
  const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], identity: 'own', ownSilenceMs: 400,
    sessionStartedAtUnixMs: Date.now(), chunkMilliseconds: 200, minimumChunkMilliseconds: 20, identityHistory: past,
    onChunk: (chunk) => chunks.push(chunk), onState: (state) => states.push(state), onDiscontinuity: (gap) => gaps.push(gap.durationFrames),
    onWarning: (message) => warnings.push(message), onOwnIdentityRefused: () => { refused++; } });
  try {
    await until(() => chunks.filter((chunk) => chunk.audible).length >= 3);
    expect(fake.launches().map((args) => args.includes('--no-disclaim'))).toEqual([false, true]);
    // The call was audible all along: the next recording starts inherited.
    expect(refused).toBe(1);
    expect(warnings).toEqual([OWN_IDENTITY_WARNINGS.refused]);
    expect(past.silentStarts).toBe(0);
    expect(past.inheritedNoted).toBe(1);
    expect(chunks.filter((chunk) => !chunk.audible).length).toBeGreaterThanOrEqual(2);
    expect(states.some((state) => state.state === 'unavailable' || state.state === 'stopped')).toBe(false);
    expect(gaps).toHaveLength(1);
  } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
  expect(states.at(-1)?.state).toBe('stopped');
});

test('a quiet start through both identities says nothing, and the second recording in a row like it sets the own identity aside', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-identity-lobby-'));
  // A lobby: nobody talks, whoever's permission records it.
  const fake = fakeHelper(root, sound(0));
  const past = history();
  const warnings: string[] = [];
  let refused = 0;
  for (const recording of [1, 2]) {
    const chunks: SystemAudioChunk[] = [];
    const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], identity: 'own',
      ownSilenceMs: 400, inheritedVerdictMs: 400, identityHistory: past,
      sessionStartedAtUnixMs: Date.now(), chunkMilliseconds: 200, minimumChunkMilliseconds: 20,
      onChunk: (chunk) => chunks.push(chunk), onState() {},
      onWarning: (message) => warnings.push(message), onOwnIdentityRefused: () => { refused++; } });
    try {
      await until(() => past.silentStarts === recording);
      expect(fake.launches().slice(-2).map((args) => args.includes('--no-disclaim'))).toEqual([false, true]);
      // No false "refused" or "silence" warning for a lobby.
      expect(warnings).toEqual([]);
      expect(refused).toBe(recording === 2 ? 1 : 0);
    } finally { capture.stop(); await capture.done; }
  }
  rmSync(root, { recursive: true, force: true });
});

test('sound through the own identity clears the silent starts before it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-identity-heard-'));
  const fake = fakeHelper(root, sound(8000));
  const past = history();
  past.silentStarts = 1;
  const chunks: SystemAudioChunk[] = [];
  const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], identity: 'own', identityHistory: past,
    sessionStartedAtUnixMs: Date.now(), chunkMilliseconds: 200, minimumChunkMilliseconds: 20,
    onChunk: (chunk) => chunks.push(chunk), onState() {} });
  try {
    await until(() => chunks.length >= 2);
    expect(past.silentStarts).toBe(0);
  } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
});

test('the own identity hands over after 20 s of silence, not a minute, once the inherited one is known to record', async () => {
  for (const inheritedHeard of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'seashell-identity-window-'));
    // A second of audio every 20 ms: a minute of call in about a second.
    const fake = fakeHelper(root, `
event({ type: 'first-buffer', capturedAtUnixMs: Date.now(), bufferStartUnixMs: Date.now() });
const pcm = Buffer.alloc(32000); if (!own) for (let i = 0; i < 16000; i++) pcm.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
setInterval(() => process.stdout.write(pcm), 20);`);
    const chunks: SystemAudioChunk[] = [];
    const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], identity: 'own',
      identityHistory: history(inheritedHeard), sessionStartedAtUnixMs: Date.now(), chunkMilliseconds: 1_000,
      onChunk: (chunk) => chunks.push(chunk), onState() {}, onWarning() {} });
    try {
      await until(() => chunks.some((chunk) => chunk.audible));
      // Seconds of silence the own identity was given before handing over.
      expect(chunks.findIndex((chunk) => chunk.audible)).toBe(inheritedHeard ? 20 : 60);
    } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
  }
});

test('the history of silent starts and inherited sound is kept beside the settings, and a new check starts it again', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-identity-history-'));
  const env = { SEASHELL_CONFIG: join(root, 'config.json') };
  try {
    expect(readAudioChecks(env)).toEqual({});
    rememberAudioCheck('computer', new Date('2026-11-10T13:00:00Z'), env);
    rememberInheritedComputerAudio('/made-up/Seashell Background:1:2', new Date('2026-11-10T14:00:00Z'), env);
    expect(countSilentOwnStart(env)).toBe(1);
    expect(countSilentOwnStart(env)).toBe(2);
    rememberAudioCheck('microphone', new Date('2026-11-10T15:00:00Z'), env);
    expect(readAudioChecks(env)).toEqual({ computer: '2026-11-10T13:00:00.000Z', microphone: '2026-11-10T15:00:00.000Z',
      computerInherited: '2026-11-10T14:00:00.000Z', computerInheritedBy: '/made-up/Seashell Background:1:2', computerSilentStarts: 2 });
    resetSilentOwnStarts(env);
    expect(readAudioChecks(env).computerSilentStarts).toBeUndefined();
    expect(countSilentOwnStart(env)).toBe(1);
    // A fresh check, or forgetting one, starts the count again; the inherited sound is still known.
    rememberAudioCheck('computer', new Date('2026-11-10T16:00:00Z'), env);
    expect(readAudioChecks(env).computerSilentStarts).toBeUndefined();
    countSilentOwnStart(env);
    forgetAudioCheck('computer', env);
    expect(readAudioChecks(env)).toEqual({ microphone: '2026-11-10T15:00:00.000Z', computerInherited: '2026-11-10T14:00:00.000Z',
      computerInheritedBy: '/made-up/Seashell Background:1:2' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the one-time check passes on hearing the sound it plays, and remembers it', async () => {
  let level = -90;
  let played = 0;
  let remembered = 0;
  const source: LevelSource = ({ onLevel }) => {
    const timer = setInterval(() => onLevel({ peak: level > -90 ? 9000 : 0, rms: 0, rmsDbfs: level }), 20);
    return () => clearInterval(timer);
  };
  const heard = await checkComputerAudio({ source, play: () => { played++; level = -20; }, remember: () => { remembered++; } });
  expect(heard).toMatchObject({ heard: true, refused: false });
  expect(played).toBeGreaterThanOrEqual(1);
  expect(remembered).toBe(1);

  const refusedSource: LevelSource = ({ onProblem }) => { onProblem({ kind: 'permission', message: 'Not allowed' }); return () => {}; };
  const refused = await checkComputerAudio({ source: refusedSource, play: () => {}, remember: () => { remembered++; } });
  expect(refused).toMatchObject({ heard: false, refused: true });
  expect(refused.detail).toContain('Seashell System Audio');
  expect(refused.detail).toContain('Meetings keep recording');

  level = -90;
  const silent = await checkComputerAudio({ source, play: () => {}, timeoutMs: 200, remember: () => { remembered++; } });
  expect(silent).toMatchObject({ heard: false, refused: false });
  expect(remembered).toBe(1);
});
