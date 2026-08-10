import type { MeetingArtifact, MeetingClaimType } from './meeting-artifact.ts';

export type MeetingView = 'notes' | 'transcript' | 'analysis' | 'chat';

function claims(artifact: MeetingArtifact, types: MeetingClaimType[]): string[] {
  return (artifact.analysis?.claims ?? artifact.provisionalClaims)
    .filter((claim) => types.includes(claim.type))
    .map((claim) => `- ${claim.text}`);
}

export function meetingViewLines(
  artifact: MeetingArtifact,
  view: Exclude<MeetingView, 'transcript'>,
): string[] {
  if (view === 'chat') {
    if (artifact.chat.length === 0) {
      return ['Ask about this meeting with A.', 'Answers cite the transcript segments they use.'];
    }
    return artifact.chat.slice(-8).map((message) => (
      `${message.role === 'user' ? 'You' : 'Sea Shell'}: ${message.text}`
    ));
  }

  if (view === 'notes') {
    const summary = artifact.analysis?.summary || (
      artifact.status === 'failed'
        ? 'The transcript is safe, but meeting enrichment failed.'
        : 'No meeting summary yet. Press G to run the configured enrichment route.'
    );
    const actionLines = claims(artifact, ['action_item']);
    const noteLines = claims(artifact, ['note', 'highlight', 'feedback']);
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
    const group = claims(artifact, types);
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
