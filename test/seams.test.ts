import { expect, test } from 'bun:test';
import {
  applySpeakerLabels,
  EvidenceSpeakerLabeler,
  parseSpeakerLabelingEvidence,
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

test('screen active-speaker evidence names the cluster speaking at that time', async () => {
  const document: StructuredTranscript = {
    transcript: [
      { start: 0, end: 3, speaker: 'SPEAKER_00', text: 'Welcome.' },
      { start: 3, end: 6, speaker: 'SPEAKER_01', text: 'Thank you.' },
    ],
    speakers: [
      { id: 'SPEAKER_00', label: 'SPEAKER_00' },
      { id: 'SPEAKER_01', label: 'SPEAKER_01' },
    ],
  };
  const labeled = await applySpeakerLabels(document, new EvidenceSpeakerLabeler(), {
    attendees: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }],
    screenshots: [],
    activeSpeakers: [{ capturedAt: 4, name: 'Grace Hopper', source: 'google-meet' }],
  });

  expect(labeled.speakers).toEqual([
    { id: 'SPEAKER_00', label: 'SPEAKER_00' },
    { id: 'SPEAKER_01', label: 'Grace Hopper' },
  ]);
});

test('self-identification and peer handoffs resolve only roster names', async () => {
  const document: StructuredTranscript = {
    transcript: [
      { start: 0, end: 2, speaker: 'SPEAKER_00', text: "Hi, I'm Ada Lovelace." },
      { start: 2, end: 4, speaker: 'SPEAKER_00', text: 'Grace, what do you think?' },
      { start: 4, end: 7, speaker: 'SPEAKER_01', text: 'I agree with that.' },
    ],
    speakers: [
      { id: 'SPEAKER_00', label: 'SPEAKER_00' },
      { id: 'SPEAKER_01', label: 'SPEAKER_01' },
    ],
  };
  const labeled = await applySpeakerLabels(document, new EvidenceSpeakerLabeler(), {
    attendees: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }],
    screenshots: [],
  });

  expect(labeled.speakers).toEqual([
    { id: 'SPEAKER_00', label: 'Ada Lovelace' },
    { id: 'SPEAKER_01', label: 'Grace Hopper' },
  ]);
});

test('ambiguous roster aliases and conflicting evidence stay anonymous', async () => {
  const document: StructuredTranscript = {
    transcript: [
      { start: 0, end: 3, speaker: 'SPEAKER_00', text: "I'm Alex." },
      { start: 3, end: 6, speaker: 'SPEAKER_01', text: "I'm Ada." },
    ],
    speakers: [
      { id: 'SPEAKER_00', label: 'SPEAKER_00' },
      { id: 'SPEAKER_01', label: 'SPEAKER_01' },
    ],
  };
  const labeled = await applySpeakerLabels(document, new EvidenceSpeakerLabeler(), {
    attendees: [
      { name: 'Alex Kim' },
      { name: 'Alex Smith' },
      { name: 'Ada Lovelace' },
      { name: 'Grace Hopper' },
    ],
    screenshots: [],
    activeSpeakers: [{ capturedAt: 4, name: 'Grace Hopper' }],
  });

  expect(labeled.speakers).toEqual(document.speakers);
});

test('speaker evidence JSON is normalized and validated', () => {
  expect(parseSpeakerLabelingEvidence({
    attendees: [{ name: ' Ada ', email: 'ada@example.com' }],
    activeSpeakers: [{ capturedAt: 1.25, name: ' Ada ', source: 'meet' }],
  })).toEqual({
    attendees: [{ name: 'Ada', email: 'ada@example.com' }],
    screenshots: [],
    activeSpeakers: [{ capturedAt: 1.25, name: 'Ada', source: 'meet' }],
  });
  expect(() => parseSpeakerLabelingEvidence({
    activeSpeakers: [{ capturedAt: -1, name: 'Ada' }],
  })).toThrow('observation 0 is invalid');
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
