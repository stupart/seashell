import { expect, test } from 'bun:test';
import { createMeetingArtifact } from '../src/meeting-artifact.ts';
import { meetingViewLines } from '../src/meeting-tui.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

test('meeting views stay concise and show only relevant artifact layers', () => {
  const record = createTranscriptRecord({ transcript: [], speakers: [] }, {
    id: 'meeting-1',
    title: 'Planning',
  });
  const artifact = createMeetingArtifact(record);
  artifact.analysis = {
    final: true,
    summary: 'The team picked the launch date.',
    runId: 'run-1',
    createdAt: new Date().toISOString(),
    claims: [{
      id: 'decision-1',
      type: 'decision',
      text: 'Launch Friday.',
      evidenceSegmentIds: ['s1'],
      confidence: 0.9,
    }],
  };
  expect(meetingViewLines(artifact, 'notes')[0]).toBe('The team picked the launch date.');
  expect(meetingViewLines(artifact, 'analysis')).toContain('- Launch Friday.');
  expect(meetingViewLines(artifact, 'chat')[0]).toContain('Ask about this meeting');
});
