import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { saveFinalizedCapture } from '../src/capture-finalizer.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import type { MeetSample } from '../src/meet-speakers.ts';
import { findTranscriptRecord } from '../src/transcript-library.ts';
import { coalesceTranscriptSegments, renderTranscript } from '../src/transcript-renderer.ts';

const aliceId = `MEET_${'a'.repeat(20)}`;
const bobId = `MEET_${'b'.repeat(20)}`;
const origin = 1000;
const meeting = '/abc-defg-hij';

function hints(at: number, id: string, label: string, source?: MeetSample['source']): MeetSample[] {
  return [at, at + 0.5, at + 1].map(at => ({
    at, meeting, browser: 'chrome', speaker: { id, label }, ...(source ? { source } : {}),
  }));
}

function fixture(root: string, id: string, samples: MeetSample[], microphone = true) {
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: id, startedAtUnixMs: origin });
  for (const track of microphone ? ['microphone', 'system-audio'] as const : ['system-audio'] as const) {
    const audio = join(root, `${track}.wav`);
    writeFileSync(audio, pcmS16leToWav(Buffer.alloc(32000 * 10, 10)));
    store.commitChunk({ sourcePath: audio, trackId: track, startSeconds: 0, endSeconds: 10, audible: true });
  }
  const sidecar = [JSON.stringify({ version: 1, sessionId: id, origin }), ...samples.map(sample => JSON.stringify(sample)), ''].join('\n');
  writeFileSync(join(store.root, 'meet-speakers.jsonl'), sidecar, { mode: 0o600 });
  return { store, sidecar };
}

for (const boundary of ['local', 'remote'] as const) {
  test(`${boundary} finalization preserves legacy renames through save and reload without changing stable IDs`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'seashell-meet-renames-'));
    try {
      const samples = [
        ...hints(0, aliceId, 'Alice'),
        ...hints(2, aliceId, 'Alicia', 'google-meet-accessibility'),
        ...hints(4, bobId, 'Bob', 'google-meet-accessibility'),
        ...hints(6, aliceId, 'Alice'),
        { at: 8, meeting, browser: 'chrome' as const },
        { at: 9, meeting, browser: 'chrome' as const },
      ];
      const { store, sidecar } = fixture(root, `renames-${boundary}`, samples);
      const remote = [
        { start: 0.1, end: 0.6, text: 'Opening proposal.' },
        { start: 2.1, end: 2.6, text: 'Changed display name.' },
        { start: 4.1, end: 4.6, text: 'Another participant.' },
        { start: 6.1, end: 6.6, text: 'Original display name returns.' },
        { start: 8.1, end: 8.6, text: 'Unattributed computer audio.' },
      ];
      const local = [{ start: 0.1, end: 0.4, text: 'My independent microphone note.' }];
      const record = await saveFinalizedCapture(store, root, 'fixture', {
        diarizeSystemAudio: false,
        localTranscriber: async path => path.includes('microphone') ? local : remote,
        ...(boundary === 'remote' ? {
          remoteRoute: { model: 'fixture', uploadConsent: true as const },
          remoteTranscriber: async (path: string) => ({
            runId: 'fixture', compiledRunId: 'fixture', status: 'succeeded' as const, receipt: {},
            output: { provider: { boundary: 'remote' as const, model: 'fixture' },
              segments: (path.includes('microphone') ? local : remote).map((segment, index) => ({
                id: `fixture-${index}`, startMs: segment.start * 1000, endMs: segment.end * 1000, text: segment.text,
              })),
            },
          }),
        } : {}),
      });
      const saved = findTranscriptRecord(root, record.id);
      const reloaded = saved.record;
      const first = reloaded.transcript.find(s => s.text === 'Opening proposal.')!;
      const renamed = reloaded.transcript.find(s => s.text === 'Changed display name.')!;
      const returning = reloaded.transcript.find(s => s.text === 'Original display name returns.')!;
      expect(first.speaker).not.toBe(renamed.speaker);
      expect(first.speaker).toBe(returning.speaker);
      expect(first.speaker).toStartWith(`${aliceId}_LABEL_`);
      expect(first.speaker!.length).toBe(96);
      expect(reloaded.speakers.find(s => s.id === first.speaker)?.label).toBe('Alice');
      expect(reloaded.speakers.find(s => s.id === renamed.speaker)?.label).toBe('Alicia');
      expect(reloaded.transcript.find(s => s.text === 'Another participant.')).toMatchObject({ speaker: bobId, speakerSource: 'google-meet-accessibility' });
      expect(first.speakerSource).toBe('google-meet-dom');
      expect(renamed.speakerSource).toBe('google-meet-accessibility');
      expect(returning.speakerSource).toBe('google-meet-dom');
      expect(reloaded.transcript.find(s => s.text === local[0]!.text)).toMatchObject({ speaker: 'LOCAL' });
      expect(reloaded.transcript.find(s => s.text === local[0]!.text)?.speakerSource).toBeUndefined();
      expect(reloaded.transcript.find(s => s.text === 'Unattributed computer audio.')).toMatchObject({ speaker: 'SYSTEM' });
      expect(reloaded.speakers).toEqual(expect.arrayContaining([{ id: bobId, label: 'Bob' }, { id: 'LOCAL', label: 'Microphone' }, { id: 'SYSTEM', label: 'System audio' }]));
      expect(readFileSync(join(dirname(saved.path), 'capture', 'meet-speakers.jsonl'), 'utf8')).toBe(sidecar);
      const rendered = renderTranscript(reloaded, 'text', { speakers: true });
      expect(rendered).toContain('Alice: Opening proposal.');
      expect(rendered).toContain('Alicia: Changed display name.');
      expect(rendered).toContain('Alice: Original display name returns.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('persisted adjacent hints retain each source without changing an unrenamed ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-meet-sources-'));
  try {
    const samples: MeetSample[] = [
      ...[0, 0.5].map(at => ({ at, meeting, speaker: { id: bobId, label: 'Bob' } })),
      ...[0.55, 1].map(at => ({ at, meeting, source: 'google-meet-accessibility' as const, speaker: { id: bobId, label: 'Bob' } })),
    ];
    const { store } = fixture(root, 'adjacent-sources', samples, false);
    const record = await saveFinalizedCapture(store, root, 'fixture', {
      diarizeSystemAudio: false,
      localTranscriber: async () => [
        { start: 0.1, end: 0.4, text: 'Legacy hint.' },
        { start: 0.6, end: 0.9, text: 'Accessibility hint.' },
      ],
    });
    const reloaded = findTranscriptRecord(root, record.id).record;
    expect(reloaded.transcript).toHaveLength(2);
    expect(reloaded.transcript.map(s => s.speaker)).toEqual([bobId, bobId]);
    expect(reloaded.transcript.map(s => s.speakerSource)).toEqual(['google-meet-dom', 'google-meet-accessibility']);
    expect(coalesceTranscriptSegments(reloaded)).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
