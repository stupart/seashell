import type { TranscriptLibraryEntry } from './transcript-library.ts';

export type TuiFocus = 'sidebar' | 'transcript';

export interface TuiLayout {
  compact: boolean;
  sidebarWidth: number;
  visibleTranscriptRows: number;
  visibleLibraryItems: number;
}

export const COMPACT_TUI_COLUMNS = 100;

export function tuiLayout(columns: number, rows: number): TuiLayout {
  const safeColumns = Math.max(40, columns);
  const safeRows = Math.max(16, rows);
  const compact = safeColumns < COMPACT_TUI_COLUMNS;
  const contentRows = Math.max(5, safeRows - 9);
  return {
    compact,
    sidebarWidth: compact
      ? safeColumns - 4
      : Math.min(38, Math.max(30, Math.floor(safeColumns * 0.28))),
    visibleTranscriptRows: contentRows,
    visibleLibraryItems: Math.max(3, Math.floor((contentRows - 2) / 2)),
  };
}

export function formatCompactDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  if (hours) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m${String(remainingSeconds).padStart(2, '0')}s`;
  return `${remainingSeconds}s`;
}

export function formatLibraryEntryMeta(
  entry: TranscriptLibraryEntry,
  terse = false,
): string {
  const date = new Date(entry.createdAt);
  const dateLabel = Number.isNaN(date.getTime())
    ? 'Unknown date'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const duration = formatCompactDuration(entry.duration);
  const speakers = entry.speakerCount
    ? terse
      ? `${entry.speakerCount}spk`
      : `${entry.speakerCount} ${entry.speakerCount === 1 ? 'speaker' : 'speakers'}`
    : undefined;
  return [dateLabel, duration, speakers].filter(Boolean).join(' · ');
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
