import { Chalk } from 'chalk';
import wrapAnsi from 'wrap-ansi';
import { stripVTControlCharacters } from 'util';
import { coalesceTranscriptSegments, speakerLabel } from './transcript-renderer.ts';
import type { StructuredTranscript } from './transcript-types.ts';
import { formatTuiClock, SPEAKER_COLORS, speakerColorIndex } from './tui-state.ts';

const color = new Chalk({ level: 1 });

/** Scroll physical terminal rows so even a single long segment is fully readable. */
export function transcriptRows(
  record: StructuredTranscript,
  columns: number,
  options: { timestamps: boolean; speakers: boolean },
): string[] {
  const width = Math.max(1, Math.floor(columns));
  const segments = coalesceTranscriptSegments(record);
  if (!options.timestamps && !options.speakers) {
    const text = segments.map((segment) => stripVTControlCharacters(segment.text)).join(' ');
    return text ? wrapAnsi(text, width, { hard: true }).split('\n') : [];
  }
  return segments.flatMap((segment) => {
    const label = options.speakers ? speakerLabel(record, segment.speaker) : undefined;
    const speakerColor = SPEAKER_COLORS[speakerColorIndex(segment.speaker ?? '')]!;
    const prefix = (options.timestamps ? color.dim(`[${formatTuiClock(segment.start)}] `) : '') +
      (label ? color[speakerColor](`${stripVTControlCharacters(label)}: `) : '');
    return wrapAnsi(prefix + stripVTControlCharacters(segment.text), width, { hard: true }).split('\n');
  });
}

export function wrappedMeetingRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap((line) => wrapAnsi(stripVTControlCharacters(line) || ' ',
    Math.max(1, Math.floor(columns)), { hard: true }).split('\n'));
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
