import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pcmS16leToWav } from '../src/live-system-audio.ts';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'bin', 'seashell-speakers');
/** community-1's models, already on this Mac: copied, never written to. */
const COMMUNITY = join(process.env.SEASHELL_SPEAKER_MODELS?.trim() ||
  join(homedir(), 'Library', 'Application Support', 'Sea Shell', 'Speakers'), 'speaker-diarization');
const runnable = process.platform === 'darwin' && existsSync(HELPER) && existsSync(join(COMMUNITY, 'Segmentation.mlmodelc'));

/** Three seconds of a made-up tone: nothing anyone said. */
function tone(path: string) {
  const pcm = Buffer.alloc(16_000 * 3 * 2);
  for (let index = 0; index < pcm.length / 2; index++) {
    pcm.writeInt16LE(Math.round(6_000 * Math.sin(2 * Math.PI * 220 * index / 16_000)), index * 2);
  }
  writeFileSync(path, pcmS16leToWav(pcm));
}

test.skipIf(!runnable)('auto keeps community-1\'s answer when Nemotron 3 cannot load', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-speakers-auto-'));
  try {
    cpSync(COMMUNITY, join(root, 'speaker-diarization'), { recursive: true });
    // A Nemotron 3 download that looks complete, so nothing is fetched, but whose model is not one.
    const nemotron = join(root, 'nemotron-3-diarization');
    const bundle = join(nemotron, 'monolithic', 'v2', 'Nemotron3Diarizer_fast128.mlmodelc');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'coremldata.bin'), 'not a model');
    writeFileSync(join(nemotron, 'learnable_sil_emb.bin'), 'not an embedding');
    writeFileSync(join(nemotron, '.fluidaudio-nemotron3-weights'), 'ga-2026-09-23\n');
    const audio = join(root, 'call.wav');
    tone(audio);

    const run = Bun.spawn([HELPER, audio, '--engine', 'auto'], {
      env: { ...process.env, SEASHELL_SPEAKER_MODELS: root }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
    expect(stderr).toContain('Nemotron 3 could not load');
    const result = JSON.parse(stdout) as { model: string; turns: unknown[] };
    expect(result.model).toContain('community-1');
    expect(Array.isArray(result.turns)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
