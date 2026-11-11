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
  .replace(/\s?([ap])\.?m\.?/iu, (_, half: string) => half.toLowerCase());

/** When a meeting happened, short enough to sit beside its title. */
export function meetingWhen(createdAt: string, now = new Date(), withTime = true): string {
  const created = new Date(createdAt);
  if (created.toDateString() === now.toDateString()) return clockTime(created);
  const day = created.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return withTime ? `${day} ${clockTime(created)}` : day;
}

const CLOCK_WIDTH = clockTime(new Date(2000, 0, 1, 12, 30)).length;

/** The list's date column: the day and the time are padded, so "Nov  9" sits over
 * "Nov 10" and " 9:05a" over "10:30a" from one row to the next. */
export function listWhen(createdAt: string, now = new Date(), withTime = true): string {
  const created = new Date(createdAt);
  const time = clockTime(created).padStart(CLOCK_WIDTH);
  if (created.toDateString() === now.toDateString()) return time;
  const day = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).formatToParts(created)
    .map((part) => part.type === 'day' ? part.value.padStart(2) : part.value).join('');
  return withTime ? `${day} ${time}` : day;
}

/** List row: the title first, its date against the right edge. The time appears
 * when it tells two meetings of the same day apart, and the date never truncates.
 * Given the widest date in the list, dates line up on the left of that column and
 * times on the right. */
export function meetingEntryRow(entry: TranscriptLibraryEntry, width: number, now = new Date(), withTime = true, column = 0): string {
  const marker = entry.captureState === 'recording' ? '● ' : entry.captureState === 'processing' ? '◐ ' : '';
  const own = listWhen(entry.createdAt, now, withTime);
  // Today's rows hold only a time, against the edge like every other time, so their titles keep the room.
  const when = sameDay(entry.createdAt, now.toISOString()) ? own : own.padEnd(column);
  const room = Math.max(4, width - when.length - 1 - marker.length);
  // Old live recordings are titled by their own date, which the row already shows.
  const name = /^Live \d/u.test(entry.title) ? 'Live recording' : entry.title;
  const title = name.length > room ? `${name.slice(0, room - 1)}…` : name.padEnd(room);
  return `${marker}${title} ${when}`;
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

/** Yellow and red are left out: they mean attention and failure everywhere else. */
export const SPEAKER_COLORS = [
  'cyan',
  'magenta',
  'green',
  'blue',
] as const;

export function speakerColorIndex(speakerId: string): number {
  let hash = 0;
  for (const character of speakerId) hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
  return hash % SPEAKER_COLORS.length;
}

/** Compact media-relative clock for the TUI; exports retain millisecond detail. */
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
