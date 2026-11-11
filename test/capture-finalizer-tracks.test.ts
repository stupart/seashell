import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { finalizeCaptureTranscript } from '../src/capture-finalizer.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { concurrentTrackTranscription, type TranscriptionHardware } from '../src/local-asr-profile.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One second of tone on each track, so both count as audible. */
function capture(): string {
  const root = mkdtempSync(join(tmpdir(), 'seashell-final-tracks-'));
  roots.push(root);
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'two-tracks', startedAtUnixMs: 1 });
  for (const trackId of ['microphone', 'system-audio'] as const) {
    const pcm = Buffer.alloc(32_000);
    for (let index = 0; index < 16_000; index++) pcm.writeInt16LE(Math.round(Math.sin(index / 6) * 12_000), index * 2);
    const source = join(root, `${trackId}.wav`);
    writeFileSync(source, pcmS16leToWav(pcm));
    store.commitChunk({ sourcePath: source, trackId, startSeconds: 0, endSeconds: 1, audible: true });
  }
  return store.manifestPath;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function tracks(order: string[], microphoneDone: Promise<void>, failMicrophone = false) {
  return {
    localTranscriber: async (path: string) => {
      order.push('microphone started');
      await microphoneDone;
      expect(existsSync(path)).toBe(true);
      order.push('microphone finished');
      if (failMicrophone) throw new Error('Microphone pass failed');
      return [{ start: 0.2, end: 0.6, text: 'Made-up local words.' }];
    },
    systemDiarizer: async (path: string) => {
      order.push('system started');
      await Bun.sleep(5);
      // The microphone pass failing must not remove this track mid-pass.
      expect(existsSync(path)).toBe(true);
      order.push('system finished');
      return { transcript: [{ start: 0.1, end: 0.5, text: 'Made-up remote words.', speaker: 'SPEAKER_00' }],
        speakers: [{ id: 'SPEAKER_00', label: 'SPEAKER_00' }] };
    },
    diarizeSystemAudio: true,
  };
}

test('with room to spare, the microphone pass runs beside system audio and the transcript is unchanged', async () => {
  const manifestPath = capture();
  const order: string[] = [];
  const microphone = deferred();
  const finishing = finalizeCaptureTranscript(manifestPath, { ...tracks(order, microphone.promise), concurrentTracks: true });
  await Bun.sleep(20);
  expect(order).toEqual(['microphone started', 'system started', 'system finished']);
  microphone.resolve();
  const concurrent = await finishing;

  const sequentialOrder: string[] = [];
  const sequential = await finalizeCaptureTranscript(manifestPath, { ...tracks(sequentialOrder, Promise.resolve()), concurrentTracks: false });
  expect(sequentialOrder).toEqual(['microphone started', 'microphone finished', 'system started', 'system finished']);
  expect(concurrent.transcript).toEqual(sequential.transcript);
  expect(concurrent.speakers).toEqual(sequential.speakers);
  expect(concurrent.transcript.map((segment) => segment.speaker)).toEqual(['REMOTE_SPEAKER_00', 'LOCAL']);
});

test('a failed microphone pass still waits for system audio before reporting the failure', async () => {
  const manifestPath = capture();
  const order: string[] = [];
  const finishing = finalizeCaptureTranscript(manifestPath, { ...tracks(order, Promise.resolve(), true), concurrentTracks: true });
  await expect(finishing).rejects.toThrow('Microphone pass failed');
  expect(order).toContain('system finished');
});

test('both tracks at once only with the GPU and at least 16 GB of memory', () => {
  const mac = (memoryGb: number, appleSilicon = true): TranscriptionHardware =>
    ({ appleSilicon, performanceCores: 4, memoryBytes: memoryGb * 2 ** 30 });
  expect(concurrentTrackTranscription(mac(8), {})).toBe(false);
  expect(concurrentTrackTranscription(mac(16), {})).toBe(true);
  expect(concurrentTrackTranscription(mac(64), { SEASHELL_DISABLE_GPU: '1' })).toBe(false);
  expect(concurrentTrackTranscription(mac(32, false), {})).toBe(false);
});
