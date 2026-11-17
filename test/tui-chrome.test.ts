import { expect, test } from 'bun:test';
import chalk from 'chalk';
import React from 'react';
import { render } from 'ink';
import { Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { oneRow, Prompt, ScreenTitle, Toast } from '../src/tui-chrome.tsx';

/** The key bar's row on the narrowest window journeys check: 56 columns, less the frame's two. */
const NARROW = 54;

/** What a component draws, as plain rows, at this many columns. */
async function rows(node: React.ReactElement, columns: number): Promise<string[]> {
  let latest = '';
  // Only a frame with something in it: Ink also writes a bare line break, as it unmounts and under CI.
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) {
    if (stripVTControlCharacters(chunk.toString()).trim()) latest = chunk.toString();
    done();
  } }), { columns, rows: 10 });
  const app = render(node, { stdout: stdout as never, debug: true, patchConsole: false, exitOnCtrlC: false });
  // Ink writes its frame on its own schedule, later on a busy Mac: wait for it rather than for a fixed time.
  const deadline = Date.now() + 2_000;
  while (!latest && Date.now() < deadline) await Bun.sleep(10);
  app.unmount();
  return stripVTControlCharacters(latest).replace(/^\n+|\n+$/gu, '').split('\n');
}

test('a toast or a question too long for the key bar keeps to one row: its short form, its first sentence, then its first clause', () => {
  expect(oneRow('Copied.', NARROW)).toBe('Copied.');
  expect(oneRow('Copied. Paste it in Terminal, then drop in the engine file you were sent.', NARROW)).toBe('Copied.');
  // A question's own short form comes before any sentence of it.
  expect(oneRow('Forget Dana Whitfield\'s voice? Names you gave stay; names Seashell suggested go.', NARROW, 'Forget Dana Whitfield\'s voice?'))
    .toBe('Forget Dana Whitfield\'s voice?');
  // A first sentence that is still too long gives way to its first clause.
  expect(oneRow('System audio unavailable; continuing with microphone only. The helper stopped.', NARROW)).toBe('System audio unavailable');
  // Only words that fit none of those are cut, at the end.
  const cut = oneRow('A single sentence with no clause in it that runs well past the edge of a narrow window', NARROW);
  expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(NARROW);
  expect(cut).toEndWith('…');
});

test('at 56 columns every toast and question takes the key bar\'s one row', async () => {
  const long = 'Nothing to brief from yet: no past meeting has the title "Lunch with Sam" or anyone on its invite.';
  for (const color of ['green', 'yellow', 'red'] as const) {
    const drawn = await rows(React.createElement(Toast, { text: long, color, columns: NARROW }), 56);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toBe('Nothing to brief from yet');
  }
  const asked = await rows(React.createElement(Prompt, { text: 'Rewrite these notes? This replaces the notes written on Friday with new ones.',
    color: 'yellow', hints: [['y', 'rewrite'], ['n', 'keep']], columns: NARROW }), 56);
  expect(asked).toEqual(['Rewrite these notes?  y rewrite  n keep']);
});

test('a title line with no room for its detail keeps what the detail says matters, before the meeting\'s title', async () => {
  const title = { name: 'Call ended · Design review', detail: 'Audio saved · writing notes', short: 'Call ended · writing notes…', keep: 10 };
  expect((await rows(React.createElement(ScreenTitle, title), 100))[0]).toBe('🐚 Seashell  Call ended · Design review  Audio saved · writing notes');
  expect((await rows(React.createElement(ScreenTitle, title), 56))[0]).toBe('🐚  Call ended · writing notes…');
  // Without a short form, the detail simply gives way.
  expect((await rows(React.createElement(ScreenTitle, { ...title, short: undefined }), 56))[0]).toBe('🐚  Call ended · Design review');
});

test('a calm part of the title is dim, its recording mark red, and the rest in the line\'s own colour', async () => {
  let raw = '';
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) {
    if (stripVTControlCharacters(chunk.toString()).trim()) raw = chunk.toString();
    done();
  } }), { columns: 100, rows: 10 });
  const name = '● Recording 1:05 · filming your screen · Design review';
  // Colours as a terminal shows them; a test's output is not one.
  const level = chalk.level;
  chalk.level = 3;
  try {
    const app = render(React.createElement(ScreenTitle, { name, bold: false, calm: ' · filming your screen' }),
      { stdout: stdout as never, debug: true, patchConsole: false, exitOnCtrlC: false });
    const deadline = Date.now() + 2_000;
    while (!raw && Date.now() < deadline) await Bun.sleep(10);
    app.unmount();
  } finally { chalk.level = level; }
  expect(stripVTControlCharacters(raw).split('\n')[0]).toBe(`🐚 Seashell  ${name}`);
  // Dim (2) around the chosen screen only; never yellow (33) or red (31) for it.
  expect(raw).toContain('\x1b[2m · filming your screen\x1b[22m');
  expect(raw).toContain('\x1b[31m●\x1b[39m');
  expect(raw).not.toContain('\x1b[33m');
  expect(raw.match(/\x1b\[31m/gu)).toHaveLength(1);
});
