import { Chalk } from 'chalk';
import wrapAnsi from 'wrap-ansi';
import { stripVTControlCharacters } from 'util';
import { coalesceTranscriptSegments, speakerLabel } from './transcript-renderer.ts';
import type { StructuredTranscript } from './transcript-types.ts';
import { formatTuiClock, speakerColors, speakerDisplayName, wrapWords, YOUR_SPEAKER_ID } from './tui-state.ts';
import { bulletParts } from './meeting-tui.ts';

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
}

/**
 * The rows in view from this scroll position. A line cut at the top keeps its time and speaker in
 * view: beside its words where the transcript has columns, on a row above them where it stacks.
 */
export function transcriptWindow(rows: readonly TranscriptRow[], scroll: number, count: number): TranscriptRow[] {
  const top = rows[scroll];
  const timed = (text: string): TranscriptRow => top?.start === undefined ? { text } : { text, start: top.start };
  if (top?.pinned !== undefined) return [timed(top.pinned), ...rows.slice(scroll + 1, scroll + count)];
  if (top?.heading !== undefined) return [timed(top.heading), ...rows.slice(scroll, scroll + count - 1)];
  return rows.slice(scroll, scroll + count);
}

/** The furthest the view scrolls: the last row in view, with room for a time and speaker pinned above it. */
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
    return text ? wrapAnsi(text, width, { hard: true }).split('\n').map((row) => ({ text: row })) : [];
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
      return [timed(heading), ...wrapAnsi(text, width, { hard: true }).split('\n').map((line) => ({ ...timed(line), heading }))];
    }
    const label = options.speakers ? styled(id, name.slice(0, nameWidth).padEnd(nameWidth)) : '';
    const prefix = [clock, label].filter(Boolean).join('  ');
    const indent = (clockWidth ? clockWidth + 2 : 0) + (options.speakers ? nameWidth + 2 : 0);
    return wrapAnsi(text, Math.max(1, width - indent), { hard: true }).split('\n')
      .map((line, index) => index === 0 ? timed(`${prefix}  ${line}`) : { ...timed(' '.repeat(indent) + line), pinned: `${prefix}  ${line}` });
  });
}

/** A bullet's text keeps at least this much room beside who owns it and when it was said. */
const MIN_BULLET_TEXT_COLUMNS = 24;

/**
 * Notes and chat as terminal rows, in one layout at every width. A bullet's text wraps under itself;
 * on its first row, against the right edge, sits who owns it and by when, in the text's own weight,
 * then when it was said, dim. The times share one column, so every owner ends in one place. Where
 * that leaves the text too little room, owner and time go on the row under the text, indented.
 */
export function wrappedMeetingRows(lines: readonly string[], columns: number): string[] {
  const width = Math.max(1, Math.floor(columns));
  const parts = lines.map(bulletParts);
  const clockColumn = Math.max(0, ...parts.map(({ body, clock }) => body.startsWith('- ') && clock ? clock.length : 0));
  return parts.flatMap(({ body, owner, clock }) => {
    const clean = stripVTControlCharacters(body) || ' ';
    if (!clean.startsWith('- ')) return wrapWords(clean, width);
    const text = clean.slice(2);
    if (!owner && !clock) return wrapWords(text, Math.max(1, width - 2)).map((row, index) => `${index ? '  ' : '- '}${row}`);
    const time = clock ? color.dim(clock.padStart(clockColumn)) : '';
    const shown = owner && clock ? `${owner}  ${time}` : owner ?? time;
    // The time column is kept on a line without a time, so its owner still ends where the others do.
    const metaWidth = owner ? Bun.stringWidth(owner) + (clockColumn ? 2 + clockColumn : 0) : clockColumn;
    const room = width - 2 - metaWidth - 2;
    if (room < MIN_BULLET_TEXT_COLUMNS) {
      return [...wrapWords(text, Math.max(1, width - 2)).map((row, index) => `${index ? '  ' : '- '}${row}`),
        `  ${owner && clock ? `${owner}  ${color.dim(clock)}` : owner ?? color.dim(clock!)}`];
    }
    return wrapWords(text, room).map((row, index) => index
      ? `  ${row}`
      : `- ${row}${' '.repeat(width - 2 - Bun.stringWidth(row) - metaWidth)}${shown}`);
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
