import React from 'react';
import { Box, Text, useStdout } from 'ink';
import wrapAnsi from 'wrap-ansi';

export type Hint = readonly [key: string, label: string];

const ALWAYS: readonly Hint[] = [[',', 'settings'], ['?', 'help']];

/** The hints that fit, most useful first. Help is never dropped, so everything stays findable. */
export function fitHints(hints: readonly Hint[], columns: number, always: readonly Hint[] = ALWAYS): Hint[] {
  const width = (list: readonly Hint[]) => list.reduce((total, [key, label]) => total + key.length + label.length + 1, 0) +
    Math.max(0, list.length - 1) * 2;
  const pinned = always.slice(-1);
  const fitted: Hint[] = [];
  for (const hint of [...hints, ...always.slice(0, -1)]) {
    if ([...fitted, ...pinned].some(([key]) => key === hint[0])) continue;
    if (width([...fitted, hint, ...pinned]) <= columns) fitted.push(hint);
  }
  return [...fitted, ...pinned];
}

/** The only key bar. Prompts and toasts take this row; nothing else adds one.
 * Without help, the way back is the hint that is never dropped. */
export function KeyBar(props: { hints: readonly Hint[]; columns: number; help?: boolean }) {
  const always = props.help === false ? props.hints.filter(([key]) => key === 'Esc') : ALWAYS;
  return <Text wrap="truncate-end">
    {fitHints(props.hints, props.columns, always).map(([key, label], index) => <React.Fragment key={key}>
      {index > 0 ? '  ' : ''}<Text bold>{key}</Text><Text dimColor> {label}</Text>
    </React.Fragment>)}
  </Text>;
}

/** The same two rows every screen starts with, which never give way to its content. */
export function ScreenTitle(props: { name: string; detail?: React.ReactNode }) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  return <Box flexDirection="column" flexShrink={0}>
    <Text wrap="truncate-end">🐚{columns < 72 ? '' : <Text> <Text bold color="cyan">Seashell</Text></Text>}  <Text bold>{props.name}</Text>{props.detail}</Text>
    <Text dimColor wrap="truncate-end">{'─'.repeat(Math.max(1, columns - 2))}</Text>
  </Box>;
}

/** Help, audio help, notes setup and speaker naming take the body instead of pushing it around. */
export function Sheet(props: { title: string; children: React.ReactNode }) {
  return <Box flexDirection="column" flexGrow={1} overflow="hidden">
    <Text bold color="cyan">{props.title}</Text>
    <Box height={1} />
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

/** Text wrapped at word breaks with no stray space starting a line, which Ink's own wrapping leaves. */
export function Paragraph(props: { text: string; width: number; color?: 'red' | 'yellow' | 'green' | 'cyan'; dimColor?: boolean; bold?: boolean }) {
  const { text, width, ...style } = props;
  return <Box flexDirection="column" flexShrink={0}>
    {wrapAnsi(text, Math.max(8, width), { hard: true, trim: true }).split('\n')
      .map((line, index) => <Text key={index} {...style}>{line || ' '}</Text>)}
  </Box>;
}

export const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['Move', '↑↓ move · Enter read · h meetings · Esc back · / search · q quit, recording carries on'],
  ['Meeting', '1 notes · 2 transcript · 3 chat · a ask · g write notes · n notes options · r name speakers · c copy · e export · o open folder · d move to Trash'],
  ['Transcript', 't times · s speaker names · l latest words'],
  ['When asked', 'm record · x ignore'],
  ['Recording', 'starts and stops with the call · space record or stop by hand · i audio help'],
  ['Add', 'f import a file · F import and separate speakers'],
  ['Setup', ', settings · p AI · v speaker names'],
];
