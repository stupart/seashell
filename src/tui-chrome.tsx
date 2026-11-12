import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { COMPACT_TUI_COLUMNS, wrapWords } from './tui-state.ts';

export type Hint = readonly [key: string, label: string];
type Tone = 'red' | 'yellow' | 'green' | 'cyan';

const ALWAYS: readonly Hint[] = [[',', 'settings'], ['?', 'help']];
const width = (text: string) => Bun.stringWidth(text);

/** How many columns these hints take, two spaces apart. */
export function hintsWidth(hints: readonly Hint[]): number {
  return hints.reduce((total, [key, label]) => total + width(key) + width(label) + 1, 0) + Math.max(0, hints.length - 1) * 2;
}

/** The hints that fit, most useful first. Help is never dropped, so everything stays findable. */
export function fitHints(hints: readonly Hint[], columns: number, always: readonly Hint[] = ALWAYS): Hint[] {
  const pinned = always.slice(-1);
  const fitted: Hint[] = [];
  for (const hint of [...hints, ...always.slice(0, -1)]) {
    if ([...fitted, ...pinned].some(([key]) => key === hint[0])) continue;
    if (hintsWidth([...fitted, hint, ...pinned]) <= columns) fitted.push(hint);
  }
  return [...fitted, ...pinned];
}

function Hints(props: { hints: readonly Hint[] }) {
  return <>{props.hints.map(([key, label], index) => <React.Fragment key={key}>
    {index > 0 ? '  ' : ''}<Text bold>{key}</Text><Text dimColor> {label}</Text>
  </React.Fragment>)}</>;
}

/** The only key bar. Prompts and toasts take this row; nothing else adds one.
 * Without help, the way back is the hint that is never dropped. */
export function KeyBar(props: { hints: readonly Hint[]; columns: number; help?: boolean }) {
  const always = props.help === false ? props.hints.filter(([key]) => key === 'Esc') : ALWAYS;
  const hints = fitHints(props.hints, props.columns, always);
  return <Text key={shapeOf(hints)} wrap="truncate-end"><Hints hints={hints} /></Text>;
}

/**
 * Ink keeps a line's measured width when only the parts inside it change, then cuts
 * the longer line to the old width. A line keyed by its parts is measured afresh.
 */
const shapeOf = (hints: readonly Hint[]) => hints.map(([key, label]) => `${key} ${label}`).join('|');

/** Text cut to this many columns from its end, keeping the start. */
function cutEnd(text: string, columns: number): string {
  if (width(text) <= columns) return text;
  let cut = '';
  for (const character of text) {
    if (width(cut + character) > columns - 1) break;
    cut += character;
  }
  return `${cut}…`;
}

/** Text cut to this many columns from its start, keeping the end in view, as a typed line scrolls. */
function cutStart(text: string, columns: number): string {
  if (width(text) <= columns) return text;
  let cut = '';
  for (const character of [...text].reverse()) {
    if (width(character + cut) > columns - 1) break;
    cut = character + cut;
  }
  return `…${cut}`;
}

/**
 * A question, a typed answer or work in progress, in the key bar's row. The keys
 * are never cut: a question gives way to its short form first, and typed text
 * scrolls behind its label, which always stays.
 */
export function Prompt(props: {
  /** The question, or the label in front of typed text. */
  text: string;
  /** The question, or the label, for a window too narrow for the whole of it. */
  short?: string;
  /** What has been typed so far; the label stays and this scrolls. */
  input?: string;
  hints?: readonly Hint[];
  columns: number;
  color?: Tone;
  /** Work in progress ("◐ Working…") is dim: it is neither a question nor anyone's colour. */
  dimColor?: boolean;
}) {
  const hints = props.hints ?? [];
  const room = Math.max(4, props.columns - (hints.length ? hintsWidth(hints) + 2 : 0));
  // Typed text keeps at least a few words in view: a long label gives way to its short form first.
  const label = props.input !== undefined && props.short && room - width(props.text) - 1 < 16 ? props.short : props.text;
  const typed = props.input === undefined ? undefined : cutStart(`${props.input}█`, Math.max(2, room - width(label) - 1));
  const text = typed !== undefined ? label
    : width(props.text) <= room ? props.text
    : props.short && width(props.short) <= room ? props.short
    : cutEnd(props.short ?? props.text, room);
  return <Text key={shapeOf(hints)} wrap="truncate-end">
    <Text {...(props.color ? { color: props.color } : {})} dimColor={props.dimColor ?? false}>{text}</Text>
    {typed !== undefined ? ` ${typed}` : ''}
    {hints.length ? <>{'  '}<Hints hints={hints} /></> : null}
  </Text>;
}

/** What just happened, in the key bar's row until the next key: green when it worked, red when it failed. */
export function Toast(props: { text: string; columns: number; color?: Tone }) {
  const color = props.color ?? 'green';
  // A confirmation keeps to the key bar's one row: too long for it, its first sentence says enough.
  // A warning or a failure has no keys to keep, so a long one wraps rather than loses its end.
  const first = props.text.match(/^.+?[.!?](?=\s|$)/u)?.[0];
  const text = color === 'green' && width(props.text) > props.columns && first && width(first) <= props.columns ? first : props.text;
  return <Paragraph text={text} width={props.columns} color={color} />;
}

/** The status slot at the right of the title line: what needs the person, or what Seashell is doing. */
export interface TitleStatus {
  /** The problem or the state alone, never a key: "Mic silent", not "Mic silent · i help". */
  text: string;
  /** For a narrow window, where the whole of text would push the title off its line. */
  short?: string;
  color?: Tone;
  /** The key that fixes it, which leads the key bar. */
  fix?: Hint;
}

/** The key that fixes what the title says goes first in the key bar; the same key later in it gives way. */
export function withFix(hints: readonly Hint[], status?: TitleStatus): Hint[] {
  return status?.fix ? [status.fix, ...hints.filter(([key]) => key !== status.fix![0])] : [...hints];
}

/** A recording's ● is red wherever it leads a line; the words after it keep the line's own colour. */
function Marked(props: { text: string }) {
  return props.text.startsWith('● ') ? <><Text color="red">●</Text>{props.text.slice(1)}</> : <>{props.text}</>;
}

/**
 * The same two rows every screen starts with, which never give way to its content:
 * the mark and the screen's name, its status on the right, then a rule.
 */
export function ScreenTitle(props: { name: string; color?: Tone; bold?: boolean; detail?: string; status?: TitleStatus | undefined;
  /** How much of the name must stay in view, such as "Saved · audio needs review" before a meeting's title.
   * A screen's own name stays whole unless told otherwise; its status gives way instead. */
  keep?: number }) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const room = columns - 2;
  // The name of the app is there on a wide window and never on a narrow one, so it does not come and go with the status.
  const brand = columns >= 72;
  const lead = 2 + (brand ? 9 : 0);
  const nameWidth = props.name ? 2 + width(props.name) : 0;
  // The status gives way to its short form, then to a short screen name: a long meeting title is cut before it.
  const fits = (text?: string) => text !== undefined && lead + nameWidth + 2 + width(text) <= room;
  // One more column for the … that ends a cut name.
  const statusRoom = room - lead - Math.min(nameWidth, 3 + (props.keep ?? width(props.name))) - 2;
  // A dim status with no fix only informs ("Watching for calls"): it shows whole or not at all, and never cuts the name.
  const informs = !props.status?.color && !props.status?.fix;
  const statusText = !props.status ? undefined : fits(props.status.text) ? props.status.text : fits(props.status.short) ? props.status.short
    : !informs && statusRoom >= 8 ? cutEnd(props.status.short ?? props.status.text, statusRoom) : undefined;
  const statusWidth = statusText ? 2 + width(statusText) : 0;
  const detail = props.detail && lead + nameWidth + 2 + width(props.detail) + statusWidth <= room ? props.detail : undefined;
  return <Box flexDirection="column" flexShrink={0}>
    <Box justifyContent="space-between">
      {/* Keyed by its shape, as the key bar is, so a longer title is measured afresh. */}
      <Text key={`${brand}-${Boolean(detail)}`} wrap="truncate-end">🐚{brand ? <Text> <Text bold color="cyan">Seashell</Text></Text> : ''}{props.name ? '  ' : ''}
        <Text bold={props.bold ?? true} {...(props.color ? { color: props.color } : {})}><Marked text={props.name} /></Text>
        {detail ? <Text dimColor>  {detail}</Text> : null}
      </Text>
      {statusText && <Box flexShrink={0} marginLeft={2}>
        <Text {...(props.status?.color ? { color: props.status.color } : { dimColor: true })}><Marked text={statusText} /></Text>
      </Box>}
    </Box>
    <Text dimColor wrap="truncate-end">{'─'.repeat(Math.max(1, room))}</Text>
  </Box>;
}

/** How far a sheet sits in from the frame: where the reader's notes start, a column in on a wide window. */
export function sheetInset(columns: number): number {
  return columns >= COMPACT_TUI_COLUMNS ? 1 : 0;
}

/** Help, audio help, notes setup and speaker naming take the body instead of pushing it around, starting
 * in the column the body they cover starts in. The sheet's name goes on the title line, as every screen's does. */
export function Sheet(props: { children: React.ReactNode }) {
  const { stdout } = useStdout();
  return <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingLeft={sheetInset(stdout?.columns ?? 80)}>
    {props.children}
  </Box>;
}

/** Wraps under its own column a whole item at a time, so nothing is lost on a narrow window. */
export function HelpRow(props: { group: string; keys: string }) {
  return <Box flexShrink={0}>
    <Box width={12} flexShrink={0}><Text bold>{props.group}</Text></Box>
    <Box flexGrow={1} minWidth={0} flexWrap="wrap" columnGap={2}>
      {props.keys.split(' · ').map((item) => <Text key={item}>{item}</Text>)}
    </Box>
  </Box>;
}

/** Text wrapped at word breaks with no stray space starting a line, which Ink's own wrapping leaves,
 * and no word alone on its last line. */
export function Paragraph(props: { text: string; width: number; color?: Tone; dimColor?: boolean; bold?: boolean }) {
  const { text, width: columns, ...style } = props;
  return <Box flexDirection="column" flexShrink={0}>
    {wrapWords(text, Math.max(8, columns)).map((line, index) => <Text key={index} {...style}>{line || ' '}</Text>)}
  </Box>;
}

export const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['Go', 'Enter read · h meetings · / search · ↑↓ move · Esc back · q quit, recording carries on'],
  ['Meeting', '1 notes · 2 transcript · 3 chat · a ask · + add a note · u draft a follow-up · g write notes, with a template · r name speakers · w watch video · c copy · e export · o open folder · d move to Trash'],
  ['Transcript', 't show/hide times · s show/hide speakers · l latest words · n next match'],
  ['When asked', 'y record · n ignore'],
  ['Recording', 'starts and stops with the call · + note this moment · a catch up: "What did I miss?" · space record or stop by hand · V record with video · i audio help'],
  ['Next', 'b meetings coming up, and their briefs'],
  ['Add', 'f import a file · F import and separate speakers'],
  ['Setup', ', settings: speakers, AI and more'],
];

/** What ✎ means, said once in help rather than beside every point. */
export const FROM_YOUR_NOTES_HELP = '✎ marks a point from your own notes.';
