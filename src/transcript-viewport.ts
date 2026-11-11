import { Chalk } from 'chalk';
import wrapAnsi from 'wrap-ansi';
import { stripVTControlCharacters } from 'util';
import { coalesceTranscriptSegments, speakerLabel } from './transcript-renderer.ts';
import type { StructuredTranscript } from './transcript-types.ts';
import { formatTuiClock, SPEAKER_COLORS, speakerColorIndex } from './tui-state.ts';
import { META } from './meeting-tui.ts';

const color = new Chalk({ level: 1 });
const MAX_NAME_COLUMN = 18;
const MIN_COLUMNS_FOR_NAME_COLUMN = 64;

/** One terminal row of a transcript, and when the line it belongs to was said. */
export interface TranscriptRow {
  text: string;
  /** Seconds into the meeting; unknown when the words run together without lines. */
  start?: number;
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
    return [segment.speaker ?? '', segment.speaker === 'LOCAL' && name === 'Microphone' ? 'You' : name];
  }));
  const nameWidth = Math.min(MAX_NAME_COLUMN, Math.max(0, ...[...names.values()].map((name) => name.length)));
  const clockWidth = options.timestamps ? formatTuiClock(segments.at(-1)?.start ?? 0).length : 0;
  // Below this, a name column leaves too little room for the words themselves.
  const stacked = options.speakers && width < MIN_COLUMNS_FOR_NAME_COLUMN;
  return segments.flatMap((segment) => {
    const speakerColor = SPEAKER_COLORS[speakerColorIndex(segment.speaker ?? '')]!;
    const name = names.get(segment.speaker ?? '') ?? '';
    const clock = options.timestamps ? color.dim(formatTuiClock(segment.start).padStart(clockWidth)) : '';
    const text = stripVTControlCharacters(segment.text);
    const timed = (row: string) => ({ text: row, start: segment.start });
    if (stacked) {
      return [[clock, color[speakerColor](name)].filter(Boolean).join('  '), ...wrapAnsi(text, width, { hard: true }).split('\n')].map(timed);
    }
    const label = options.speakers ? color[speakerColor](name.slice(0, nameWidth).padEnd(nameWidth)) : '';
    const prefix = [clock, label].filter(Boolean).join('  ');
    const indent = (clockWidth ? clockWidth + 2 : 0) + (options.speakers ? nameWidth + 2 : 0);
    return wrapAnsi(text, Math.max(1, width - indent), { hard: true }).split('\n')
      .map((line, index) => timed(index === 0 ? `${prefix}  ${line}` : ' '.repeat(indent) + line));
  });
}

/** Notes and chat as terminal rows: bullets hang under their dash, and their meta sits at the right. */
export function wrappedMeetingRows(lines: readonly string[], columns: number): string[] {
  const width = Math.max(1, Math.floor(columns));
  return lines.flatMap((line) => {
    const [body = '', meta] = line.split(META);
    const clean = stripVTControlCharacters(body) || ' ';
    if (!clean.startsWith('- ')) return wrapAnsi(clean, width, { hard: true }).split('\n');
    const rows = wrapAnsi(clean.slice(2), Math.max(1, width - 2), { hard: true }).split('\n')
      .map((row, index) => (index === 0 ? `- ${row}` : `  ${row}`));
    if (!meta) return rows;
    // Who owns it and when it was said sit dim against the right edge: on the
    // bullet's last row when there is room, otherwise on a row of their own.
    const last = rows.at(-1)!;
    const gap = width - Bun.stringWidth(last) - Bun.stringWidth(meta);
    if (gap >= 3) rows[rows.length - 1] = `${last}${' '.repeat(gap)}${color.dim(meta)}`;
    else rows.push(`${' '.repeat(Math.max(2, width - Bun.stringWidth(meta)))}${color.dim(meta)}`);
    return rows;
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
