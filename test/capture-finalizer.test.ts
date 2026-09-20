import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assembleCaptureTrack,
  finalizeCaptureTranscript,
  reconcileCaptureEcho,
} from '../src/capture-finalizer.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';

function wav(directory: string, name: string, sample: number): string {
  const path = join(directory, name);
  const pcm = Buffer.alloc(3_200);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(sample, offset);
  writeFileSync(path, pcmS16leToWav(pcm));
  return path;
}

for (const boundary of ['local', 'remote'] as const) {
  for (const damage of ['modified', 'truncated'] as const) {
    test(`${boundary} finalization rejects ${damage} committed audio before producing a result`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'seashell-capture-integrity-'));
      try {
        const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'integrity', startedAtUnixMs: 1 });
        store.commitChunk({ sourcePath: wav(root, 'good.wav', 100), trackId: 'microphone',
          startSeconds: 0, endSeconds: 0.1, audible: true });
        const chunk = store.commitChunk({ sourcePath: wav(root, 'damaged.wav', 200), trackId: 'microphone',
          startSeconds: 0.1, endSeconds: 0.2, audible: true });
        const data = readFileSync(chunk.path);
        data[44] = data[44]! ^ 0xff;
        writeFileSync(chunk.path, damage === 'truncated' ? data.subarray(0, data.length - 2) : data);
        if (boundary === 'local') {
          const output = join(root, 'assembled.wav');
          expect(() => assembleCaptureTrack(store.manifestPath, store.manifest, 'microphone', output))
            .toThrow('Capture chunk integrity check failed');
          expect(existsSync(output)).toBe(false);
          expect(existsSync(`${output}.partial`)).toBe(false);
        } else {
          let calls = 0;
          await expect(finalizeCaptureTranscript(store.manifestPath, {
            remoteRoute: { model: 'fixture', uploadConsent: true },
            remoteTranscriber: async () => {
              calls += 1;
              return { runId: 'fixture', compiledRunId: 'fixture', status: 'succeeded', receipt: {},
                output: { provider: { boundary: 'remote', model: 'fixture' }, segments: [] } };
            },
          })).rejects.toThrow('Capture chunk integrity check failed');
          expect(calls).toBe(0);
        }
        expect(existsSync(chunk.path)).toBe(true);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

test('capture finalizer assembles chunks on their session clock and preserves gaps', () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-finalizer-'));
  const sources = mkdtempSync(join(tmpdir(), 'seashell-finalizer-source-'));
  const store = new CaptureSessionStore({ libraryDir, sessionId: 'finalize-1', startedAtUnixMs: 1 });
  store.commitChunk({
    sourcePath: wav(sources, 'one.wav', 100),
    trackId: 'microphone',
    startSeconds: 0,
    endSeconds: 0.1,
    audible: true,
  });
  store.commitChunk({
    sourcePath: wav(sources, 'two.wav', 200),
    trackId: 'microphone',
    startSeconds: 0.2,
    endSeconds: 0.3,
    audible: true,
  });
  const output = join(sources, 'track.wav');
  expect(assembleCaptureTrack(store.manifestPath, store.manifest, 'microphone', output)).toBe(output);
  const result = readFileSync(output);
  expect(result.readUInt32LE(40)).toBe(9_600);
  expect(result.readInt16LE(44)).toBe(100);
  expect(result.readInt16LE(44 + 3_200)).toBe(0);
  expect(result.readInt16LE(44 + 6_400)).toBe(200);
});

test('final capture echo reconciliation preserves remote speaker identities', () => {
  const microphone = {
    start: 1,
    end: 4,
    text: 'ask what you can do for your country',
    speaker: 'LOCAL',
  };
  const remote = {
    start: 1.2,
    end: 4.2,
    text: 'ask what you can do for your country',
    speaker: 'REMOTE_SPEAKER_00',
  };
  expect(reconcileCaptureEcho([microphone], remote)).toEqual([remote]);
  expect(reconcileCaptureEcho([remote], microphone)).toEqual([remote]);
});

test('remote finalization rebases chunk timestamps without assembling full tracks', async () => {
  const libraryDir = mkdtempSync(join(tmpdir(), 'seashell-remote-finalizer-'));
  const sources = mkdtempSync(join(tmpdir(), 'seashell-remote-finalizer-source-'));
  const store = new CaptureSessionStore({
    libraryDir,
    sessionId: 'remote-finalize-1',
    startedAtUnixMs: 1,
  });
  store.commitChunk({
    sourcePath: wav(sources, 'mic.wav', 100),
    trackId: 'microphone',
    startSeconds: 0.2,
    endSeconds: 0.3,
    audible: true,
  });
  store.commitChunk({
    sourcePath: wav(sources, 'system.wav', 200),
    trackId: 'system-audio',
    startSeconds: 1,
    endSeconds: 1.1,
    audible: true,
  });
  const statuses: string[] = [];
  const record = await finalizeCaptureTranscript(store.manifestPath, {
    remoteRoute: { model: 'openai/whisper-large-v3-turbo', uploadConsent: true },
    remoteTranscriber: async (path) => ({
      runId: `run-${path}`,
      compiledRunId: 'compiled',
      status: 'succeeded',
      output: {
        segments: [{
          id: 's000001',
          startMs: 25,
          endMs: 75,
          text: path.includes('microphone') ? 'local words' : 'remote words',
        }],
        provider: { boundary: 'remote', model: 'openai/whisper-large-v3-turbo' },
      },
      receipt: {},
    }),
    onStatus: (status) => statuses.push(status),
  });
  expect(record.transcript).toEqual([
    { id: 's000001', start: 0.225, end: 0.275, text: 'local words', speaker: 'LOCAL' },
    { id: 's000002', start: 1.025, end: 1.075, text: 'remote words', speaker: 'SYSTEM' },
  ]);
  expect(statuses.some((status) => status.startsWith('Assembling'))).toBe(false);
});
