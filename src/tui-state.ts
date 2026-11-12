import wrapAnsi from 'wrap-ansi';
import { stripVTControlCharacters } from 'util';
import type { TranscriptLibraryEntry } from './transcript-library.ts';

export interface TuiLayout {
  compact: boolean;
  sidebarWidth: number;
  visibleTranscriptRows: number;
  visibleLibraryItems: number;
}

export const COMPACT_TUI_COLUMNS = 72;

export function tuiLayout(columns: number, rows: number): TuiLayout {
  const safeColumns = Math.max(40, columns);
  const safeRows = Math.max(16, rows);
  const compact = safeColumns < COMPACT_TUI_COLUMNS;
  const contentRows = Math.max(5, safeRows - 5);
  return {
    compact,
    sidebarWidth: compact
      ? safeColumns - 4
      : Math.min(40, Math.max(28, Math.floor(safeColumns * 0.34))),
    visibleTranscriptRows: contentRows,
    visibleLibraryItems: Math.max(3, safeRows - 4),
  };
}

export function sameDay(left: string, right: string): boolean {
  return new Date(left).toDateString() === new Date(right).toDateString();
}

const clockTime = (date: Date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  .replace(/\s?([ap])\.?\s?m\.?/iu, (_, half: string) => ` ${half.toLowerCase()}m`);

/**
 * When something happened, in local time, the one way Seashell writes it:
 * "6:44 pm" today, "Nov 7 2:30 pm" before. Without the time, an older day is just "Nov 7".
 */
export function meetingWhen(createdAt: string, now = new Date(), withTime = true): string {
  const created = new Date(createdAt);
  if (created.toDateString() === now.toDateString()) return clockTime(created);
  const day = created.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return withTime ? `${day} ${clockTime(created)}` : day;
}

/**
 * When a meeting coming up starts: "Today 6:31 pm", "Tomorrow 10:00 am", "Fri 9:00 am". In a sentence,
 * today's is just its time and the day is lower case: "6:31 pm", "tomorrow 10:00 am".
 */
export function upcomingWhen(startsAt: string, now = new Date(), inSentence = false): string {
  const at = new Date(startsAt);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (at.toDateString() === now.toDateString()) return inSentence ? clockTime(at) : `Today ${clockTime(at)}`;
  const day = at.toDateString() === tomorrow.toDateString() ? 'Tomorrow' : at.toLocaleDateString('en-US', { weekday: 'short' });
  return `${inSentence && day === 'Tomorrow' ? 'tomorrow' : day} ${clockTime(at)}`;
}

/** The list's date column: the time for today's meetings, the day for older ones. */
export function listWhen(createdAt: string, now = new Date()): string {
  return meetingWhen(createdAt, now, false);
}

/** Marks a list row for a meeting kept with its video; the app draws it dim. */
export const VIDEO_MARK = '▶';

/** List row: the title first, its date right-aligned in a column as wide as the
 * widest date in view, so the titles keep the rest of the row. A meeting with video
 * has ▶ beside its date. */
export function meetingEntryRow(entry: TranscriptLibraryEntry, width: number, now = new Date(), column = 0, video = false): string {
  const marker = entry.captureState === 'recording' ? '● ' : entry.captureState === 'processing' ? '◐ ' : '';
  const when = `${video ? `${VIDEO_MARK} ` : ''}${listWhen(entry.createdAt, now).padStart(column)}`;
  const room = Math.max(4, width - when.length - 1 - marker.length);
  // Old live recordings are titled by their own date, which the row already shows.
  const name = /^Live \d/u.test(entry.title) ? 'Live recording' : entry.title;
  return `${marker}${fitColumns(name, room)} ${when}`;
}

/** A line cut to this many columns around the first place it says the needle, with … where it was cut. */
export function snippetAround(text: string, needle: string, columns: number): string {
  const room = Math.max(8, columns);
  if (Bun.stringWidth(text) <= room) return text;
  const at = Math.max(0, text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()));
  // Start a word or two before the match, so it reads as part of a sentence.
  let start = Math.max(0, Math.min(at - Math.floor(room / 3), text.length - room + 1));
  if (start > 0) {
    const space = text.indexOf(' ', start);
    start = space >= 0 && space < at ? space + 1 : start;
  }
  return fitColumns(start > 0 ? `…${text.slice(start)}` : text, room).trimEnd();
}

/** Text cut or padded to exactly this many terminal columns. An emoji or a CJK
 * character takes two, so counting characters would push the date out of line. */
export function fitColumns(text: string, columns: number): string {
  const width = (value: string) => Bun.stringWidth(value);
  if (width(text) <= columns) return text + ' '.repeat(columns - width(text));
  let cut = '';
  for (const character of text) {
    if (width(cut + character) > columns - 1) break;
    cut += character;
  }
  return `${cut}…${' '.repeat(Math.max(0, columns - 1 - width(cut)))}`;
}

/**
 * Text wrapped at word breaks, with no stray space starting a line and no word alone on the
 * last line: the line above gives up its last word when the two fit together.
 */
export function wrapWords(text: string, columns: number): string[] {
  const width = Math.max(1, Math.floor(columns));
  const lines = wrapAnsi(text, width, { hard: true, trim: true }).split('\n');
  const last = lines.at(-1)!;
  const above = lines.at(-2);
  if (above === undefined || !last.trim() || /\s/u.test(stripVTControlCharacters(last).trim())) return lines;
  const cut = above.lastIndexOf(' ');
  if (cut <= 0) return lines;
  const moved = `${above.slice(cut + 1)} ${last}`;
  if (Bun.stringWidth(stripVTControlCharacters(moved)) > width) return lines;
  return [...lines.slice(0, -2), above.slice(0, cut).trimEnd(), moved];
}

export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, current + delta));
}

export function moveTranscriptScroll(
  current: number,
  delta: number,
  segmentCount: number,
  visibleRows: number,
): number {
  const maximum = Math.max(0, segmentCount - Math.max(1, visibleRows));
  return Math.min(maximum, Math.max(0, current + delta));
}

export function filterLibraryEntries(
  entries: TranscriptLibraryEntry[],
  query: string,
): TranscriptLibraryEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return entries;
  return entries.filter((entry) => [
    entry.title,
    entry.sourceFilename,
    entry.id,
  ].some((value) => value.toLocaleLowerCase().includes(normalized)));
}

/** Speakers other than you, each in a hue of their own. Yellow, red and green are left out: they mean
 * attention, failure and confirmation everywhere else. */
export const SPEAKER_COLORS = [
  'cyan',
  'magenta',
  'blue',
  'cyanBright',
  'magentaBright',
  'blueBright',
] as const;

/** Your own microphone: your name is plain bold, in no speaker's colour. */
export const YOUR_SPEAKER_ID = 'LOCAL';

/** Each other speaker's colour, in the order they are listed, so no two of the first three share a hue. */
export function speakerColors(ids: Iterable<string>): Map<string, (typeof SPEAKER_COLORS)[number]> {
  const colors = new Map<string, (typeof SPEAKER_COLORS)[number]>();
  for (const id of ids) {
    if (id !== YOUR_SPEAKER_ID && !colors.has(id)) colors.set(id, SPEAKER_COLORS[colors.size % SPEAKER_COLORS.length]!);
  }
  return colors;
}

/**
 * A speaker as the screen names them, and as the meeting AI is told them: "You" for your own
 * microphone, "Speaker 1" for a voice Seashell numbered, never a raw id such as REMOTE_01 or
 * SPEAKER_00, which count from zero. The saved label, which agents and exports read, is left as it is.
 */
export function speakerDisplayName(id: string | undefined, label: string): string {
  if (id === YOUR_SPEAKER_ID && (label === 'Microphone' || label === YOUR_SPEAKER_ID)) return 'You';
  const raw = /^(?:REMOTE_)?(?:SPEAKER|REMOTE)_(\d+)$/u.exec(label);
  if (raw) return `Speaker ${Number(raw[1]) + 1}`;
  return label.replace(/^Remote speaker (\d+)$/u, 'Speaker $1');
}

/**
 * A time on the meeting's clock as a sentence says it: "2:01", "0:07", "1:02:03". Only an aligned
 * column pads it ("02:01"), with formatTuiClock.
 */
export function sentenceClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole % 3600 / 60);
  const hours = Math.floor(whole / 3600);
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(whole % 60).padStart(2, '0')}`;
}

/** Compact media-relative clock for the TUI's aligned columns; exports retain millisecond detail. */
export function formatTuiClock(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const second = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minute = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return hour > 0
    ? `${hour}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
    : `${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}
