import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkComputerAudio, type LevelSource } from '../src/audio-levels.ts';
import { computerAudioConfirmed } from '../src/audio-checks.ts';
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

test('when the own identity sends only silence, the recording switches to inherited and keeps every chunk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-identity-silent-'));
  const fake = fakeHelper(root, `if (own) {${sound(0)}} else {${sound(8000)}}`);
  const chunks: SystemAudioChunk[] = [];
  const gaps: number[] = [];
  const states: SystemAudioStateUpdate[] = [];
  const warnings: string[] = [];
  let refused = 0;
  const capture = startSystemAudioCapture({ helperPath: process.execPath, helperArgs: [fake.path], identity: 'own', ownSilenceMs: 400,
    sessionStartedAtUnixMs: Date.now(), chunkMilliseconds: 200, minimumChunkMilliseconds: 20,
    onChunk: (chunk) => chunks.push(chunk), onState: (state) => states.push(state), onDiscontinuity: (gap) => gaps.push(gap.durationFrames),
    onWarning: (message) => warnings.push(message), onOwnIdentityRefused: () => { refused++; } });
  try {
    await until(() => chunks.some((chunk) => chunk.audible));
    expect(fake.launches().map((args) => args.includes('--no-disclaim'))).toEqual([false, true]);
    expect(warnings).toEqual([OWN_IDENTITY_WARNINGS.silence]);
    // Silence may only be a quiet start, so the confirmation is kept for the next call.
    expect(refused).toBe(0);
    expect(chunks.filter((chunk) => !chunk.audible).length).toBeGreaterThanOrEqual(2);
    expect(states.some((state) => state.state === 'unavailable' || state.state === 'stopped')).toBe(false);
    expect(gaps).toHaveLength(1);
  } finally { capture.stop(); await capture.done; rmSync(root, { recursive: true, force: true }); }
  expect(states.at(-1)?.state).toBe('stopped');
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
