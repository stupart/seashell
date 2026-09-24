import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { identifySavedSpeakers } from '../src/speaker-reprocessing.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import { listTranscriptRecords, saveTranscriptRecord } from '../src/transcript-library.ts';

for (const fails of [false, true]) test(`saved speaker retry ${fails ? 'fails without publishing a partial result' : 'makes a separate review record'}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-speakers-review-'));
  try {
    const original = createTranscriptRecord({ transcript: [{ start: 0, end: 3, text: 'User corrected this.', speaker: 'SYSTEM' }],
      speakers: [{ id: 'SYSTEM', label: 'My correction' }], summary: 'Original notes' });
    const saved = saveTranscriptRecord(root, original);
    const before = readFileSync(saved.jsonPath, 'utf8');
    mkdirSync(join(saved.directory, 'capture'));
    writeFileSync(join(saved.directory, 'capture/manifest.json'), '{}');
    const pending = identifySavedSpeakers(root, original.id, { ready: () => true, finalize: async (_, options) => {
      expect(options?.strictSpeakers).toBe(true);
      if (fails) throw new Error('missing weights');
      return createTranscriptRecord({ transcript: [{ start: 0, end: 3, text: 'New ASR words.', speaker: 'REMOTE_A' }],
        speakers: [{ id: 'REMOTE_A', label: 'Remote speaker 1' }],
        speakerAnalysis: { status: 'complete', detail: 'Local separation' } });
    } });
    if (fails) {
      await expect(pending).rejects.toThrow('missing weights');
      expect(listTranscriptRecords(root)).toHaveLength(1);
    } else {
      const copy = await pending;
      expect(copy.id).not.toBe(original.id);
      expect(copy.summary).toBeUndefined();
      expect(copy.title).toContain('speakers (review)');
      expect(listTranscriptRecords(root)).toHaveLength(2);
    }
    expect(readFileSync(saved.jsonPath, 'utf8')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
