import type { MeetingArtifact, MeetingClaim, MeetingClaimType, OwnerNote } from './meeting-artifact.ts';
import { citedSegmentIds, claimOwnerAndDue, sourceLineRemoved, transcriptSegmentId } from './meeting-artifact.ts';
import { compareMeetingEvidence, meetingEvidence } from './meeting-evidence.ts';
import type { TranscriptRecord } from './transcript-types.ts';
import { formatTuiClock, sentenceClock, speakerDisplayName } from './tui-state.ts';

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
  const lines = groups.slice(0, 3).map((group) => {
    const text = group.text.replace(/\s+/gu, ' ').trim();
    return `  Source ${sentenceClock(group.start)}–${sentenceClock(Math.ceil(group.end))}: “${text.length > 100 ? text.slice(0, 99) + '…' : text}”`;
  });
  if (groups.length > 3) lines.push(`  + ${groups.length - 3} more passages in the saved meeting evidence.`);
  if (wanted.size) lines.push('  Some cited passages are unavailable.');
  return lines;
  };
}

/** When a line of the notes was said, in seconds, so it can be found in the transcript. */
function createStart(artifact: MeetingArtifact, record?: TranscriptRecord): (ids?: readonly string[]) => number | undefined {
  if (!record || record.id !== artifact.transcriptId) return () => undefined;
  const starts = new Map(record.transcript.map((segment, index) => [transcriptSegmentId(record, index), segment.start]));
  return (ids) => {
    const times = (ids ?? []).flatMap((id) => starts.get(id) ?? []);
    return times.length ? Math.min(...times) : undefined;
  };
}

/** Words that say nothing about which point a line is: "send the contract to Acme" is send, contract, Acme. */
const STOP_WORDS = new Set(`a an the and or but nor so to of in on at by for with from into onto about over as than then
  is are was were be been being am will would shall should can could may might must do does did done have has had
  it its this that these those there here i me my we us our you your he him his she her they them their who whom
  what which when where how why if not no yes up out also just all any each some let lets s t d ll re ve m`.split(/\s+/u));

export function wordsOf(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** The words that tell one point from another. */
export function contentWords(text: string): Set<string> {
  return new Set([...wordsOf(text)].filter((word) => !STOP_WORDS.has(word)));
}

/** Lines starting with this are headings; wrappedMeetingRows keeps them, the app makes them bold. */
export const HEADING = '# ';
/** A heading under a heading: an extractor's name under Insights. */
export const SUBHEADING = '## ';
/** Lines starting with this are something to look at, in yellow; wrappedMeetingRows keeps it on every row they wrap to. */
export const CAUTION = '! ';
/** Under your notes when the engine that wrote the notes could not read them; the key bar leads with AI settings. */
export const OWNER_NOTES_UNREAD = "Written without your notes: this AI can't read them yet.";
/**
 * Splits a bullet from what sits against the right edge: who owns it and by when, then when it was said.
 * A bullet with either reads `- text META owner META clock`, with an empty part where one is unknown.
 */
export const META = '\t';
/**
 * Marks a point that came from something the owner typed. It leads the time in
 * the dim right column, so the words of the point stay as written; help says
 * what it means.
 */
export const FROM_YOUR_NOTES = '✎';
/** Between the times of a point said at several (a brief's, from several meetings): one a row, down the time column. */
export const CITED_TOO = '\n';
/** In the time column of a point whose every cited line was removed from the transcript: its source, as help says. */
export const LINE_REMOVED = 'source removed';

/** A line of the notes taken apart: its text, who owns it and by when, and when it was said. */
export function bulletParts(line: string): { body: string; owner?: string; clock?: string } {
  const [body = '', owner, clock] = line.split(META);
  return { body, ...(owner ? { owner } : {}), ...(clock ? { clock } : {}) };
}

/** The notes as plain text, for the clipboard. */
export function plainMeetingLines(lines: readonly string[]): string[] {
  return lines.map((line) => {
    if (line.startsWith(SUBHEADING)) return line.slice(SUBHEADING.length);
    if (line.startsWith(HEADING)) return line.slice(HEADING.length);
    if (line.startsWith(CAUTION)) return line.slice(CAUTION.length);
    const { body, owner, clock } = bulletParts(line);
    return [body, owner, clock?.split(CITED_TOO).join('; ')].filter(Boolean).join('  ');
  });
}

/**
 * What the meeting left to do leads, then what it settled, left open and put at risk. A template's
 * section with one of these names joins its group, so an action is never split across two headings.
 */
const LEADING_GROUPS: Array<[string, MeetingClaimType[], RegExp]> = [
  ['Actions', ['action_item', 'follow_up'], /^(actions?|action items?|next|next steps?|follow[- ]?ups?|to[- ]?dos?)$/iu],
  ['Decisions', ['decision'], /^decisions?$/iu],
  ['Open questions', ['open_question'], /^open questions?$/iu],
  ['Risks', ['risk'], /^risks?$/iu],
];

/**
 * After the template: everything else the notes found. "Notes" already names the tab, the AI's
 * notes and yours, so the AI's loose points are what else was said.
 */
const TRAILING_GROUPS: Array<[string, MeetingClaimType[]]> = [
  ['Dates', ['date']],
  ['Also said', ['note', 'highlight']],
  ['Facts and feedback', ['fact', 'feedback']],
  ['Resources', ['resource']],
  ["Who's who", ['speaker_identity']],
];

/** A person's name as written: up to four capitalised words, "Dana Whitfield", never "IT" or "the host". */
const PERSON = /^(\p{Lu}[\p{Ll}'’-][\p{L}'’-]*(?:\s+\p{Lu}[\p{Ll}'’-][\p{L}'’-]*){0,3})/u;

/**
 * The names Who's who gives speakers who have none yet, for the speaker picker to suggest. A claim that
 * says whom it is about (its speaker and person) is read as that; otherwise only "Speaker 1 is Dana
 * Whitfield, …" names Speaker 1. A speaker given two names, or a name another speaker already has or is
 * given, is left unnamed: a suggestion is one key from being kept, so it has to be unambiguous.
 */
export function whosWhoNames(
  claims: readonly Pick<MeetingClaim, 'type' | 'text' | 'speakerId' | 'person'>[],
  speakers: readonly { id: string; label: string; suggestion?: unknown }[],
): Map<string, string> {
  const unnamed = speakers.filter((speaker) => !speaker.suggestion && /^(?:Remote speaker|SPEAKER_)\s?\d+$/u.test(speaker.label));
  const found = new Map<string, Set<string>>();
  for (const claim of claims) {
    if (claim.type !== 'speaker_identity') continue;
    const named = claim.speakerId && claim.person?.trim() ? unnamed.filter((speaker) => speaker.id === claim.speakerId).map((speaker) => [speaker, claim.person!.trim()] as const)
      : unnamed.flatMap((speaker) => {
        const text = claim.text.trim();
        const called = [speakerDisplayName(speaker.id, speaker.label), speaker.label].find((name) => text.toLocaleLowerCase().startsWith(`${name.toLocaleLowerCase()} `));
        const rest = called && /^(?:is|was)\s+(?:(?:probably|likely|most likely)\s+)?(.*)$/su.exec(text.slice(called.length).trim())?.[1];
        const name = rest ? PERSON.exec(rest)?.[1] : undefined;
        return name ? [[speaker, name] as const] : [];
      });
    for (const [speaker, name] of named) found.set(speaker.id, new Set([...found.get(speaker.id) ?? [], name]));
  }
  const taken = new Set(speakers.filter((speaker) => !unnamed.includes(speaker)).map((speaker) => speaker.label.toLocaleLowerCase()));
  const names = [...found].flatMap(([id, set]) => set.size === 1 ? [[id, [...set][0]!] as const] : []);
  return new Map(names.filter(([id, name]) => !taken.has(name.toLocaleLowerCase())
    && !names.some(([other, otherName]) => other !== id && otherName.toLocaleLowerCase() === name.toLocaleLowerCase())));
}

/** A line of a template's section: its words and the lines of the transcript, or your notes, it rests on. */
type TemplateLine = { text: string; evidenceSegmentIds: string[]; removedEvidenceSegmentIds?: string[]; ownerNoteIds?: string[] };

/** Words for you as a line or a claim may name you: the notes call you "You"; a template may say "Us". */
const YOU = /^(?:you|i|me|we|us|our side|our team|my side)$/iu;

/** Who a template's line says will do it, before a colon: "Dana: share the list", "You: send it". */
export function lineOwner(text: string): string | undefined {
  const named = /^([^:]{1,40}):\s/u.exec(text.trim())?.[1]?.trim();
  return named && (YOU.test(named) || PERSON.exec(named)?.[1] === named) ? named : undefined;
}

/** "Dana" and "Dana Whitfield" are one person; "Us" and "You" are both you. */
export function sameOwner(left: string, right: string): boolean {
  if (YOU.test(left.trim()) || YOU.test(right.trim())) return YOU.test(left.trim()) && YOU.test(right.trim());
  const [a, b] = [[...wordsOf(left)], [...wordsOf(right)]];
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length > 0 && shorter.every((word, index) => word === longer[index]);
}

/** Words that say when: "Friday", "November", "week", "17th". */
const WHEN = new Set(`monday tuesday wednesday thursday friday saturday sunday january february march april june july august
  september october november december jan feb mar apr jun jul aug sep sept oct nov dec today tonight tomorrow week weekend
  month quarter eod eow eom`.split(/\s+/u));
function whenWords(text: string): string[] {
  return [...wordsOf(text)].filter((word) => WHEN.has(word) || /^\d+(?:st|nd|rd|th)$/u.test(word));
}

/** When a line says it is due that its claim, which has no due date, does not say: "by Friday". */
function addsWhen(line: TemplateLine, claim: MeetingClaim): boolean {
  const said = wordsOf(claim.text);
  return !claim.due && whenWords(line.text).some((word) => !said.has(word));
}

/** A line and a claim that name different owners, or different dates, are two points, however alike. */
function differ(line: TemplateLine, claim: MeetingClaim): boolean {
  if (claim.type !== 'action_item' && claim.type !== 'follow_up') return false;
  const owner = lineOwner(line.text);
  if (owner && claim.person && !sameOwner(owner, claim.person)) return true;
  const due = wordsOf(`${claim.due ?? ''} ${claim.text}`);
  return Boolean(claim.due) && whenWords(line.text).some((word) => !due.has(word));
}

/**
 * Which of a typed group's claims each template line says again. The lines cited come first: a
 * line and a claim resting on the same or overlapping lines of the transcript, or on the same note
 * of yours, are one point. The words come second: they must share more than half of the shorter
 * one's words, and when a line could be several claims, the one it shares most with is it, or,
 * tied, none is. A line and a claim with a different owner or due date stay two points.
 */
export function samePoints<L extends TemplateLine>(lines: readonly L[], claims: readonly MeetingClaim[]): Map<L, MeetingClaim> {
  const pairs = new Map<L, MeetingClaim>();
  const taken = new Set<MeetingClaim>();
  for (const line of lines) {
    const cited = new Set([...citedSegmentIds(line), ...(line.ownerNoteIds ?? []).map((id) => `note:${id}`)]);
    const words = contentWords(line.text);
    const scored = claims.flatMap((claim) => {
      const sources = [...citedSegmentIds(claim), ...(claim.ownerNoteIds ?? []).map((id) => `note:${id}`)];
      if (taken.has(claim) || !sources.some((id) => cited.has(id)) || differ(line, claim)) return [];
      const other = contentWords(claim.text);
      const shared = [...words].filter((word) => other.has(word)).length / Math.max(1, Math.min(words.size, other.size));
      return shared > 0.5 ? [{ claim, shared }] : [];
    }).sort((left, right) => right.shared - left.shared);
    const [best, next] = scored;
    if (best && (!next || best.shared > next.shared)) {
      pairs.set(line, best.claim);
      taken.add(best.claim);
    }
  }
  return pairs;
}

/**
 * Of a point said twice, the row to keep: the one that says who and by when. The claim, with its
 * owner and due date in their column, unless the line names an owner or a date the claim lacks.
 */
export function linePreferred(line: TemplateLine, claim: MeetingClaim): boolean {
  const action = claim.type === 'action_item' || claim.type === 'follow_up';
  const claimSays = (claim.person ? 1 : 0) + (claim.due ? 1 : 0);
  const lineSays = action ? (lineOwner(line.text) ? 1 : 0) + (addsWhen(line, claim) ? 1 : 0) : 0;
  return lineSays > claimSays;
}

export function meetingViewLines(
  artifact: MeetingArtifact,
  view: Exclude<MeetingView, 'transcript'>,
  record?: TranscriptRecord,
  /** Everything the owner typed, including notes still in a recording's bundle; meeting.json's when unset. */
  ownerNotes: readonly OwnerNote[] = artifact.ownerNotes ?? [],
  /** The call is still being recorded, so notes cannot be written yet. */
  recording = false,
): string[] {
  if (view === 'chat') {
    const sources = createSources(artifact, record);
    if (artifact.chat.length === 0) {
      return ['Ask about this meeting with a.', 'Answers cite the transcript segments they use.'];
    }
    return artifact.chat.slice(-8).flatMap((message) => [
      `${message.role === 'user' ? 'You' : 'Seashell'}: ${message.text}`,
      ...(message.role === 'assistant' ? sources(citedSegmentIds(message)) : []),
    ]);
  }

  // What the owner typed, in the order it happened, each with its time on the right.
  const noteBullet = (note: OwnerNote) => note.at === undefined ? `- ${note.text}` : `- ${note.text}${META}${META}${formatTuiClock(note.at)}`;
  const notesById = new Map(ownerNotes.map((note) => [note.id, note]));
  if (artifact.ai?.off) {
    return [
      'AI is off for this meeting.',
      'Seashell sends it to no model: no live analysis, notes or chat, and agents using the meetings server are refused it.',
      'The transcript is here as usual. Press g to turn AI back on.',
      ...(ownerNotes.length ? ['', `${HEADING}Your notes`, ...ownerNotes.map(noteBullet)] : []),
    ];
  }

  const start = createStart(artifact, record);
  type Item = { text: string; ids: readonly string[]; owner?: string | undefined; removed?: boolean; notes?: readonly string[] | undefined };
  // A point from the owner's notes is placed where they wrote it, when the transcript cannot place it.
  const at = (item: Item) => start(item.ids) ?? (item.notes ?? []).map((id) => notesById.get(id)?.at)
    .filter((time): time is number => time !== undefined).sort((a, b) => a - b)[0];
  // The time is the citation: it finds the line in the transcript. ✎ before it says the point came from your notes.
  // A point whose every cited line was removed stays, and says so where its time would be, dim, so its
  // words stay as written; one that only ever rested on your notes cited no line, so it is simply yours.
  const bullet = (item: Item) => {
    const said = at(item);
    const time = item.removed ? LINE_REMOVED : said === undefined ? '' : formatTuiClock(said);
    const clock = item.notes?.length ? (time ? `${FROM_YOUR_NOTES} ${time}` : FROM_YOUR_NOTES) : time;
    return item.owner || clock ? `- ${item.text}${META}${item.owner ?? ''}${META}${clock}` : `- ${item.text}`;
  };
  // In the order they were said; anything Seashell cannot place keeps its place at the end.
  const inOrder = (items: Item[]) => items.map((item, index) => ({ item, index, at: at(item) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.at - b.at || a.index - b.index).map(({ item }) => item);
  const claims = artifact.analysis?.claims ?? artifact.provisionalClaims;
  const summary = artifact.analysis?.summary || (
    artifact.status === 'failed'
      ? 'The transcript is safe, but the notes failed. Press g to try again.'
      : artifact.status === 'reconciling' ? 'Writing the notes…'
      : recording ? claims.length ? 'Notes so far. The final notes are written when the call ends.' : 'Notes are written when the call ends.'
      : claims.length ? 'Notes so far. Press g for final notes.' : 'No notes yet. Press g to write them.'
  );
  // Actions and decisions lead, so they are never a scroll away. Decisions, actions, open
  // questions and risks always show what the notes found of each kind; a template's section
  // may say one again where it fits the template. A template is the layout the owner chose,
  // so its other sections follow. Anything else goes only when a section says the same thing
  // about the same moment: either alone can be a different point, and losing one is worse
  // than reading it twice.
  const sections = artifact.analysis?.notes ?? [];
  type Said = { words: Set<string>; passages: Set<string> };
  type Line = (typeof sections)[number]['items'][number];
  const saying = (text: string, ids: readonly string[]): Said => ({ words: contentWords(text), passages: new Set(ids) });
  // The same moment, and most of the words of the longer of the two, so a short
  // line cannot stand in for a longer one that says more ("to Globex", "by Monday").
  const echoes = (line: Said, other: Said) => [...line.passages].some((id) => other.passages.has(id)) &&
    [...line.words].filter((word) => other.words.has(word)).length >= Math.max(2, Math.max(line.words.size, other.words.size) * 0.7);
  // An action or follow-up says who and by when, as it was said.
  const ownerOf = (claim: MeetingClaim) =>
    claim.type === 'action_item' || claim.type === 'follow_up' ? claimOwnerAndDue(claim) : undefined;
  // A template's line restates at most one claim. It shows the owner and due date
  // the claim recorded only when no other claim also matches it.
  const restated = new Map(sections.flatMap((section) => section.items).map((item) => {
    const line = saying(item.text, item.evidenceSegmentIds);
    const matches = claims.filter((claim) => echoes(saying(claim.text, claim.evidenceSegmentIds), line));
    return [item, { line, claim: matches.length === 1 ? matches[0] : undefined }] as const;
  }));
  const said = [...restated.values()].map(({ line }) => line);
  const repeated = (claim: MeetingClaim) => [...restated.values()].some((line) => line.claim === claim);
  const ownerFor = (item: Line) => {
    const claim = restated.get(item)?.claim;
    return claim && ownerOf(claim);
  };
  const shown = [...said];
  // A note that only your notes say, which Humain keeps as your note: nobody said it, so it is never
  // "Also said". Your note stays under Your notes, in your words, unless another point already uses it.
  const onlyYours = (claim: MeetingClaim) => claim.type === 'note' && !claim.evidenceSegmentIds.length &&
    !claim.removedEvidenceSegmentIds?.length && Boolean(claim.ownerNoteIds?.length);
  const ofKind = (types: MeetingClaimType[]) => claims.filter((claim) => types.includes(claim.type) && !onlyYours(claim));
  const fromClaim = (claim: MeetingClaim): Item => ({ text: claim.text, ids: claim.evidenceSegmentIds, owner: ownerOf(claim),
    removed: sourceLineRemoved(claim), notes: claim.ownerNoteIds });
  const fromLine = (item: Line, owner?: string): Item => ({ text: item.text, ids: item.evidenceSegmentIds, owner,
    removed: sourceLineRemoved(item), notes: item.ownerNoteIds });
  // The rest of what the notes found goes where a template's line has not already said it.
  const fromClaims = (types: MeetingClaimType[]): Item[] => {
    const items = ofKind(types).filter((claim) => !repeated(claim));
    shown.push(...items.map((claim) => saying(claim.text, claim.evidenceSegmentIds)));
    return items.map(fromClaim);
  };
  const groupOf = (heading: string) => LEADING_GROUPS.find(([, , names]) => names.test(heading.trim()));
  const stale = record && artifact.transcriptEvidence &&
    compareMeetingEvidence(artifact.transcriptEvidence, meetingEvidence(record)) !== 'same';
  // A template's "Next steps" joins Actions, and its line of an action the notes also found is that
  // action said twice: one row, the one that says who and by when (onePoint).
  const leading = LEADING_GROUPS.flatMap(([title, types]) => {
    const joined = sections.filter((section) => groupOf(section.heading)?.[0] === title);
    const lines = joined.flatMap((section) => section.items);
    const kinds = ofKind(types);
    shown.push(...kinds.map((claim) => saying(claim.text, claim.evidenceSegmentIds)));
    const pairs = samePoints(lines, kinds);
    const items = inOrder([
      ...lines.map((line) => {
        const claim = pairs.get(line);
        if (!claim) return fromLine(line);
        const kept = linePreferred(line, claim) ? fromLine(line) : fromClaim(claim);
        const notes = [...new Set([...line.ownerNoteIds ?? [], ...claim.ownerNoteIds ?? []])];
        return { ...kept, notes: notes.length ? notes : undefined };
      }),
      ...kinds.filter((claim) => ![...pairs.values()].includes(claim)).map(fromClaim),
    ]);
    // A section the template asks for says so when the meeting never got to it.
    if (!items.length) return joined.length ? ['', `${HEADING}${title}`, '- Not discussed.'] : [];
    return ['', `${HEADING}${title}`, ...items.map(bullet)];
  });
  const template = sections.filter((section) => !groupOf(section.heading)).flatMap((section) => [
    '',
    `${HEADING}${section.heading}`,
    ...(section.items.length ? section.items.map((item) => bullet(fromLine(item, ownerFor(item)))) : ['- Not discussed.']),
  ]);
  const trailing = TRAILING_GROUPS.flatMap(([title, types]) => {
    const items = fromClaims(types);
    return items.length ? ['', `${HEADING}${title}`, ...items.map(bullet)] : [];
  });
  // Each extractor once, by name, then its fields as labelled lines. What the notes
  // already say is left out, and so is an empty field. A field's name is left off when
  // it is the only one left, or when the extractor's name already says it ("Customer pains" over "Pains").
  const insights = (artifact.insights ?? []).flatMap((insight) => {
    // Rewriting the notes does not run an extractor that only runs by hand, so each says when it may be stale.
    const name = insight.outdated ? `${insight.extractor} (may be out of date)` : insight.extractor;
    if (!insight.fields.some((field) => field.items.length)) return [`${name}: nothing found.`];
    const fields = insight.fields.map((field) => ({ field, items: field.items
      .filter((item) => !shown.some((other) => echoes(saying(item.text, item.evidenceSegmentIds), other))) }))
      .filter(({ items }) => items.length);
    const named = wordsOf(insight.extractor);
    const lines = fields.flatMap(({ field, items }) => {
      const label = fields.length > 1 && ![...wordsOf(field.name)].every((word) => named.has(word));
      return items.map((item) => bullet({ text: label ? `${field.name}: ${item.text}` : item.text, ids: item.evidenceSegmentIds, removed: sourceLineRemoved(item) }));
    });
    return lines.length ? [`${SUBHEADING}${name}`, ...lines] : [];
  });
  // Notes the AI has not read yet, or could not: during the call, or before notes are written. And
  // notes it kept as yours, about something nobody said. Once the notes use one, it shows there, marked ✎,
  // and not here a second time.
  const used = new Set([...claims.filter((claim) => !onlyYours(claim)).flatMap((claim) => claim.ownerNoteIds ?? []),
    ...sections.flatMap((section) => section.items.flatMap((item) => item.ownerNoteIds ?? []))]);
  const unused = ownerNotes.filter((note) => !used.has(note.id));
  const yours = unused.length ? ['', `${HEADING}Your notes`, ...unused.map(noteBullet),
    ...(artifact.analysis?.ownerNotesUnread ? [`${CAUTION}${OWNER_NOTES_UNREAD}`] : [])] : [];
  return [
    summary,
    ...yours,
    ...leading,
    ...template,
    ...trailing,
    ...(insights.length ? ['', `${HEADING}Insights`, ...insights] : []),
    ...(stale ? ['', 'The transcript changed since these notes. Press g to rewrite them.']
      : artifact.notesOutdated ? ['', `${artifact.notesOutdated.reason} after these notes were written, so they may be out of date. Press g to rewrite them.`]
      : []),
  ];
}
