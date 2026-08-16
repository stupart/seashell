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

describe('capability discovery CLI parsing', () => {
  test('exposes a stable machine-readable capability surface', () => {
    expect(parseCliArgs(['capabilities', '--json'])).toEqual({
      kind: 'capabilities',
      json: true,
    });
    expect(() => parseCliArgs(['capabilities', '--unknown']))
      .toThrow('Unknown capabilities option');
  });
});

describe('recoverable capture CLI parsing', () => {
  test('lists, shows, and finalizes durable live sessions', () => {
    expect(parseCliArgs(['capture', 'list', '--json'])).toEqual({
      kind: 'capture', action: { kind: 'list' }, json: true,
    });
    expect(parseCliArgs(['capture', 'test', '--seconds', '8'])).toEqual({
      kind: 'capture', action: { kind: 'test', seconds: 8 }, json: false,
    });
    expect(parseCliArgs(['capture', 'record', '--seconds', '60', '--json'])).toEqual({
      kind: 'capture', action: { kind: 'record', seconds: 60 }, json: true,
    });
    expect(parseCliArgs(['capture', 'show', 'session-1'])).toEqual({
      kind: 'capture', action: { kind: 'show', id: 'session-1' }, json: false,
    });
    expect(parseCliArgs(['capture', 'finalize', 'session-1', '--library-dir', '/tmp/library']))
      .toEqual({
        kind: 'capture',
        action: { kind: 'finalize', id: 'session-1' },
        libraryDir: '/tmp/library',
        json: false,
      });
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
    expect(parseCliArgs(['meeting', 'setup', '--clear-context-files'])).toMatchObject({
      action: { kind: 'setup', contextFiles: [] },
    });
    expect(() => parseCliArgs([
      'meeting', 'setup', '--clear-context-files', '--context-file', 'notes.md',
    ])).toThrow('cannot be combined');
  });

  test('parses independent observer, reconciliation, and chat routes', () => {
    expect(parseCliArgs([
      'meeting',
      'setup',
      '--observer-backend', 'openrouter',
      '--observer-model', 'vendor/cheap',
      '--reconciliation-backend', 'codex',
      '--reconciliation-model', 'gpt-strong',
      '--chat-backend', 'claude-code',
      '--chat-model', 'claude-balanced',
    ])).toMatchObject({
      action: {
        kind: 'setup',
        routes: {
          observer: { backend: 'openrouter', model: 'vendor/cheap' },
          reconciliation: { backend: 'codex', model: 'gpt-strong' },
          chat: { backend: 'claude-code', model: 'claude-balanced' },
        },
      },
    });
    expect(() => parseCliArgs([
      'meeting', 'setup', '--observer-backend', 'openrouter',
    ])).toThrow('--observer-backend and --observer-model together');
  });

  test('parses automatic watcher, login-agent, and consent policy commands', () => {
    expect(parseCliArgs(['meeting', 'watch', '--once', '--json'])).toMatchObject({
      kind: 'meeting',
      json: true,
      action: { kind: 'watch', once: true },
    });
    expect(parseCliArgs(['meeting', 'autostart', 'status'])).toMatchObject({
      action: { kind: 'autostart', operation: 'status' },
    });
    expect(parseCliArgs(['meeting', 'consent', 'approve'])).toMatchObject({
      action: { kind: 'consent', decision: 'approve' },
    });
    expect(parseCliArgs([
      'meeting', 'setup',
      '--automation', 'automatic',
      '--browser-without-calendar', 'ask',
      '--context-file', './BLUEPRINT.md',
      '--context-file', './project.md',
    ])).toMatchObject({
      action: {
        kind: 'setup',
        automationMode: 'automatic',
        browserWithoutCalendar: 'ask',
        contextFiles: ['./BLUEPRINT.md', './project.md'],
      },
    });
    expect(() => parseCliArgs(['meeting', 'autostart', 'maybe']))
      .toThrow('enable, disable, or status');
    expect(() => parseCliArgs(['meeting', 'consent', 'maybe']))
      .toThrow('approve or decline');
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
