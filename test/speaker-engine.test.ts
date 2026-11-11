import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { updateSpeakerEngine } from '../src/config.ts';
import { diarizationStatus } from '../src/diarization-environment.ts';
import { setupDiarization } from '../src/diarization-setup.ts';
import { runSpeakerSeparation } from '../src/diarize.ts';
import { parseCliArgs } from '../src/cli-args.ts';
import { helperModelLabel, nativeSpeakerStatus, speakerEngine } from '../src/speaker-engine.ts';

const keys = ['SEASHELL_SPEAKERS_HELPER', 'SEASHELL_SPEAKER_ENGINE', 'SEASHELL_CONFIG', 'SEASHELL_DIARIZATION_HOME'] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const directories: string[] = [];
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A stand-in for native/bin/seashell-speakers: records its arguments, answers like the real one. */
function fakeHelper(options: { ready?: boolean; prepareFails?: boolean; nemotron?: boolean; output?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'seashell-speakers-helper-'));
  directories.push(directory);
  const helper = join(directory, 'seashell-speakers');
  const log = join(directory, 'calls');
  const marker = join(directory, 'ready');
  if (options.ready) writeFileSync(marker, '');
  writeFileSync(helper, `#!/bin/bash
echo "$*" >> ${JSON.stringify(log)}
case "$1" in
  --status) if [ -f ${JSON.stringify(marker)} ]; then echo '{"ready":true,"directory":"/models"${options.nemotron ? ',"nemotron":true' : ''}}'; else echo '{"ready":false}'; fi ;;
  --prepare) ${options.prepareFails ? 'exit 1' : `touch ${JSON.stringify(marker)}; echo '{"ready":true}'`} ;;
  *) echo "Separating speakers…" >&2
     echo '${options.output ?? '{"model":"m","device":"ane","channels":2,"turns":[{"start":0,"end":1.5,"speaker":"REMOTE_00","role":"remote"}],"speakers":[{"id":"LOCAL","label":"local"},{"id":"REMOTE_00","label":"remote 1"}]}'}' ;;
esac
`);
  chmodSync(helper, 0o755);
  process.env.SEASHELL_SPEAKERS_HELPER = helper;
  process.env.SEASHELL_CONFIG = join(directory, 'config.json');
  process.env.SEASHELL_DIARIZATION_HOME = join(directory, 'home');
  delete process.env.SEASHELL_SPEAKER_ENGINE;
  return { helper, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}

test('auto is the default wherever its helper exists; config or the environment can choose one engine', () => {
  fakeHelper();
  expect(speakerEngine()).toBe('auto');
  writeFileSync(process.env.SEASHELL_CONFIG!, JSON.stringify({ speakers: { engine: 'pyannote' } }));
  expect(speakerEngine()).toBe('pyannote');
  process.env.SEASHELL_SPEAKER_ENGINE = 'native';
  expect(speakerEngine()).toBe('native');
  process.env.SEASHELL_SPEAKERS_HELPER = '/nonexistent/seashell-speakers';
  delete process.env.SEASHELL_SPEAKER_ENGINE;
  writeFileSync(process.env.SEASHELL_CONFIG!, '{}');
  expect(speakerEngine()).toBe('pyannote');
});

test('readiness asks the helper, offline, whether its models are on disk', () => {
  fakeHelper();
  expect(nativeSpeakerStatus().ready).toBe(false);
  expect(diarizationStatus()).toMatchObject({ ready: false, engine: 'auto' });
  expect(diarizationStatus().nextStep).toContain('211 MB');
  // Without the Nemotron 3 models auto is community-1 alone, and says so.
  fakeHelper({ ready: true });
  expect(diarizationStatus()).toMatchObject({ ready: true, engine: 'auto', model: 'pyannote community-1 · Core ML (FluidAudio)' });
  fakeHelper({ ready: true, nemotron: true });
  expect(diarizationStatus().model).toContain('Nemotron 3 checked by pyannote community-1');
  process.env.SEASHELL_SPEAKER_ENGINE = 'native';
  expect(diarizationStatus().nextStep).toBeUndefined();
  expect(diarizationStatus().model).toBe('pyannote community-1 · Core ML (FluidAudio)');
});

test('setup downloads the models through the helper, with no Python and no login', async () => {
  const helper = fakeHelper();
  const result = await setupDiarization({ login: false, check: false, onStatus: () => {} });
  expect(result).toMatchObject({ ready: true, stage: 'ready' });
  expect(result.loginCommand).toBeUndefined();
  expect(helper.calls()).toEqual(['--prepare', '--status']);
  fakeHelper({ prepareFails: true });
  await expect(setupDiarization({ login: false, check: false, onStatus: () => {} })).rejects.toThrow('Could not download the speaker models');
});

test('separation runs the helper with the same arguments and JSON as the Python script', async () => {
  const helper = fakeHelper({ ready: true });
  const messages: string[] = [];
  const result = await runSpeakerSeparation('/tmp/meeting.wav', {
    channelRoles: ['local', 'remote'], maxSpeakers: 5, onDiarizationMessage: (message) => messages.push(message),
  });
  expect(helper.calls()).toEqual(['/tmp/meeting.wav --channel-roles local,remote --max-speakers 5']);
  expect(result.turns).toEqual([{ start: 0, end: 1.5, speaker: 'REMOTE_00', role: 'remote' }]);
  expect(result.speakers.map((speaker) => speaker.id)).toEqual(['LOCAL', 'REMOTE_00']);
  expect(messages.join('\n')).toContain('Separating speakers');
});

test('Nemotron 3 is asked for by name, and its own models decide whether it is ready', async () => {
  const { calls } = fakeHelper({ ready: true });
  process.env.SEASHELL_SPEAKER_ENGINE = 'nemotron3';
  expect(speakerEngine()).toBe('nemotron3');
  expect(diarizationStatus()).toMatchObject({ ready: true, engine: 'nemotron3', model: expect.stringContaining('Nemotron 3') });
  expect(calls()).toContain('--status --engine nemotron3');
  await runSpeakerSeparation('/tmp/call.wav', {}).catch(() => undefined);
  expect(calls()).toContain('/tmp/call.wav --engine nemotron3');
});

test('a config can choose Nemotron 3, and anything else is refused', () => {
  fakeHelper({ ready: true });
  const config = process.env.SEASHELL_CONFIG!;
  writeFileSync(config, JSON.stringify({ saveByDefault: false }));
  updateSpeakerEngine('nemotron3', config);
  expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ saveByDefault: false, speakers: { engine: 'nemotron3' } });
  expect(speakerEngine()).toBe('nemotron3');
  updateSpeakerEngine('auto', config);
  expect(speakerEngine()).toBe('auto');
  writeFileSync(config, JSON.stringify({ speakers: { engine: 'whisper' } }));
  expect(speakerEngine()).toBe('auto');
});

test('seashell speakers use takes auto, community-1 or nemotron3, and community-1 alone names its engine', async () => {
  expect(parseCliArgs(['speakers', 'use', 'auto'])).toMatchObject({ kind: 'speaker-use', engine: 'auto' });
  expect(parseCliArgs(['speakers', 'use', 'community-1'])).toMatchObject({ kind: 'speaker-use', engine: 'native' });
  expect(() => parseCliArgs(['speakers', 'use', 'whisper'])).toThrow('auto|nemotron3|community-1');
  const { calls } = fakeHelper({ ready: true });
  process.env.SEASHELL_SPEAKER_ENGINE = 'native';
  await runSpeakerSeparation('/tmp/call.wav', {});
  // auto is the helper's default, so only a single engine is named.
  expect(calls()).toContain('/tmp/call.wav --engine community-1');
});

test('separation reports the model the helper used, and each voice with its turns', async () => {
  const voice = Array.from({ length: 4 }, (_, index) => (index === 0 ? 1 : 0));
  fakeHelper({ ready: true, output: JSON.stringify({
    model: 'nvidia/nemotron-3-diarization (fast128, Core ML via FluidAudio)', device: 'ane', channels: 1,
    turns: [{ start: 0, end: 4, speaker: 'SPEAKER_00' }, { start: 5, end: 9, speaker: 'SPEAKER_01' }, { start: 10, end: 12, speaker: 'SPEAKER_00' }],
    speakers: [{ id: 'SPEAKER_00', label: 'SPEAKER_00' }, { id: 'SPEAKER_01', label: 'SPEAKER_01' }],
    voices: { SPEAKER_00: { embedding: voice, seconds: 6 }, SPEAKER_01: { embedding: ['bad'], seconds: 4 } },
  }) });
  const result = await runSpeakerSeparation('/tmp/call.wav', {});
  expect(result.model).toBe('NVIDIA Nemotron 3 · Core ML (FluidAudio)');
  // A malformed voice is dropped, not the meeting.
  expect([...result.voices!.keys()]).toEqual(['SPEAKER_00']);
  expect(result.voices!.get('SPEAKER_00')).toEqual({ embedding: voice, seconds: 6, spans: [[0, 4], [10, 12]] });
  expect(helperModelLabel('fluidaudio/speaker-diarization-coreml (pyannote community-1) and nvidia/nemotron-3-diarization (fast128)'))
    .toBe('pyannote community-1 · Core ML (FluidAudio) and NVIDIA Nemotron 3 · Core ML (FluidAudio)');
});
