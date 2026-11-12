import { Chalk } from 'chalk';
import { stripVTControlCharacters } from 'util';
import { coalesceTranscriptSegments, speakerLabel } from './transcript-renderer.ts';
import type { StructuredTranscript } from './transcript-types.ts';
import { formatTuiClock, speakerColors, speakerDisplayName, wrapWords, YOUR_SPEAKER_ID } from './tui-state.ts';
import { bulletParts, CAUTION, CITED_TOO, LINE_REMOVED } from './meeting-tui.ts';

const color = new Chalk({ level: 1 });
const MAX_NAME_COLUMN = 18;
const MIN_COLUMNS_FOR_NAME_COLUMN = 64;

/** One terminal row of a transcript, and when the line it belongs to was said. */
export interface TranscriptRow {
  text: string;
  /** Seconds into the meeting; unknown when the words run together without lines. */
  start?: number;
  /** Where the transcript has columns: this row with its line's time and speaker beside it, for the top of the view. */
  pinned?: string;
  /** Where it stacks: its line's time and speaker, on a row of their own above it at the top of the view. */
  heading?: string;
  /** Not the first row of its line: cut at the top of the view, it starts with "…", so it never reads as the line's start. */
  continued?: true;
}

/**
 * A line wrapped to rows, the rows after its first one column narrower: one cut at the top of the view
 * starts with "…" under its time and speaker, and still fits.
 */
function wrapLine(text: string, columns: number): string[] {
  const [first = '', ...rest] = wrapWords(text, columns);
  return rest.length ? [first, ...wrapWords(rest.join(' '), Math.max(1, columns - 1))] : [first];
}

/**
 * The rows in view from this scroll position. A line cut at the top keeps its time and speaker in
 * view: beside its words where the transcript has columns, on a row above them where it stacks. Its
 * words start with "…", so "00:00 You" over "you landed on the pilot." never reads as one sentence.
 *
 * At the end (`end`, scrolled as far as lastTranscriptScroll goes), the newest words sit on the key
 * bar. Where the transcript stacks, the last line's time and speaker pinned at the top take a row, so
 * the view can come out a row short of full; that row goes above the words, never under them.
 */
export function transcriptWindow(rows: readonly TranscriptRow[], scroll: number, count: number, options: { end?: boolean } = {}): TranscriptRow[] {
  const window = rowsFrom(rows, scroll, count);
  return options.end && scroll > 0 && window.length < count ? [...Array.from({ length: count - window.length }, () => ({ text: '' })), ...window] : window;
}

function rowsFrom(rows: readonly TranscriptRow[], scroll: number, count: number): TranscriptRow[] {
  const top = rows[scroll];
  const timed = (text: string): TranscriptRow => top?.start === undefined ? { text } : { text, start: top.start };
  if (top?.pinned !== undefined) return [timed(top.pinned), ...rows.slice(scroll + 1, scroll + count)];
  if (top?.heading !== undefined) {
    return [timed(top.heading), ...count > 1 ? [top.continued ? { ...top, text: `…${top.text}` } : top] : [],
      ...rows.slice(scroll + 1, scroll + count - 1)];
  }
  return rows.slice(scroll, scroll + count);
}

/**
 * The line a moment of the meeting falls in, by its start: the last line that started by then. A cited
 * line that ran on from the one before it was joined to it, so that is the line to find. Before the
 * first line, the first.
 */
export function lineAt(rows: readonly TranscriptRow[], at: number): number | undefined {
  let found: number | undefined;
  for (const row of rows) if (row.start !== undefined && row.start <= at + 0.5) found = row.start;
  return found ?? rows.find((row) => row.start !== undefined)?.start;
}

/**
 * The furthest the view scrolls: the last row in view, with room for a time and speaker pinned above
 * it. When the row that would sit at the top is the end of a stacked line, its pinned time and speaker
 * would push the last row out, so the view starts at the next line instead, a row short of full
 * (transcriptWindow's `end` puts that row above).
 */
export function lastTranscriptScroll(rows: readonly TranscriptRow[], count: number): number {
  const last = Math.max(0, rows.length - Math.max(1, count));
  return rows[last]?.heading !== undefined && last + 1 < rows.length ? last + 1 : last;
}

/** Scroll physical terminal rows so even a single long segment is fully readable. */
export function transcriptRows(
  record: StructuredTranscript,
  columns: number,
  options: { timestamps: boolean; speakers: boolean },
): string[] {
  return timedTranscriptRows(record, columns, options).map((row) => row.text);
}

/** The same rows as transcriptRows, each with the start of the line it shows. */
export function timedTranscriptRows(
  record: StructuredTranscript,
  columns: number,
  options: { timestamps: boolean; speakers: boolean },
): TranscriptRow[] {
  const width = Math.max(1, Math.floor(columns));
  const segments = coalesceTranscriptSegments(record);
  if (!options.timestamps && !options.speakers) {
    const text = segments.map((segment) => stripVTControlCharacters(segment.text)).join(' ');
    return text ? wrapWords(text, width).map((row) => ({ text: row })) : [];
  }
  const names = new Map(segments.map((segment) => {
    const label = options.speakers ? speakerLabel(record, segment.speaker) : undefined;
    const name = label ? stripVTControlCharacters(label) : '';
    return [segment.speaker ?? '', name ? speakerDisplayName(segment.speaker, name) : ''];
  }));
  const nameWidth = Math.min(MAX_NAME_COLUMN, Math.max(0, ...[...names.values()].map((name) => name.length)));
  const clockWidth = options.timestamps ? formatTuiClock(segments.at(-1)?.start ?? 0).length : 0;
  // Below this, a name column leaves too little room for the words themselves.
  const stacked = options.speakers && width < MIN_COLUMNS_FOR_NAME_COLUMN;
  // You in plain bold; everyone else in a hue of their own, in the order the transcript lists them.
  const colors = speakerColors([...record.speakers.map((speaker) => speaker.id), ...segments.map((segment) => segment.speaker ?? '')]);
  const styled = (id: string, text: string) => id === YOUR_SPEAKER_ID ? color.bold(text) : color[colors.get(id)!](text);
  return segments.flatMap((segment) => {
    const id = segment.speaker ?? '';
    const name = names.get(id) ?? '';
    const clock = options.timestamps ? color.dim(formatTuiClock(segment.start).padStart(clockWidth)) : '';
    const text = stripVTControlCharacters(segment.text);
    const timed = (row: string) => ({ text: row, start: segment.start });
    if (stacked) {
      const heading = [clock, styled(id, name)].filter(Boolean).join('  ');
      return [timed(heading), ...wrapLine(text, width).map((line, index) => ({ ...timed(line), heading, ...index ? { continued: true as const } : {} }))];
    }
    const label = options.speakers ? styled(id, name.slice(0, nameWidth).padEnd(nameWidth)) : '';
    const prefix = [clock, label].filter(Boolean).join('  ');
    const indent = (clockWidth ? clockWidth + 2 : 0) + (options.speakers ? nameWidth + 2 : 0);
    return wrapLine(text, Math.max(1, width - indent)).map((line, index) => index === 0 ? timed(`${prefix}  ${line}`)
      : { ...timed(' '.repeat(indent) + line), pinned: `${prefix}  …${line}`, continued: true as const });
  });
}

/** A bullet's text keeps at least this much room beside who owns it and when it was said. */
const MIN_BULLET_TEXT_COLUMNS = 24;

/**
 * Notes and chat as terminal rows, in one layout at every width. A bullet's text wraps under itself;
 * on its first row, against the right edge, sits who owns it and by when, in the text's own weight,
 * then when it was said, dim. The times share one column, so every owner ends in one place. A point
 * said at several times (a brief's, from several meetings) lists them down that column, one a row
 * (CITED_TOO between them). Where that leaves the text too little room, owner and time go on the
 * row under the text, indented.
 */
export function wrappedMeetingRows(lines: readonly string[], columns: number): string[] {
  const width = Math.max(1, Math.floor(columns));
  const parts = lines.map(bulletParts);
  const timesOf = (clock: string | undefined) => clock ? clock.split(CITED_TOO) : [];
  // The times share one column; "source removed" reaches left past it on its own row rather than widen it for all.
  const clockColumn = Math.max(0, ...parts.flatMap(({ body, clock }) => body.startsWith('- ') && clock && !clock.includes(LINE_REMOVED)
    ? timesOf(clock).map((time) => Bun.stringWidth(time)) : [0]));
  return parts.flatMap(({ body, owner, clock }) => {
    const clean = stripVTControlCharacters(body) || ' ';
    // Something to look at stays marked on every row, so all of it is yellow.
    if (clean.startsWith(CAUTION)) return wrapWords(clean.slice(CAUTION.length), width).map((row) => `${CAUTION}${row}`);
    if (!clean.startsWith('- ')) return wrapWords(clean, width);
    const text = clean.slice(2);
    if (!owner && !clock) return wrapWords(text, Math.max(1, width - 2)).map((row, index) => `${index ? '  ' : '- '}${row}`);
    const [first, ...more] = timesOf(clock);
    const clockWidth = Math.max(clockColumn, first ? Bun.stringWidth(first) : 0);
    const time = first ? color.dim(first.padStart(clockWidth)) : '';
    const shown = owner && first ? `${owner}  ${time}` : owner ?? time;
    // The time column is kept on a line without a time, so its owner still ends where the others do.
    const metaWidth = owner ? Bun.stringWidth(owner) + (clockWidth ? 2 + clockWidth : 0) : clockWidth;
    const room = width - 2 - metaWidth - 2;
    if (room < MIN_BULLET_TEXT_COLUMNS) {
      return [...wrapWords(text, Math.max(1, width - 2)).map((row, index) => `${index ? '  ' : '- '}${row}`),
        `  ${owner && first ? `${owner}  ${color.dim(first)}` : owner ?? color.dim(first!)}`, ...more.map((later) => `  ${color.dim(later)}`)];
    }
    const rows = wrapWords(text, room);
    return Array.from({ length: Math.max(rows.length, 1 + more.length) }, (_, index) => {
      const row = rows[index] ?? '';
      if (index === 0) return `- ${row}${' '.repeat(width - 2 - Bun.stringWidth(row) - metaWidth)}${shown}`;
      const later = more[index - 1];
      return later ? `  ${row}${' '.repeat(Math.max(0, width - 2 - Bun.stringWidth(row) - clockWidth))}${color.dim(later.padStart(clockWidth))}` : `  ${row}`;
    });
  });
}

/** Ink removes the first ESC. Buffer split SGR reports; swallow clicks so their
 * trailing M cannot become the meeting shortcut. Coordinates are one-based. */
export class MouseScrollDecoder {
  private pending = '';

  read(input: string): { consumed: boolean; events: Array<{ delta: number; column: number }> } {
    let text = this.pending + input;
    this.pending = '';
    text = text.replace(/^\x1b/u, '');
    if (!text.startsWith('[<')) return { consumed: false, events: [] };
    const events: Array<{ delta: number; column: number }> = [];
    while (text) {
      const match = /^\[<(\d+);(\d+);(\d+)([Mm])/u.exec(text);
      if (!match) {
        if (/^\[<[\d;]*$/u.test(text) && text.length <= 48) this.pending = text;
        break;
      }
      const button = Number(match[1]) & ~28;
      if (match[4] === 'M' && (button === 64 || button === 65)) {
        events.push({ delta: button === 64 ? -3 : 3, column: Number(match[2]) });
      }
      text = text.slice(match[0].length).replace(/^\x1b/u, '');
    }
    return { consumed: true, events };
  }
}
