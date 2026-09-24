import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { diarizationEnvironment, diarizationStatus, fileStamp, modelArtifacts, resolveDiarizationPython } from '../src/diarization-environment.ts';
import { seashellCapabilityManifest } from '../src/capabilities.ts';
import { setupDiarization } from '../src/diarization-setup.ts';

const envKeys = ['SEASHELL_DIARIZATION_HOME', 'SEASHELL_DIARIZATION_PYTHON', 'SEASHELL_PYTHON', 'SEASHELL_DIARIZATION_MODEL', 'HF_HUB_CACHE'] as const;
const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const directories: string[] = [];
afterEach(() => {
  for (const key of envKeys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'seashell-speaker-setup-'));
  directories.push(directory);
  for (const key of envKeys) delete process.env[key];
  process.env.SEASHELL_DIARIZATION_HOME = join(directory, 'Application Support');
  process.env.HF_HUB_CACHE = join(directory, 'hub');
  return directory;
}

function verify() {
  const environment = diarizationEnvironment();
  mkdirSync(dirname(environment.verificationPath), { recursive: true });
  mkdirSync(join(environment.modelCache, 'snapshot'), { recursive: true });
  writeFileSync(join(environment.modelCache, 'snapshot', 'weights.bin'), 'fixture model');
  writeFileSync(environment.verificationPath, JSON.stringify({ version: 2, artifacts: modelArtifacts(environment.modelCache),
    pythonStamp: fileStamp(environment.python), modelStamp: fileStamp(environment.modelCache) }));
}

test('an empty model cache and Python executable do not establish readiness', () => {
  fixture();
  const environment = diarizationEnvironment();
  mkdirSync(dirname(environment.python), { recursive: true });
  writeFileSync(environment.python, 'python');
  mkdirSync(environment.modelCache, { recursive: true });
  expect(diarizationStatus().ready).toBe(false);
  expect(diarizationStatus().nextStep).toContain('seashell setup --speakers');
});

test('verified custom Python is shared by runtime and automatic-meeting capability discovery', () => {
  const directory = fixture();
  const python = join(directory, 'custom-python');
  process.env.SEASHELL_DIARIZATION_PYTHON = python;
  writeFileSync(python, 'python');
  mkdirSync(diarizationEnvironment().modelCache, { recursive: true });
  verify();
  expect(resolveDiarizationPython()).toBe(python);
  expect(resolveDiarizationPython('/explicit/python')).toBe('/explicit/python');
  expect(diarizationStatus().ready).toBe(true);
  expect(seashellCapabilityManifest().capabilities[0]!.optionalFeatures[0]!.ready).toBe(true);
  rmSync(python);
  expect(diarizationStatus().ready).toBe(false);
});

test('managed installation survives a release directory change, but model and cache changes require verification', () => {
  fixture();
  const environment = diarizationEnvironment();
  mkdirSync(dirname(environment.managedPython), { recursive: true });
  writeFileSync(environment.managedPython, 'python');
  mkdirSync(environment.modelCache, { recursive: true });
  verify();
  expect(resolveDiarizationPython()).toBe(environment.managedPython);
  expect(diarizationStatus().ready).toBe(true);
  process.env.SEASHELL_DIARIZATION_MODEL = 'another/model';
  expect(diarizationStatus().ready).toBe(false);
  delete process.env.SEASHELL_DIARIZATION_MODEL;
  rmSync(environment.modelCache, { recursive: true });
  expect(diarizationStatus().ready).toBe(false);
});

test('failed offline verification invalidates a previous receipt and returns an actionable login command', async () => {
  const directory = fixture();
  const python = join(directory, 'custom environment', 'python');
  mkdirSync(dirname(python), { recursive: true });
  process.env.SEASHELL_DIARIZATION_PYTHON = python;
  // A subprocess protocol fixture, not a real model-quality test.
  writeFileSync(python, '#!/bin/sh\nprintf \'%s\\n\' \'{"ready":false,"stage":"model","detail":"Model unavailable"}\'\n');
  chmodSync(python, 0o755);
  mkdirSync(diarizationEnvironment().modelCache, { recursive: true });
  verify();
  expect(diarizationStatus().ready).toBe(true);
  const result = await setupDiarization({ check: true, login: false });
  expect(result.ready).toBe(false);
  expect(result.loginCommand).toContain("custom environment/hf' auth login");
  expect(diarizationStatus().ready).toBe(false);
});

test('removing nested model weights invalidates a successful check', () => {
  fixture();
  const environment = diarizationEnvironment();
  mkdirSync(dirname(environment.python), { recursive: true });
  writeFileSync(environment.python, 'python');
  mkdirSync(environment.modelCache, { recursive: true });
  verify();
  expect(diarizationStatus().ready).toBe(true);
  rmSync(join(environment.modelCache, 'snapshot', 'weights.bin'));
  expect(diarizationStatus().ready).toBe(false);
});

test('cancelled setup stops its child and releases the setup lock', async () => {
  const directory = fixture();
  const python = join(directory, 'slow-python');
  process.env.SEASHELL_DIARIZATION_PYTHON = python;
  writeFileSync(python, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(python, 0o755);
  const controller = new AbortController();
  const pending = setupDiarization({ check: true, login: false, signal: controller.signal, onStatus() {} });
  await Bun.sleep(50);
  await expect(setupDiarization({ check: true, login: false })).rejects.toThrow('already running');
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(diarizationStatus().ready).toBe(false);
});
