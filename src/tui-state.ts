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
  const contentRows = Math.max(5, safeRows - 9);
  return {
    compact,
    sidebarWidth: compact
      ? safeColumns - 4
      : Math.min(34, Math.max(24, Math.floor(safeColumns * 0.28))),
    visibleTranscriptRows: contentRows,
    visibleLibraryItems: Math.max(3, contentRows - 3),
  };
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

export const SPEAKER_COLORS = [
  'cyan',
  'magenta',
  'yellow',
  'green',
  'blue',
  'red',
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
