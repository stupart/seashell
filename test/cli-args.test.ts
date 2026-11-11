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

describe('first-install CLI parsing', () => {
  test('speaker setup is separate from first-install defaults and rejects noninteractive login', () => {
    expect(parseCliArgs(['setup', '--speakers'])).toEqual({ kind: 'speaker-setup', login: false, check: false, json: false });
    expect(parseCliArgs(['setup', '--speakers', '--login'])).toEqual({ kind: 'speaker-setup', login: true, check: false, json: false });
    expect(parseCliArgs(['setup', '--speakers', '--check', '--json'])).toEqual({ kind: 'speaker-setup', login: false, check: true, json: true });
    expect(() => parseCliArgs(['setup', '--speakers', '--login', '--json'])).toThrow('cannot be combined');
    expect(() => parseCliArgs(['setup', '--speakers', '--no-autostart'])).toThrow('Unknown speaker setup option');
  });
  test('defaults to automatic launch and supports an explicit opt-out', () => {
    expect(parseCliArgs(['setup'])).toEqual({
      kind: 'setup', autostart: true, json: false,
    });
    expect(parseCliArgs(['setup', '--no-autostart', '--json'])).toEqual({
      kind: 'setup', autostart: false, json: true,
    });
    expect(() => parseCliArgs(['setup', '--force'])).toThrow('Unknown setup option');
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
  test('separates explicit Accessibility setup from read-only speaker checks', () => {
    expect(parseCliArgs(['meeting', 'speakers', 'setup', '--json'])).toEqual({
      kind: 'meeting', action: { kind: 'speakers', browser: 'setup' }, json: true,
    });
    expect(parseCliArgs(['meeting', 'speakers'])).toEqual({
      kind: 'meeting', action: { kind: 'speakers', browser: 'check' }, json: false,
    });
    expect(() => parseCliArgs(['meeting', 'speakers', 'setup', 'chrome'])).toThrow('Usage');
    expect(() => parseCliArgs(['meeting', 'speakers', 'setup', '--automation', 'automatic'])).toThrow('do not apply');
  });
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


test('saved speaker identification creates an explicit library action', () => {
  expect(parseCliArgs(['library', 'speakers', 'meeting-1', 'identify', '--json'])).toMatchObject({
    kind: 'library', action: { kind: 'speakers-identify', id: 'meeting-1' }, json: true,
  });
});

describe('video CLI parsing', () => {
  test('record --video names a window or a display, and either implies video', () => {
    expect(parseCliArgs(['record'])).toEqual({ kind: 'record', command: 'start', json: false });
    expect(parseCliArgs(['record', '--video', '--json'])).toEqual({ kind: 'record', command: 'start', json: true, video: {} });
    expect(parseCliArgs(['record', '--video', '--window', 'Google Chrome'])).toEqual({
      kind: 'record', command: 'start', json: false, video: { window: 'Google Chrome' } });
    expect(parseCliArgs(['record', '--display', '2'])).toEqual({ kind: 'record', command: 'start', json: false, video: { display: 2 } });
    expect(parseCliArgs(['record', 'stop', '--json'])).toEqual({ kind: 'record', command: 'stop', json: true });
    for (const args of [['record', 'stop', '--video'], ['record', '--window', 'zoom', '--display', '1'],
      ['record', '--display', '0'], ['record', '--window'], ['record', 'later']]) {
      expect(() => parseCliArgs(args)).toThrow();
    }
  });

  test('meeting video covers permission, settings and one meeting', () => {
    const video = (...args: string[]) => (parseCliArgs(['meeting', 'video', ...args]) as { action: unknown }).action;
    expect(video()).toEqual({ kind: 'video', operation: 'status' });
    expect(video('--status', '--json')).toEqual({ kind: 'video', operation: 'status' });
    expect(video('setup')).toEqual({ kind: 'video', operation: 'setup' });
    expect(video('off')).toEqual({ kind: 'video', operation: 'off' });
    expect(video('Zoom', 'on')).toEqual({ kind: 'video', operation: 'on', app: 'zoom' });
    expect(video('meeting-20261110-ab12', '--at', '12:34')).toEqual({ kind: 'video', operation: 'open', id: 'meeting-20261110-ab12', atSeconds: 754 });
    expect(video('meeting-1', '--at', '1:02:03')).toMatchObject({ atSeconds: 3723 });
    expect(video('meeting-1', '--at', '90')).toMatchObject({ atSeconds: 90 });
    expect(parseCliArgs(['meeting', 'video', 'meeting-1', '--library-dir', '/tmp/lib', '--json']))
      .toMatchObject({ kind: 'meeting', libraryDir: '/tmp/lib', json: true });
    for (const args of [['setup', '--status'], ['on', '--at', '1:00'], ['meeting-1', '--at', 'soon'], ['meeting-1', '--at', '1:2:3:4'],
      ['a', 'b', 'c'], ['zoom', 'maybe'], ['--loud']]) {
      expect(() => parseCliArgs(['meeting', 'video', ...args])).toThrow();
    }
  });
});

describe('meeting AI steering and asking', () => {
  test('seashell query parses the kind and its filters', () => {
    expect(parseCliArgs(['query', 'actions', '--person', 'Dana', '--since', '2026-10-01', '--json'])).toEqual({
      kind: 'query', noteKind: 'actions', person: 'Dana', since: '2026-10-01', json: true });
    expect(parseCliArgs(['query', '--about', 'pricing page', '--limit', '5'])).toEqual({ kind: 'query', about: 'pricing page', limit: 5, json: false });
    expect(parseCliArgs(['query', 'all'])).toEqual({ kind: 'query', json: false });
    expect(() => parseCliArgs(['query', 'actions', 'risks'])).toThrow('Usage: seashell query');
  });

  test('library clean-phantoms parses with ids and --dry-run', () => {
    expect(parseCliArgs(['library', 'clean-phantoms', '--dry-run'])).toMatchObject({ kind: 'library', action: { kind: 'clean-phantoms', ids: [], dryRun: true } });
    expect(parseCliArgs(['library', 'clean-phantoms', 'a', 'b', '--json'])).toMatchObject({ action: { kind: 'clean-phantoms', ids: ['a', 'b'], dryRun: false }, json: true });
    expect(() => parseCliArgs(['library', 'list', '--dry-run'])).toThrow('--dry-run only applies');
  });

  test('prompts commands parse', () => {
    expect(parseCliArgs(['prompts'])).toEqual({ kind: 'prompts', action: 'list', json: false });
    expect(parseCliArgs(['prompts', 'reset', 'notes', '--json'])).toEqual({ kind: 'prompts', action: 'reset', name: 'notes', json: true });
    expect(() => parseCliArgs(['prompts', 'reset'])).toThrow('Usage: seashell prompts');
  });

  test('extract and extractors parse as commands', () => {
    expect(parseCliArgs(['extract', 'acme-call', 'Customer', 'pains'])).toEqual({ kind: 'extract', id: 'acme-call', extractor: 'Customer pains', json: false });
    expect(parseCliArgs(['extractors', '--json'])).toEqual({ kind: 'extractors', json: true });
    expect(() => parseCliArgs(['extract', 'acme-call'])).toThrow('Usage: seashell extract');
  });

  test('automations parse as commands', () => {
    expect(parseCliArgs(['automations'])).toEqual({ kind: 'automations', action: 'list', json: false });
    expect(parseCliArgs(['automations', 'run', 'weekly-sync', 'Post', 'it'])).toEqual({ kind: 'automations', action: 'run', id: 'weekly-sync', name: 'Post it', json: false });
    expect(() => parseCliArgs(['automations', 'run'])).toThrow('Usage: seashell automations');
  });

  test('ai test parses', () => {
    expect(parseCliArgs(['ai', 'test', '--json'])).toEqual({ kind: 'ai', action: 'test', json: true });
  });
});

test('meeting computer-audio checks, or at the Mac runs the one-time check', () => {
  expect(parseCliArgs(['meeting', 'computer-audio'])).toMatchObject({ kind: 'meeting', action: { kind: 'computer-audio', operation: 'check' } });
  expect(parseCliArgs(['meeting', 'computer-audio', 'setup', '--json'])).toMatchObject({
    kind: 'meeting', action: { kind: 'computer-audio', operation: 'setup' }, json: true });
  expect(() => parseCliArgs(['meeting', 'computer-audio', 'allow'])).toThrow('seashell meeting computer-audio [setup|check]');
});

test('notes, briefs, drafts and vocabulary parse as a person types them', () => {
  expect(parseCliArgs(['note', 'Dana', 'sounded', 'unsure'])).toEqual({ kind: 'note', text: 'Dana sounded unsure', json: false });
  expect(parseCliArgs(['note', 'Send the guide', '--meeting', 'acme-call', '--at', '12:34', '--json']))
    .toEqual({ kind: 'note', text: 'Send the guide', meeting: 'acme-call', atSeconds: 754, json: true });
  // A time belongs to a meeting: during a recording the note is timed when typed.
  expect(() => parseCliArgs(['note', 'x', '--at', '1:00'])).toThrow('Usage: seashell note');
  expect(() => parseCliArgs(['note'])).toThrow('Usage: seashell note');
  expect(parseCliArgs(['brief'])).toEqual({ kind: 'brief', target: 'next', json: false });
  expect(parseCliArgs(['brief', 'next', '--json'])).toEqual({ kind: 'brief', target: 'next', json: true });
  expect(parseCliArgs(['brief', 'Weekly', 'sync'])).toEqual({ kind: 'brief', target: { title: 'Weekly sync' }, json: false });
  expect(parseCliArgs(['draft', 'acme-call'])).toEqual({ kind: 'draft', id: 'acme-call', slack: false, json: false });
  expect(parseCliArgs(['draft', 'acme-call', '--slack', '--ask', 'keep it to three bullets']))
    .toEqual({ kind: 'draft', id: 'acme-call', slack: true, ask: 'keep it to three bullets', json: false });
  expect(() => parseCliArgs(['draft'])).toThrow('Usage: seashell draft');
  expect(parseCliArgs(['vocabulary', '--json'])).toEqual({ kind: 'vocabulary', json: true });
  expect(() => parseCliArgs(['vocabulary', 'add'])).toThrow('Usage: seashell vocabulary');
});
