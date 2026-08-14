#!/usr/bin/env bun
import { stat } from 'fs/promises';
import { resolve } from 'path';
import { availableParallelism } from 'os';
import { OwnedWhisperServer } from '../src/local-asr-scheduler.ts';
import { saveLocalAsrProfile, type StoredLocalAsrProfile } from '../src/local-asr-profile.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const audioFile = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!audioFile) throw new Error('Usage: bun run benchmark:live-asr -- <16kHz-mono-wav>');
const details = await stat(audioFile);
if (!details.isFile() || details.size < 44) throw new Error('Benchmark input must be a non-empty WAV file');
const wav = await Bun.file(audioFile).arrayBuffer();
const view = new DataView(wav);
if (new TextDecoder().decode(new Uint8Array(wav, 0, 4)) !== 'RIFF' ||
    new TextDecoder().decode(new Uint8Array(wav, 8, 4)) !== 'WAVE') {
  throw new Error('Benchmark input is not a RIFF/WAVE file');
}
let sampleRate = 0;
let channels = 0;
let bits = 0;
let dataBytes = 0;
for (let offset = 12; offset + 8 <= wav.byteLength;) {
  const id = new TextDecoder().decode(new Uint8Array(wav, offset, 4));
  const size = view.getUint32(offset + 4, true);
  const content = offset + 8;
  if (content + size > wav.byteLength) throw new Error(`Benchmark WAV has a truncated ${id} chunk`);
  if (id === 'fmt ' && size >= 16) {
    channels = view.getUint16(content + 2, true);
    sampleRate = view.getUint32(content + 4, true);
    bits = view.getUint16(content + 14, true);
  } else if (id === 'data') {
    dataBytes += size;
  }
  offset = content + size + (size % 2);
}
const sourceAudioSeconds = dataBytes / Math.max(1, sampleRate * channels * bits / 8);
if (sampleRate !== 16_000 || channels !== 1 || bits !== 16) {
  throw new Error('Benchmark input must be 16kHz mono signed-16-bit WAV');
}

const modelPath = resolve(process.env.SEASHELL_DRAFT_MODEL ||
  resolve(projectRoot, 'models', 'ggml-large-v3-turbo-q5_0.bin'));
const serverPath = resolve(projectRoot, 'whisper.cpp', 'build', 'bin', 'whisper-server');
const candidates = [2, 4].filter((threads, index, all) =>
  threads <= availableParallelism() && all.indexOf(threads) === index);
const measurements: { threads: number; medianLatencyMs: number; realtimeFactor: number }[] = [];

for (const threads of candidates) {
  const server = new OwnedWhisperServer(serverPath, {
    id: `benchmark-${threads}`,
    modelPath,
    threads,
    requestTimeoutMs: 180_000,
    idleTimeoutMs: 180_000,
    disableGpu: process.env.SEASHELL_DISABLE_GPU === '1',
  });
  try {
    await server.transcribe(audioFile); // warm model and Metal graph
    const samples: number[] = [];
    for (let run = 0; run < 2; run += 1) {
      const started = performance.now();
      await server.transcribe(audioFile);
      samples.push(Math.round(performance.now() - started));
    }
    samples.sort((left, right) => left - right);
    const medianLatencyMs = Math.round((samples[0]! + samples[1]!) / 2);
    measurements.push({
      threads,
      medianLatencyMs,
      realtimeFactor: Number((medianLatencyMs / (sourceAudioSeconds * 1_000)).toFixed(4)),
    });
  } finally {
    await server.stop();
  }
}
const selected = measurements.toSorted((left, right) =>
  left.medianLatencyMs - right.medianLatencyMs)[0];
if (!selected) throw new Error('No benchmark candidate could run on this computer');
const profile: StoredLocalAsrProfile = {
  schemaVersion: '0.1',
  measuredAt: new Date().toISOString(),
  sourceAudioSeconds,
  modelPath,
  ...selected,
};
const path = await saveLocalAsrProfile(profile);
process.stdout.write(`${JSON.stringify({ path, selected: profile, measurements }, null, 2)}\n`);
