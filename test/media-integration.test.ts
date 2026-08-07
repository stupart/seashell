import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { prepareMedia, probeMedia } from '../src/media-preparation.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seashell-media-integration-'));
  temporaryDirectories.push(directory);
  return directory;
}

const hasFfmpeg = Boolean(Bun.which('ffmpeg') && Bun.which('ffprobe'));

test('extracts audio from a generated video into canonical mono PCM', async () => {
  if (!hasFfmpeg) return;
  const directory = fixtureDirectory();
  const videoPath = join(directory, 'Meeting $(draft) FINAL.MP4');
  const generated = spawnSync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=4:d=0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=0.5',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest',
    '-f', 'mp4', videoPath,
  ], { encoding: 'utf8' });
  expect(generated.status).toBe(0);

  const sourceProbe = await probeMedia(videoPath);
  expect(sourceProbe.audioStreams).toHaveLength(1);
  expect(sourceProbe.audioStreams[0]?.codecName).toBe('aac');

  const prepared = await prepareMedia(videoPath);
  const preparedDirectory = dirname(prepared.path);
  const preparedProbe = await probeMedia(prepared.path);
  expect(preparedProbe.audioStreams[0]).toMatchObject({
    codecName: 'pcm_s16le',
    sampleRate: 16000,
    channels: 1,
  });
  prepared.cleanup();
  prepared.cleanup();
  expect(existsSync(preparedDirectory)).toBe(false);
}, 20_000);

test('rejects a generated video that has no audio stream', async () => {
  if (!hasFfmpeg) return;
  const directory = fixtureDirectory();
  const videoPath = join(directory, 'silent-video.mp4');
  const generated = spawnSync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=4:d=0.25',
    '-an', '-c:v', 'mpeg4', '-f', 'mp4', videoPath,
  ], { encoding: 'utf8' });
  expect(generated.status).toBe(0);
  await expect(prepareMedia(videoPath)).rejects.toThrow('No audio stream found');
}, 20_000);
