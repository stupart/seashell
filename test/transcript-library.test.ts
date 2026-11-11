import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { resolveLibraryDir } from '../src/config.ts';
import {
  findTranscriptRecord,
  listTranscriptRecords,
  renameTranscriptSpeaker,
  saveTranscriptRecord,
  searchTranscriptRecords,
  trashTranscriptRecord,
  writeTranscriptExport,
} from '../src/transcript-library.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { writeBackgroundMeetingState } from '../src/background-meeting-status.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seashell-library-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function record() {
  return createTranscriptRecord({
    transcript: [
      { start: 0.25, end: 1.5, speaker: 'SPEAKER_00', text: 'Private launch notes.' },
    ],
    speakers: [{ id: 'SPEAKER_00', label: 'SPEAKER_00' }],
  }, {
    id: '20260806143000-test1234',
    now: new Date('2026-08-06T14:30:00.000Z'),
    title: 'Meeting: Product / Launch',
    sourcePath: '/tmp/source with spaces.MP4',
    source: {
      filename: 'source with spaces.MP4',
      duration: 22.4,
      format: 'mov,mp4,m4a,3gp,3g2,mj2',
      audioStreamIndex: 1,
      channels: 2,
    },
  });
}

describe('transcript library', () => {
  test('a corrupt unrelated transcript does not block opening or exporting healthy records', () => {
    const root = temporaryDirectory();
    const saved = saveTranscriptRecord(root, record());
    saveTranscriptRecord(root, { ...record(), id: 'second-record' });
    const dateDir = dirname(saved.directory);
    const [first, second] = readdirSync(dateDir);
    writeFileSync(join(dateDir, first!, 'transcript.json'), '{broken');
    const healthy = JSON.parse(readFileSync(join(dateDir, second!, 'transcript.json'), 'utf8'));
    expect(findTranscriptRecord(root, healthy.id).record.id).toBe(healthy.id);
    expect(writeTranscriptExport(root, healthy.id, 'srt')).toEndWith('.srt');
  });

  test('transcript IDs cannot escape the library directory', () => {
    const root = join(temporaryDirectory(), 'library');
    mkdirSync(root);
    expect(() => saveTranscriptRecord(root, { ...record(), id: '../../../../outside' }))
      .toThrow('Transcript ID');
    expect(readdirSync(root)).toEqual([]);
  });

  test('atomically saves canonical JSON plus a readable transcript', () => {
    const root = temporaryDirectory();
    const saved = saveTranscriptRecord(root, record());
    expect(saved.directory).toContain('meeting-product-launch--20260806143000-test1234');
    expect(findTranscriptRecord(root, '20260806143000-test1234').record.source.path).toBe(
      '/tmp/source with spaces.MP4',
    );
    expect(readdirSync(saved.directory).toSorted()).toEqual([
      'transcript.json',
      'transcript.txt',
    ]);
    expect(readdirSync(saved.directory).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(statSync(saved.directory).mode & 0o777).toBe(0o700);
    expect(statSync(saved.jsonPath).mode & 0o777).toBe(0o600);
    expect(statSync(saved.textPath).mode & 0o777).toBe(0o600);
  });

  test('rebuilds listings and search directly from transcript folders', () => {
    const root = temporaryDirectory();
    saveTranscriptRecord(root, record());
    expect(listTranscriptRecords(root)).toHaveLength(1);
    expect(searchTranscriptRecords(root, 'launch')[0]?.id).toBe('20260806143000-test1234');
    expect(searchTranscriptRecords(root, 'missing')).toEqual([]);
  });

  test('renames a speaker without changing stable segment IDs', () => {
    const root = temporaryDirectory();
    saveTranscriptRecord(root, record());
    const renamed = renameTranscriptSpeaker(
      root,
      '20260806143000-test1234',
      'SPEAKER_00',
      'Tyler',
    );
    expect(renamed.speakers).toEqual([{ id: 'SPEAKER_00', label: 'Tyler' }]);
    expect(renamed.transcript[0]?.speaker).toBe('SPEAKER_00');
  });

  test('speaker renaming waits for live draft and final transcription writers to finish', () => {
    const root = temporaryDirectory();
    const original = record();
    const saved = saveTranscriptRecord(root, original);
    const before = readFileSync(saved.jsonPath, 'utf8');
    for (const state of ['recording', 'processing'] as const) {
      writeBackgroundMeetingState(saved.directory, state);
      expect(() => renameTranscriptSpeaker(root, original.id, 'SPEAKER_00', 'Updated name'))
        .toThrow('Wait for it to finish before renaming a speaker');
      expect(readFileSync(saved.jsonPath, 'utf8')).toBe(before);
    }
    writeBackgroundMeetingState(saved.directory, 'ready');
    expect(renameTranscriptSpeaker(root, original.id, 'SPEAKER_00', 'Updated name').speakers[0]?.label)
      .toBe('Updated name');
    expect(findTranscriptRecord(root, original.id).record.speakers[0]?.label).toBe('Updated name');
  });

  test('repeat listings reuse unchanged transcripts and reread changed ones', () => {
    const root = temporaryDirectory();
    const saved = saveTranscriptRecord(root, record());
    expect(listTranscriptRecords(root)[0]?.title).toBe('Meeting: Product / Launch');

    const parse = spyOn(JSON, 'parse');
    try {
      expect(listTranscriptRecords(root)).toHaveLength(1);
      expect(searchTranscriptRecords(root, 'launch')).toHaveLength(1);
      expect(searchTranscriptRecords(root, 'notes')).toHaveLength(1);
      expect(listTranscriptRecords(root)).toHaveLength(1);
      // Only the first search reads the file again, to build its search text.
      expect(parse).toHaveBeenCalledTimes(1);
    } finally { parse.mockRestore(); }

    saveTranscriptRecord(root, { ...record(), title: 'Renamed launch review' });
    expect(listTranscriptRecords(root).map((entry) => entry.title)).toEqual(['Renamed launch review']);
    expect(findTranscriptRecord(root, '20260806143000-test1234').record.title).toBe('Renamed launch review');
  });

  test('a damaged transcript reappears once it is repaired, and a removed one disappears', () => {
    const root = temporaryDirectory();
    const saved = saveTranscriptRecord(root, record());
    const healthy = readFileSync(saved.jsonPath, 'utf8');
    writeFileSync(saved.jsonPath, '{broken');
    expect(listTranscriptRecords(root)).toEqual([]);
    expect(searchTranscriptRecords(root, 'launch')).toEqual([]);
    writeFileSync(saved.jsonPath, healthy);
    expect(listTranscriptRecords(root).map((entry) => entry.id)).toEqual(['20260806143000-test1234']);
    expect(searchTranscriptRecords(root, 'launch').map((entry) => entry.id)).toEqual(['20260806143000-test1234']);
    rmSync(saved.directory, { recursive: true });
    expect(listTranscriptRecords(root)).toEqual([]);
    expect(searchTranscriptRecords(root, 'launch')).toEqual([]);
  });

  test('search follows edits to the text, speakers and title', () => {
    const root = temporaryDirectory();
    const original = record();
    saveTranscriptRecord(root, original);
    expect(searchTranscriptRecords(root, 'launch notes')).toHaveLength(1);
    expect(searchTranscriptRecords(root, 'budget')).toEqual([]);

    saveTranscriptRecord(root, { ...original, transcript: [{ ...original.transcript[0]!, text: 'Budget review.' }] });
    expect(searchTranscriptRecords(root, 'launch notes')).toEqual([]);
    expect(searchTranscriptRecords(root, 'BUDGET')).toHaveLength(1);

    renameTranscriptSpeaker(root, original.id, 'SPEAKER_00', 'Avery Example');
    expect(searchTranscriptRecords(root, 'avery example')).toHaveLength(1);
    // A listing between searches keeps the search text it already built.
    expect(listTranscriptRecords(root)).toHaveLength(1);
    expect(searchTranscriptRecords(root, 'budget review')).toHaveLength(1);
  });

  test('generates exports on demand and moves deletion to recoverable trash', () => {
    const root = temporaryDirectory();
    saveTranscriptRecord(root, record());
    const outputPath = writeTranscriptExport(root, '20260806143000-test1234', 'srt');
    expect(outputPath).toEndWith('transcript.srt');
    const trashPath = trashTranscriptRecord(root, '20260806143000-test1234');
    expect(trashPath).toContain('_Trash');
    expect(listTranscriptRecords(root)).toEqual([]);
  });
});

describe('library configuration', () => {
  test('uses flag, environment, config, then default precedence', () => {
    expect(resolveLibraryDir('/tmp/flag', { SEASHELL_LIBRARY_DIR: '/tmp/env' }, {
      libraryDir: '/tmp/config',
    })).toBe('/tmp/flag');
    expect(resolveLibraryDir(undefined, { SEASHELL_LIBRARY_DIR: '/tmp/env' }, {
      libraryDir: '/tmp/config',
    })).toBe('/tmp/env');
    expect(resolveLibraryDir(undefined, {}, { libraryDir: '/tmp/config' })).toBe('/tmp/config');
    expect(resolveLibraryDir(undefined, {}, {})).toContain('Documents/Sea Shell/Transcripts');
  });
});
