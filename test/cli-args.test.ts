import { describe, expect, test } from 'bun:test';
import { parseCliArgs } from '../src/cli-args.ts';

describe('transcription CLI parsing', () => {
  test('preserves the bare-file shortcut', () => {
    expect(parseCliArgs(['meeting.mp4'])).toMatchObject({
      kind: 'transcribe',
      files: ['meeting.mp4'],
      options: { format: 'text', timestamps: false, speakers: false },
    });
  });

  test('supports independent timestamp and speaker presentation', () => {
    expect(parseCliArgs([
      'transcribe',
      'meeting.mov',
      '--timestamps',
      '--speakers',
      '--format',
      'vtt',
      '--audio-stream',
      '0',
      '--no-save',
    ])).toMatchObject({
      kind: 'transcribe',
      files: ['meeting.mov'],
      options: {
        format: 'vtt',
        timestamps: true,
        speakers: true,
        audioStreamIndex: 0,
        save: false,
      },
    });
  });

  test('speaker evidence enables diarization and keeps its file path', () => {
    expect(parseCliArgs([
      'transcribe',
      'meeting.mov',
      '--speaker-evidence',
      'meeting-speakers.json',
    ])).toMatchObject({
      kind: 'transcribe',
      options: {
        speakers: true,
        speakerEvidencePath: 'meeting-speakers.json',
      },
    });
  });

  test('keeps the legacy diarization invocation as JSON', () => {
    expect(parseCliArgs(['--diarize', 'meeting.m4a'])).toMatchObject({
      kind: 'transcribe',
      options: { speakers: true, format: 'json' },
    });
  });

  test('rejects ambiguous structured output for multiple files', () => {
    expect(() => parseCliArgs([
      'transcribe',
      'one.wav',
      'two.wav',
      '--format',
      'json',
    ])).toThrow('require exactly one input file');
  });

  test('preserves speaker-count validation', () => {
    expect(() => parseCliArgs([
      'transcribe',
      'meeting.wav',
      '--num-speakers',
      '2',
      '--min-speakers',
      '1',
    ])).toThrow('cannot be combined');
  });
});

describe('update CLI parsing', () => {
  test('supports human and machine-readable update checks', () => {
    expect(parseCliArgs(['update'])).toEqual({ kind: 'update', check: false, json: false });
    expect(parseCliArgs(['update', '--check', '--json'])).toEqual({
      kind: 'update',
      check: true,
      json: true,
    });
  });

  test('rejects unknown updater options', () => {
    expect(() => parseCliArgs(['update', '--force'])).toThrow('Unknown update option');
  });
});

describe('meeting CLI parsing', () => {
  test('parses meeting creation and exact enrichment routes', () => {
    expect(parseCliArgs([
      'meeting',
      'create',
      'meeting-1',
      '--event-json',
      'event.json',
      '--mode',
      'hybrid',
    ])).toMatchObject({
      kind: 'meeting',
      action: {
        kind: 'create',
        id: 'meeting-1',
        eventJsonPath: 'event.json',
        mode: 'hybrid',
      },
    });
    expect(parseCliArgs([
      'meeting',
      'enrich',
      'meeting-1',
      '--backend',
      'openrouter',
      '--model',
      'google/gemma-3-4b-it',
      '--json',
    ])).toMatchObject({
      kind: 'meeting',
      json: true,
      action: {
        kind: 'enrich',
        backend: 'openrouter',
        model: 'google/gemma-3-4b-it',
      },
    });
  });

  test('keeps chat questions together and rejects misplaced options', () => {
    expect(parseCliArgs(['meeting', 'chat', 'meeting-1', 'What', 'did', 'we', 'decide?']))
      .toMatchObject({ action: { kind: 'chat', question: 'What did we decide?' } });
    expect(() => parseCliArgs(['meeting', 'show', 'meeting-1', '--model', 'x']))
      .toThrow('do not apply');
  });

  test('parses persistent meeting route setup without storing a secret', () => {
    expect(parseCliArgs([
      'meeting',
      'setup',
      '--backend',
      'codex',
      '--model',
      'gpt-5-mini',
      '--mode',
      'hybrid',
      '--calendar',
      'ask',
    ])).toMatchObject({
      action: {
        kind: 'setup',
        backend: 'codex',
        model: 'gpt-5-mini',
        mode: 'hybrid',
        calendarPolicy: 'ask',
      },
    });
    expect(() => parseCliArgs(['meeting', 'setup', '--backend', 'codex']))
      .toThrow('together');
  });
});

describe('library CLI parsing', () => {
  test('parses JSON search and speaker renaming', () => {
    expect(parseCliArgs(['library', 'search', 'launch notes', '--json'])).toMatchObject({
      kind: 'library',
      json: true,
      action: { kind: 'search', query: 'launch notes' },
    });
    expect(parseCliArgs([
      'library',
      'speakers',
      'record-1',
      'set',
      'SPEAKER_00',
      'Ada Lovelace',
      '--json',
    ])).toMatchObject({
      kind: 'library',
      action: {
        kind: 'speakers-set',
        id: 'record-1',
        speakerId: 'SPEAKER_00',
        label: 'Ada Lovelace',
      },
    });
  });

  test('requires explicit confirmation for destructive actions at runtime boundary', () => {
    expect(parseCliArgs(['library', 'trash', 'record-1'])).toMatchObject({
      action: { kind: 'trash', confirmed: false },
    });
  });

  test('keeps export format independent from JSON command responses', () => {
    expect(parseCliArgs([
      'library',
      'export',
      'record-1',
      '--format',
      'srt',
      '--json',
    ])).toMatchObject({
      kind: 'library',
      json: true,
      format: 'srt',
      action: { kind: 'export', id: 'record-1' },
    });
  });
});
