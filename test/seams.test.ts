import { expect, test } from 'bun:test';
import {
  applySpeakerLabels,
  type SpeakerLabeler,
} from '../src/speaker-labeling.ts';
import {
  applyTranscriptEnrichment,
  type TranscriptEnricher,
} from '../src/transcript-enrichment.ts';
import type { StructuredTranscript } from '../src/transcript-types.ts';

const base: StructuredTranscript = {
  transcript: [
    { start: 0, end: 1, speaker: 'SPEAKER_00', text: 'Ship it.' },
  ],
  speakers: [{ id: 'SPEAKER_00', label: 'SPEAKER_00' }],
};

test('speaker labeling seam can map diarized IDs from Meet evidence', async () => {
  const labeler: SpeakerLabeler = {
    async labelSpeakers(request) {
      expect(request.evidence.attendees[0]?.email).toBe('ada@example.com');
      return [{ id: 'SPEAKER_00', label: 'Ada' }];
    },
  };

  const labeled = await applySpeakerLabels(base, labeler, {
    attendees: [{ name: 'Ada', email: 'ada@example.com' }],
    screenshots: [{ capturedAt: 0.5, imagePath: '/tmp/meet-0001.png' }],
  });

  expect(labeled.speakers).toEqual([{ id: 'SPEAKER_00', label: 'Ada' }]);
});

test('partial speaker labels preserve every transcript-referenced ID', async () => {
  const document: StructuredTranscript = {
    transcript: [
      ...base.transcript,
      { start: 1, end: 2, speaker: 'SPEAKER_01', text: 'Agreed.' },
    ],
    speakers: [
      ...base.speakers,
      { id: 'SPEAKER_01', label: 'SPEAKER_01' },
    ],
  };

  const labeled = await applySpeakerLabels(
    document,
    {
      async labelSpeakers() {
        return [{ id: 'SPEAKER_00', label: 'Ada' }];
      },
    },
    { attendees: [], screenshots: [] },
  );

  expect(labeled.speakers).toEqual([
    { id: 'SPEAKER_00', label: 'Ada' },
    { id: 'SPEAKER_01', label: 'SPEAKER_01' },
  ]);
});

test('provider-neutral enrichment seam adds optional structured insights', async () => {
  const enricher: TranscriptEnricher = {
    async enrich() {
      return {
        summary: 'The release was approved.',
        decisions: ['Ship the release'],
        action_items: [{ owner: 'Ada', task: 'Deploy' }],
      };
    },
  };

  const enriched = await applyTranscriptEnrichment(base, enricher);
  expect(enriched.decisions).toEqual(['Ship the release']);
  expect(enriched.action_items).toEqual([{ owner: 'Ada', task: 'Deploy' }]);
});

test('enrichment cannot overwrite the core transcript or speaker tables', async () => {
  const enriched = await applyTranscriptEnrichment(base, {
    async enrich() {
      return {
        summary: 'Safe insight',
        transcript: [],
        speakers: [],
      } as never;
    },
  });

  expect(enriched.transcript).toEqual(base.transcript);
  expect(enriched.speakers).toEqual(base.speakers);
});
