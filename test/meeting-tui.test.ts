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

test('meeting answers and claims expose the exact cited passage, without unrelated or stale text', () => {
  const record = createTranscriptRecord({ transcript: [
    { id: 's1', start: 5, end: 7, text: 'We agreed to release' },
    { id: 's2', start: 7, end: 9, text: 'on Monday.' },
    { id: 's3', start: 20, end: 22, text: 'Unrelated private detail.' },
  ], speakers: [] }, { id: 'cited-meeting' });
  const artifact = createMeetingArtifact(record);
  artifact.chat = [{ id: 'a1', role: 'assistant', text: 'Monday.',
    evidenceSegmentIds: ['s2', 's1'], createdAt: new Date().toISOString() }];
  const chat = meetingViewLines(artifact, 'chat', record).join('\n');
  expect(chat).toContain('Source 00:05–00:09: “We agreed to release on Monday.”');
  expect(chat).not.toContain('Unrelated');
  artifact.provisionalClaims = [{ id: 'd1', type: 'decision', text: 'Release Monday.',
    evidenceSegmentIds: ['s1', 's2'], confidence: 0.9 }];
  expect(meetingViewLines(artifact, 'analysis', record).join('\n')).toContain('Source 00:05–00:09');
  artifact.chat[0]!.evidenceSegmentIds = ['missing'];
  expect(meetingViewLines(artifact, 'chat', record).join('\n')).toContain('cited passages are unavailable');
  artifact.chat[0]!.evidenceSegmentIds = ['s1'];
  record.transcript[0]!.text = 'Changed source must not masquerade as old evidence.';
  const stale = meetingViewLines(artifact, 'chat', record).join('\n');
  expect(stale).toContain('Source text changed');
  expect(stale).not.toContain('masquerade');
});
