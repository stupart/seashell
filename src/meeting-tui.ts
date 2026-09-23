import type { MeetingArtifact, MeetingClaimType } from './meeting-artifact.ts';
import { transcriptSegmentId } from './meeting-artifact.ts';
import { compareMeetingEvidence, meetingEvidence } from './meeting-evidence.ts';
import type { TranscriptRecord } from './transcript-types.ts';

export type MeetingView = 'notes' | 'transcript' | 'analysis' | 'chat';

function createSources(artifact: MeetingArtifact, record?: TranscriptRecord): (ids?: string[]) => string[] {
  if (!record) return () => [];
  if (record.id !== artifact.transcriptId ||
      (artifact.transcriptEvidence && compareMeetingEvidence(artifact.transcriptEvidence, meetingEvidence(record)) !== 'same')) {
    return (ids) => ids?.length ? ['  Source text changed; run analysis again.'] : [];
  }
  const indexed = new Map(record.transcript.map((segment, index) => [transcriptSegmentId(record, index), { segment, index }]));
  return (ids) => {
    if (!ids?.length) return [];
    const wanted = new Set(ids);
    const selected = [...wanted].flatMap((id) => {
      const match = indexed.get(id);
      if (!match) return [];
      wanted.delete(id); return [match];
    }).sort((a, b) => a.index - b.index);
    const groups: { last: number; start: number; end: number; text: string }[] = [];
    selected.forEach(({ segment, index }) => {
      const previous = groups.at(-1);
      if (previous && previous.last === index - 1 && segment.start <= previous.end + 1) {
        previous.last = index; previous.end = Math.max(previous.end, segment.end);
        previous.text += ` ${segment.text}`;
      } else groups.push({ last: index, start: segment.start, end: segment.end, text: segment.text });
    });
    const clock = (seconds: number) => {
      const total = Math.max(0, Math.floor(seconds));
      return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
  };
  const lines = groups.slice(0, 3).map((group) => {
    const text = group.text.replace(/\s+/gu, ' ').trim();
    return `  Source ${clock(group.start)}–${clock(Math.ceil(group.end))}: “${text.length > 100 ? text.slice(0, 99) + '…' : text}”`;
  });
  if (groups.length > 3) lines.push(`  + ${groups.length - 3} more passages in the saved meeting evidence.`);
  if (wanted.size) lines.push('  Some cited passages are unavailable.');
  return lines;
  };
}

function claims(artifact: MeetingArtifact, types: MeetingClaimType[], sources: (ids?: string[]) => string[]): string[] {
  return (artifact.analysis?.claims ?? artifact.provisionalClaims)
    .filter((claim) => types.includes(claim.type))
    .flatMap((claim) => [`- ${claim.text}`, ...sources(claim.evidenceSegmentIds)]);
}

export function meetingViewLines(
  artifact: MeetingArtifact,
  view: Exclude<MeetingView, 'transcript'>,
  record?: TranscriptRecord,
): string[] {
  const sources = createSources(artifact, record);
  if (view === 'chat') {
    if (artifact.chat.length === 0) {
      return ['Ask about this meeting with A.', 'Answers cite the transcript segments they use.'];
    }
    return artifact.chat.slice(-8).flatMap((message) => [
      `${message.role === 'user' ? 'You' : 'Sea Shell'}: ${message.text}`,
      ...(message.role === 'assistant' ? sources(message.evidenceSegmentIds) : []),
    ]);
  }

  if (view === 'notes') {
    const summary = artifact.analysis?.summary || (
      artifact.status === 'failed'
        ? 'The transcript is safe, but meeting enrichment failed.'
        : 'No meeting summary yet. Press G to run the configured enrichment route.'
    );
    const actionLines = claims(artifact, ['action_item'], sources);
    const noteLines = claims(artifact, ['note', 'highlight', 'feedback'], sources);
    return [
      summary,
      '',
      'Actions',
      ...(actionLines.length > 0 ? actionLines : ['- None captured.']),
      ...(noteLines.length > 0 ? ['', 'Notes', ...noteLines] : []),
    ];
  }

  const groups: Array<[string, MeetingClaimType[]]> = [
    ['Decisions', ['decision']],
    ['Actions', ['action_item']],
    ['Dates', ['date']],
    ['Facts and feedback', ['fact', 'feedback']],
    ['Resources', ['resource']],
    ['Speaker identities', ['speaker_identity']],
  ];
  const populated = groups.flatMap(([title, types]) => {
    const group = claims(artifact, types, sources);
    return group.length > 0 ? [{ title, group }] : [];
  });
  if (populated.length === 0) return ['No evidence-backed analysis yet.'];
  return populated.flatMap(({ title, group }, index) => {
    return [
      ...(index === 0 ? [] : ['']),
      title,
      ...group,
    ];
  });
}
