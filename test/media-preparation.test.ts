import { describe, expect, test } from 'bun:test';
import {
  buildFfmpegPreparationArgs,
  buildFfprobeArgs,
  parseFfprobeJson,
  selectAudioStream,
} from '../src/media-preparation.ts';

const probeDocument = {
  streams: [
    {
      index: 1,
      codec_name: 'aac',
      sample_rate: '48000',
      channels: 2,
      disposition: { default: 0 },
      tags: { language: 'fra' },
    },
    {
      index: 3,
      codec_name: 'opus',
      sample_rate: '48000',
      channels: 6,
      disposition: { default: 1 },
      tags: { language: 'eng' },
    },
  ],
  format: {
    format_name: 'matroska,webm',
    duration: '123.456',
  },
};

describe('media probing', () => {
  test('parses duration and all audio streams', () => {
    expect(parseFfprobeJson('/tmp/MEETING.MKV', probeDocument)).toEqual({
      path: '/tmp/MEETING.MKV',
      formatName: 'matroska,webm',
      duration: 123.456,
      audioStreams: [
        {
          index: 1,
          codecName: 'aac',
          sampleRate: 48000,
          channels: 2,
          language: 'fra',
          isDefault: false,
        },
        {
          index: 3,
          codecName: 'opus',
          sampleRate: 48000,
          channels: 6,
          language: 'eng',
          isDefault: true,
        },
      ],
    });
  });

  test('selects the default stream or an explicit stream index', () => {
    const probe = parseFfprobeJson('/tmp/meeting.mkv', probeDocument);
    expect(selectAudioStream(probe).index).toBe(3);
    expect(selectAudioStream(probe, 1).index).toBe(1);
    expect(() => selectAudioStream(probe, 8)).toThrow('Available stream indices: 1, 3');
  });

  test('rejects media without an audio stream', () => {
    const probe = parseFfprobeJson('/tmp/silent-video.mp4', {
      streams: [],
      format: { duration: '4.2' },
    });
    expect(() => selectAudioStream(probe)).toThrow('No audio stream found');
  });
});

describe('media command arguments', () => {
  test('keeps paths with spaces and shell characters as one ffprobe argument', () => {
    const path = '/tmp/Meeting $(private) FINAL.MP4';
    const args = buildFfprobeArgs(path);
    expect(args.at(-1)).toBe(path);
  });

  test('builds mono PCM preparation without shell interpolation', () => {
    const args = buildFfmpegPreparationArgs(
      '/tmp/source with spaces.MOV',
      '/tmp/output audio.wav',
      { index: 3, isDefault: true },
      false,
    );
    expect(args).toContain('0:3');
    expect(args).toContain('-vn');
    expect(args).toContain('pcm_s16le');
    expect(args.slice(args.indexOf('-ac'), args.indexOf('-ac') + 2)).toEqual(['-ac', '1']);
    expect(args.at(-1)).toBe('/tmp/output audio.wav');
  });

  test('preserves channels for diarization preparation', () => {
    const args = buildFfmpegPreparationArgs(
      '/tmp/meeting.webm',
      '/tmp/audio.wav',
      { index: 1, isDefault: false },
      true,
    );
    expect(args).not.toContain('-ac');
  });
});
