import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { diarizationStatus } from '../src/diarization-environment.ts';
import { setupDiarization } from '../src/diarization-setup.ts';
import { runSpeakerSeparation } from '../src/diarize.ts';
import { nativeSpeakerStatus, speakerEngine } from '../src/speaker-engine.ts';

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
function fakeHelper(options: { ready?: boolean; prepareFails?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'seashell-speakers-helper-'));
  directories.push(directory);
  const helper = join(directory, 'seashell-speakers');
  const log = join(directory, 'calls');
  const marker = join(directory, 'ready');
  if (options.ready) writeFileSync(marker, '');
  writeFileSync(helper, `#!/bin/bash
echo "$*" >> ${JSON.stringify(log)}
case "$1" in
  --status) if [ -f ${JSON.stringify(marker)} ]; then echo '{"ready":true,"directory":"/models"}'; else echo '{"ready":false}'; fi ;;
  --prepare) ${options.prepareFails ? 'exit 1' : `touch ${JSON.stringify(marker)}; echo '{"ready":true}'`} ;;
  *) echo "Separating speakers…" >&2
     echo '{"model":"m","device":"ane","channels":2,"turns":[{"start":0,"end":1.5,"speaker":"REMOTE_00","role":"remote"}],"speakers":[{"id":"LOCAL","label":"local"},{"id":"REMOTE_00","label":"remote 1"}]}' ;;
esac
`);
  chmodSync(helper, 0o755);
  process.env.SEASHELL_SPEAKERS_HELPER = helper;
  process.env.SEASHELL_CONFIG = join(directory, 'config.json');
  process.env.SEASHELL_DIARIZATION_HOME = join(directory, 'home');
  delete process.env.SEASHELL_SPEAKER_ENGINE;
  return { helper, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}

test('native is the default wherever its helper exists; config or the environment can choose Python', () => {
  fakeHelper();
  expect(speakerEngine()).toBe('native');
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
  expect(diarizationStatus()).toMatchObject({ ready: false, engine: 'native' });
  expect(diarizationStatus().nextStep).toContain('21 MB');
  fakeHelper({ ready: true });
  expect(diarizationStatus()).toMatchObject({ ready: true, engine: 'native', model: expect.stringContaining('Core ML') });
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
