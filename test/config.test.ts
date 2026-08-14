import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, resolveMeetingRoute, updateMeetingConfig } from '../src/config.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('role-specific routes override the shared fallback without inventing a model', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-config-routes-'));
  roots.push(root);
  const path = join(root, 'config.json');
  const config = updateMeetingConfig({
    backend: 'codex',
    model: 'shared-model',
    routes: {
      observer: { backend: 'openrouter', model: 'cheap-observer' },
      reconciliation: { backend: 'claude-code', model: 'strong-reconciler' },
    },
  }, path);

  expect(resolveMeetingRoute(config.meeting, 'observer')).toMatchObject({
    backend: 'openrouter', model: 'cheap-observer',
  });
  expect(resolveMeetingRoute(config.meeting, 'reconciliation')).toMatchObject({
    backend: 'claude-code', model: 'strong-reconciler',
  });
  expect(resolveMeetingRoute(config.meeting, 'chat')).toMatchObject({
    backend: 'codex', model: 'shared-model',
  });
  expect(() => resolveMeetingRoute({ backend: 'codex' }, 'chat'))
    .toThrow('requires both backend and model');
  expect(() => resolveMeetingRoute(config.meeting, 'observer', { backend: 'codex' }))
    .toThrow('requires both backend and model');
  expect(resolveMeetingRoute(config.meeting, 'observer', {
    backend: 'codex', model: 'one-off-model',
  })).toMatchObject({ backend: 'codex', model: 'one-off-model' });
});

test('meeting setup preserves unrelated config and stores route metadata without secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-config-test-'));
  roots.push(root);
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify({ libraryDir: './library', futureSetting: true }));
  const config = updateMeetingConfig({
    backend: 'openrouter',
    model: 'test/cheap',
    mode: 'hybrid',
    calendar: { enabled: true, policy: 'ask' },
  }, path);
  expect(config.meeting).toMatchObject({
    backend: 'openrouter',
    model: 'test/cheap',
    mode: 'hybrid',
  });
  expect(loadConfig(path).libraryDir).toBe('./library');
  const raw = readFileSync(path, 'utf8');
  expect(raw).toContain('futureSetting');
  expect(raw).not.toContain('apiKey');
});

test('transcription routing config requires an exact consent-bearing cloud route', () => {
  const directory = mkdtempSync(join(tmpdir(), 'seashell-transcription-config-'));
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({
    transcription: {
      mode: 'adaptive',
      canonicalFinal: 'local',
      adaptiveCloudQueueDepth: 3,
      cloud: {
        model: 'openai/whisper-large-v3-turbo',
        upstreamProvider: 'groq',
        maxCostMicrousd: 100000,
        uploadConsent: true,
      },
    },
  }));
  expect(loadConfig(path).transcription).toEqual({
    mode: 'adaptive',
    canonicalFinal: 'local',
    adaptiveCloudQueueDepth: 3,
    cloud: {
      model: 'openai/whisper-large-v3-turbo',
      upstreamProvider: 'groq',
      maxCostMicrousd: 100000,
      uploadConsent: true,
    },
  });
  writeFileSync(path, JSON.stringify({
    transcription: { mode: 'cloud', cloud: { model: 'model', uploadConsent: 'yes' } },
  }));
  expect(() => loadConfig(path)).toThrow('uploadConsent must be a boolean');
});
