import type { MeetingArtifact, MeetingClaimType } from './meeting-artifact.ts';
import { transcriptSegmentId } from './meeting-artifact.ts';
import { compareMeetingEvidence, meetingEvidence } from './meeting-evidence.ts';
import type { TranscriptRecord } from './transcript-types.ts';
import { formatTuiClock } from './tui-state.ts';

export type MeetingView = 'notes' | 'transcript' | 'chat';

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

/** When a line of the notes was said, so it can be found in the transcript. */
function createClock(artifact: MeetingArtifact, record?: TranscriptRecord): (ids?: string[]) => string | undefined {
  if (!record || record.id !== artifact.transcriptId) return () => undefined;
  const starts = new Map(record.transcript.map((segment, index) => [transcriptSegmentId(record, index), segment.start]));
  return (ids) => {
    const times = (ids ?? []).flatMap((id) => starts.get(id) ?? []);
    return times.length ? formatTuiClock(Math.min(...times)) : undefined;
  };
}

/** Lines starting with this are headings; wrappedMeetingRows keeps them, the app makes them bold. */
export const HEADING = '# ';

const CLAIM_GROUPS: Array<[string, MeetingClaimType[]]> = [
  ['Decisions', ['decision']],
  ['Actions', ['action_item']],
  ['Dates', ['date']],
  ['Notes', ['note', 'highlight']],
  ['Facts and feedback', ['fact', 'feedback']],
  ['Resources', ['resource']],
  ['Speaker identities', ['speaker_identity']],
];

export function meetingViewLines(
  artifact: MeetingArtifact,
  view: Exclude<MeetingView, 'transcript'>,
  record?: TranscriptRecord,
): string[] {
  if (view === 'chat') {
    const sources = createSources(artifact, record);
    if (artifact.chat.length === 0) {
      return ['Ask about this meeting with A.', 'Answers cite the transcript segments they use.'];
    }
    return artifact.chat.slice(-8).flatMap((message) => [
      `${message.role === 'user' ? 'You' : 'Sea Shell'}: ${message.text}`,
      ...(message.role === 'assistant' ? sources(message.evidenceSegmentIds) : []),
    ]);
  }

  if (artifact.ai?.off) {
    return [
      'AI is off for this meeting.',
      'Seashell sends it to no model: no live analysis, notes or chat, and agents using the meetings server are refused it.',
      'The transcript is here as usual. Press N to turn AI back on.',
    ];
  }

  const clock = createClock(artifact, record);
  const bullet = (text: string, ids?: string[]) => {
    const at = clock(ids);
    return at ? `- ${text}  ${at}` : `- ${text}`;
  };
  const claims = artifact.analysis?.claims ?? artifact.provisionalClaims;
  const summary = artifact.analysis?.summary || (
    artifact.status === 'failed'
      ? 'The transcript is safe, but the notes failed. Press G to try again.'
      : claims.length ? 'Notes so far. Press G for final notes.' : 'No notes yet. Press G to write them.'
  );
  // A template is the layout the owner chose, so its sections come first. A
  // claim citing the same passage as a section would only say it twice.
  const sections = artifact.analysis?.notes ?? [];
  const cited = new Set(sections.flatMap((section) => section.items.flatMap((item) => item.evidenceSegmentIds)));
  const stale = record && artifact.transcriptEvidence &&
    compareMeetingEvidence(artifact.transcriptEvidence, meetingEvidence(record)) !== 'same';
  return [
    summary,
    ...sections.flatMap((section) => [
      '',
      `${HEADING}${section.heading}`,
      ...(section.items.length
        ? section.items.map((item) => bullet(item.text, item.evidenceSegmentIds))
        : ['- Not discussed.']),
    ]),
    ...CLAIM_GROUPS.flatMap(([title, types]) => {
      const group = claims.filter((claim) => types.includes(claim.type) &&
        !claim.evidenceSegmentIds.some((id) => cited.has(id)));
      return group.length ? ['', `${HEADING}${title}`, ...group.map((claim) => bullet(claim.text, claim.evidenceSegmentIds))] : [];
    }),
    ...(stale ? ['', 'The transcript changed since these notes. Press G to rewrite them.'] : []),
  ];
}
