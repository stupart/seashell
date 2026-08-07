import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
