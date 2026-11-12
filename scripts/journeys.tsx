/**
 * Every user journey through the terminal app, rendered from the real <App />
 * against a made-up library. `bun run journeys` writes out/journeys/: a page of
 * every screen, plus each frame as text for reviewers.
 *
 *   bun run journeys                 all journeys, wide and narrow
 *   bun run journeys first-run       one journey
 *
 * Fake data only: this repository is public. It never reads the real library,
 * config, microphone or system audio, and keys that would open another app
 * (file picker, Finder, clipboard, System Settings) are left out on purpose.
 * Setup steps act on a pretend Mac, and the level meters hear a pretend room.
 */
import { mock } from 'bun:test';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { FeatureStatusDependencies } from '../src/feature-status.ts';
import type { MeetingArtifact } from '../src/meeting-artifact.ts';
import type { LevelSource, LevelSources } from '../src/Onboarding.tsx';
import type { SettingsActions } from '../src/SettingsScreen.tsx';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'journeys');
const WIDE = { columns: 100, rows: 30 };
const NARROW = { columns: 56, rows: 24 };

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const ESC = '\x1b';
const ENTER = '\r';

interface Frame { title: string; note?: string; keys?: string; ansi: string; text: string }
/** What the pretend room sounds like to each meter. */
type Sound = 'zeros' | 'room' | 'speech' | 'music';
interface Room { microphone: Sound; computer: Sound }
interface Context {
  library: string;
  meeting: (id: string) => MeetingArtifact;
  background: Background;
  room: Room;
  type: (keys: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}
type Background = typeof import('../src/background-watch-status.ts') & typeof import('../src/background-meeting-status.ts');
interface Step {
  title: string;
  note?: string;
  /** Keys as the person presses them, one entry per press. */
  press?: string[];
  /** More keys, only on a narrow window: there, Enter opens a Settings row before it acts. */
  narrowPress?: string[];
  /** Other keys altogether on a narrow window, where a row's detail is left with Esc. */
  narrowInstead?: string[];
  /** How the keys read to a person, when they are not printable. */
  keys?: string;
  /** Change the world before the frame: a meeting starts, a recording fails. */
  world?: (context: Context) => Promise<void> | void;
  /** Wait until this appears, so the frame is never captured mid-update. */
  until?: string;
  /** History starts open on a wide window and closed on a narrow one. */
  history?: boolean;
}
type Machine = 'fresh' | 'ready' | 'mic-silent' | 'mic-updated';
interface Journey {
  id: string;
  title: string;
  who: string;
  machine: Machine;
  library: 'empty' | 'demo';
  /** No background recorder, so this window captures by itself. A real install has one. */
  standalone?: boolean;
  /** Seashell has never been set up: there is no settings file yet. */
  firstRun?: boolean;
  /** Settings to start from, instead of the machine's. */
  config?: object;
  /** The AI engine is older than this Seashell: it cannot read your notes, write briefs or follow-ups. */
  oldEngine?: boolean;
  narrow?: boolean;
  steps: Step[];
}

export const JOURNEYS: Journey[] = [
  {
    id: 'first-run', title: 'First run', who: 'Someone who just installed Seashell and opens it for the first time.',
    machine: 'fresh', library: 'empty', narrow: true,
    steps: [
      { title: 'Opening screen', note: 'What do I do first?' },
      { title: 'Keyboard help', press: ['?'], until: 'Keys', note: 'Pressed ? to find out what is possible.' },
      { title: 'Settings', press: [ESC, ','], keys: 'Esc , ', until: 'Settings', note: 'Checklist of what works and what does not.' },
      { title: 'Moved down the list', press: [DOWN, DOWN], keys: '↓ ↓' },
      { title: 'Back to the app', press: [ESC], keys: 'Esc' },
      { title: 'Speakers setup', press: [',', ...Array(6).fill(DOWN), ENTER], narrowPress: [ENTER], keys: ', ↓ × 6 Enter',
        until: 'Speaker setup', note: 'Setting up who-said-what, from its row in Settings.' },
      { title: 'Back to Settings', press: [ESC], keys: 'Esc', until: 'Settings' },
      { title: 'AI setup', press: Array(8).fill(DOWN).concat(ENTER), narrowPress: [ENTER], keys: '↓ × 8 Enter', until: 'AI for notes',
        note: 'Choosing what writes the notes.' },
      { title: 'AI chosen', press: [ENTER], keys: 'Enter', until: 'Notes and chat use', note: 'Back in Settings, which says what changed.' },
    ],
  },
  {
    id: 'onboarding', title: 'Guided setup', who: 'Someone opening Seashell for the very first time, before anything is set up.',
    machine: 'fresh', library: 'empty', firstRun: true, narrow: true,
    steps: [
      { title: 'The guide opens by itself', until: 'Background recorder', note: 'A first run that cannot record yet starts here.' },
      { title: 'Recorder started', press: [ENTER], keys: 'Enter', until: 'Running' },
      { title: 'Microphone permission', press: [ENTER], keys: 'Enter', until: 'Seashell Microphone', note: 'macOS asks once.' },
      { title: 'Allowed, now listening', press: [ENTER], keys: 'Enter', until: 'Listening', note: 'A live level from the microphone recorder.' },
      { title: 'Silence', note: 'The microphone sends pure zeros, as a muted or wrong input does. Does it say what to check?',
        world: ({ sleep }) => sleep(6_000), until: 'may be muted' },
      { title: 'Spoke', note: 'Speech-level sound passes the step and lets go of the microphone.',
        world: ({ room }) => { room.microphone = 'speech'; }, until: 'Heard you' },
      { title: 'Computer audio', press: [ENTER], keys: 'Enter', until: 'Listening' },
      { title: 'Played a sound', world: ({ room }) => { room.computer = 'music'; }, until: 'Heard your Mac' },
      { title: 'Optional extras', press: [ENTER], keys: 'Enter', until: 'Optional extras' },
      { title: 'Finish chosen', press: [DOWN, DOWN, DOWN, DOWN], keys: '↓ ↓ ↓ ↓' },
      { title: 'Done', press: [ENTER], keys: 'Enter', until: "You're set" },
      { title: 'Back in the app', press: [ENTER], keys: 'Enter', until: 'Ready', note: 'What the guide heard counts: nothing left to fix.' },
    ],
  },
  {
    id: 'meeting', title: 'A meeting, start to finish', who: 'Someone with Seashell open during a call that the background recorder picks up.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'Waiting for a meeting', note: 'Nothing happening yet.' },
      { title: 'A call is noticed', note: 'A browser call without a calendar event: Seashell asks first.',
        world: ({ library, background }) => background.writeBackgroundWatchStatus(library, { phase: 'awaiting-consent',
          candidate: { id: 'call', title: 'Design review', appName: 'Chrome' }, consentId: 'demo-1' }), until: 'Record "Design review"' },
      { title: 'Recording', note: 'Words appear as people speak.',
        world: ({ library, background }) => liveMeeting(library, background), until: 'Recording' },
      { title: 'Reading back during the call', press: [UP, UP, UP], keys: '↑ ↑ ↑' },
      { title: 'Back to the latest words', press: ['l'], keys: 'L' },
      { title: 'The call ends', note: 'Audio is safe; the final transcript and notes are being made.',
        world: ({ library, background }) => endMeeting(library, background) },
    ],
  },
  {
    id: 'review', title: 'After the meeting', who: 'Someone reading the notes from a meeting that just ended.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'History', history: true, until: 'Acme', note: 'Finding the meeting.' },
      { title: 'Meeting opened', press: [ENTER], keys: 'Enter', until: '1 Notes', note: 'Which tab do I land on?' },
      { title: 'Notes', press: ['1'], keys: '1' },
      { title: 'Insights', press: ['\x1b[6~'], keys: 'Page Down', until: 'Insights', note: 'What the extractors found, under the notes.' },
      { title: 'Transcript', press: ['2'], keys: '2' },
      { title: 'Chat', press: ['3'], keys: '3' },
      { title: 'Asking a question', press: ['a'], keys: 'A', note: 'Typing a question about the meeting.' },
      { title: 'Question typed', press: [...'What did we promise Acme?'], keys: 'What did we promise Acme?' },
      { title: 'Cancelled', press: [ESC], keys: 'Esc' },
      { title: 'Notes setup', press: ['1', 'g'], keys: '1 G', until: 'Notes setup', note: 'Template, a note to the AI, and whether AI may see it. Enter rewrites.' },
      { title: 'Back', press: [ESC], keys: 'Esc', note: 'Nothing changed, so nothing to say.' },
      { title: 'Export', press: ['2', 'e'], keys: '2 E', note: 'Getting the transcript out.' },
    ],
  },
  {
    id: 'find', title: 'Find something from a past meeting', who: 'Someone trying to remember what was said last week.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'History', history: true, until: 'Acme' },
      { title: 'Search', press: ['/'], keys: '/', note: 'The search field is the key bar.' },
      { title: 'Typing', press: [...'pricing'], keys: 'pricing', note: 'Each meeting shows the line that matched, and when.' },
      { title: 'Results', press: [ENTER], keys: 'Enter' },
      { title: 'Opened a result', press: [ENTER], keys: 'Enter', until: '1 Notes', note: 'The matching line is at the top, highlighted.' },
      { title: 'Next match', press: ['n'], keys: 'N' },
      { title: 'Delete asked', press: ['d'], keys: 'D', note: 'Moving a meeting to the Trash.' },
      { title: 'Delete cancelled', press: ['n'], keys: 'N' },
    ],
  },
  {
    id: 'speakers', title: 'Put names on speakers', who: 'Someone who sees "Speaker 1" and wants a real name.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'History', history: true, until: 'Acme' },
      { title: 'Meeting transcript', press: [ENTER, '2'], keys: 'Enter 2', until: 'Speaker 1' },
      { title: 'Picking a speaker', press: ['r'], keys: 'R', until: 'Name a speaker', note: 'Who can be named? Priya was suggested from a voice named before.' },
      { title: 'Chose one', press: [ENTER], keys: 'Enter' },
      { title: 'Name typed', press: [...'Dana'], keys: 'Dana' },
      { title: 'Saved', press: [ENTER], keys: 'Enter' },
      { title: 'A suggested name', press: ['r'], keys: 'R', until: 'y keep', note: 'The list opens on the suggestion still to check.' },
      { title: 'Suggestion kept', press: ['y'], keys: 'Y', note: 'Keeping it also teaches Seashell the voice.' },
      { title: 'Hide speakers', press: [ESC, 's'], keys: 'Esc S', note: 'Toggle.' },
      { title: 'Show speakers again, hide times', press: ['s', 't'], keys: 'S T' },
      { title: 'Speaker settings', press: ['t', ',', ...Array(7).fill(DOWN), ENTER], narrowPress: [ENTER], keys: 'T , ↓ × 7 Enter',
        until: 'Speaker setup', note: 'From its row in Settings.' },
    ],
  },
  {
    id: 'ai-setup', title: 'Turn on AI notes', who: 'Someone who pressed for notes before choosing an AI.',
    machine: 'fresh', library: 'demo', narrow: true,
    steps: [
      { title: 'History', history: true, until: 'Weekly' },
      { title: 'Meeting without notes', press: [DOWN, ENTER], keys: '↓ Enter', until: '1 Notes' },
      { title: 'Asked for notes', press: ['g', ENTER], keys: 'G Enter', until: 'AI for notes', note: 'Notes setup, then Enter to write them. No AI chosen yet: what happens?' },
      { title: 'Next choice', press: [DOWN], keys: '↓' },
      { title: 'Picked one', press: [ENTER], keys: 'Enter' },
      { title: 'Next', press: [ENTER], keys: 'Enter' },
    ],
  },
  {
    id: 'trouble', title: 'Something is wrong', who: 'Someone whose microphone stopped being heard during a call.',
    machine: 'mic-silent', library: 'demo', narrow: true,
    steps: [
      { title: 'Warning at the top', until: 'silent', note: 'Does it say what is wrong and what to do?' },
      { title: 'Microphone fails during a call',
        world: ({ library, background }) => liveMeeting(library, background, { microphoneDown: true }), until: 'Mic not heard' },
      { title: 'Audio help', press: ['i'], keys: 'I', until: 'Sound', note: 'Access is allowed, so there is one thing to check, and Enter tests the mic.' },
      { title: 'Testing the mic', press: [ENTER], keys: 'Enter', until: 'Microphone test', note: 'The meter, on its own; the call keeps recording.' },
      { title: 'Back', press: [ESC], keys: 'Esc' },
      { title: 'Settings', press: [','], keys: ',', until: 'Settings' },
      { title: 'What to check', press: [ENTER], keys: 'Enter', note: 'Narrow, Enter opens the item; wide, it is already beside the list.' },
    ],
  },
  {
    id: 'manual', title: 'Record without a meeting', who: 'Someone who wants to dictate or record a conversation by hand.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'Idle', note: 'How do I just start recording?' },
      { title: 'Tried Space', press: [' '], keys: 'Space' },
      { title: 'Tried Enter', press: [ENTER], keys: 'Enter' },
      { title: 'With video', press: ['V'], keys: 'Shift-V', until: 'with video', note: 'Space stays audio only; V films the call, or the screen.' },
    ],
  },
  {
    id: 'settings', title: 'Settings and help', who: 'Someone checking that everything is healthy.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'Settings', press: [','], keys: ',', until: 'Recording', note: 'Opens on which calls get recorded.' },
      { title: 'Changing recording', press: [ENTER], keys: 'Enter', until: 'Calls' },
      { title: 'FaceTime off', press: [DOWN, DOWN, DOWN, DOWN, DOWN, LEFT], keys: '↓ ↓ ↓ ↓ ↓ ←', until: 'never recorded',
        note: '"Can I default FaceTime off but the rest on?"' },
      { title: 'Calls ask first', press: [UP, UP, UP, UP, UP, RIGHT], keys: '↑ ↑ ↑ ↑ ↑ →' },
      { title: 'Done changing', press: [ESC], keys: 'Esc' },
      { title: 'Down the list', press: [DOWN, DOWN, DOWN, DOWN], keys: '↓ ↓ ↓ ↓' },
      { title: 'Further down', press: [DOWN, DOWN, DOWN, DOWN, DOWN], keys: '↓ ↓ ↓ ↓ ↓' },
      { title: 'The end of the list', press: Array(10).fill(DOWN), keys: '↓ × 10', note: 'Narrow, the list scrolls to its last row.' },
      { title: 'Guided setup again', press: [ENTER], keys: 'Enter', until: 'Step 1',
        note: 'Re-run any time to hear the microphone again.' },
      { title: 'Back to Settings', press: [ESC], keys: 'Esc', until: 'Recording' },
      { title: 'Help', press: [ESC, '?'], keys: 'Esc ?', until: 'Keys' },
    ],
  },
  {
    id: 'settings-files', title: 'Prompts, extractors, automations, voices and video', who: 'Someone shaping what the AI writes and what happens after a call.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'Saved voices', press: [',', ...Array(20).fill(UP), ...Array(8).fill(DOWN)], keys: ', ↑ × 20 ↓ × 8', until: 'Saved voices',
        note: 'Who Seashell knows by voice.' },
      { title: 'Choosing someone', press: [ENTER], keys: 'Enter', until: 'forget' },
      { title: 'Forget asked', press: [ENTER], keys: 'Enter', until: 'y forget', note: 'Asked first, in the key bar.' },
      { title: 'Forgotten', press: ['y'], keys: 'Y', until: 'Forgot' },
      { title: 'Prompts', press: [LEFT, DOWN, DOWN, DOWN], keys: '← ↓ ↓ ↓', note: 'What each AI role is told: as shipped, edited or empty.' },
      { title: 'Choosing a prompt', press: [ENTER, DOWN], keys: 'Enter ↓', until: 'put back' },
      { title: 'Undo asked', press: ['d'], keys: 'D', until: 'y undo' },
      { title: 'Edits undone', press: ['y'], keys: 'Y', until: 'Undid' },
      { title: 'Vocabulary', press: [LEFT, DOWN], narrowPress: [ENTER], keys: '← ↓', until: 'spell right',
        note: 'Names and words to spell right, kept in the app; Enter opens them as a file.' },
      { title: 'Adding a word', press: ['a', ...'Humain'], keys: 'A Humain', until: 'Add a word', note: 'Typed in the key bar.' },
      { title: 'Word added', press: [ENTER], keys: 'Enter', until: 'Added', note: 'The list shows it; the next call spells it that way.' },
      { title: 'Choosing a word', press: [ENTER], narrowInstead: [DOWN], keys: 'Enter', until: 'd remove', note: 'd removes it again.' },
      { title: 'Extractors', press: [LEFT, DOWN, ENTER], keys: '← ↓ Enter', until: 'Customer pains', note: 'A file that does not load is red. Wide, Enter opens the folder.' },
      { title: 'Automations', press: [LEFT, DOWN, ENTER], keys: '← ↓ Enter', until: 'Last runs', note: 'And how their last runs went.' },
      { title: 'Briefs', press: [LEFT, DOWN], narrowPress: [ENTER], keys: '← ↓', until: '15 minutes',
        note: 'On by default, waiting for calendar titles: Enter turns those on here, and ←→ switch briefs.' },
      { title: 'Calendar titles on, from Briefs', press: [ENTER], keys: 'Enter', until: 'Calendar titles on',
        note: 'The same setup as the Calendar titles row.' },
      { title: 'Video', press: [DOWN, DOWN], narrowInstead: [ESC, DOWN, DOWN], keys: '↓ ↓', note: 'On, but macOS has not allowed Screen Recording yet.' },
      { title: 'Video off', press: [ENTER], keys: 'Enter', note: 'Enter switches video. Wide, it turns off; narrow, it opens the item first.' },
      { title: 'Video on, Screen Recording allowed', press: [ENTER], keys: 'Enter', note: 'Turning it on asks macOS for Screen Recording.' },
      { title: 'Computer audio', press: [LEFT, ...Array(13).fill(UP)], keys: '← ↑ × 13',
        note: 'Meetings keep the background recorder\'s permission until a check at the Mac allows Seashell System Audio.' },
      { title: 'Computer audio checked', press: [ENTER], keys: 'Enter', note: 'Wide, Enter plays a short sound and listens; narrow, it opens the item first.' },
    ],
  },
  {
    id: 'ai-test', title: 'Test the AI connection', who: 'Someone whose notes stopped arriving and wants to know why.',
    machine: 'ready', library: 'demo', narrow: true,
    config: { meeting: { speakerBrowser: 'auto', mode: 'hybrid', routes: {
      observer: { backend: 'claude-code', model: 'haiku' }, reconciliation: { backend: 'claude-code', model: 'sonnet' },
      chat: { backend: 'codex', model: 'gpt-5.5' } } } },
    steps: [
      { title: 'AI screen', press: [',', ...Array(9).fill(DOWN), ENTER], narrowPress: [ENTER], keys: ', ↓ × 9 Enter', until: 'Test connection' },
      { title: 'Testing', press: [ENTER], keys: 'Enter', until: 'Testing', note: 'One short fixed prompt each; no meeting text.' },
      { title: 'Results', until: 'answered in', note: 'Which AI answered, how fast, and what to do about the one that did not.' },
    ],
  },
  {
    id: 'video', title: 'Watch a meeting back', who: 'Someone who wants to see the slide that was on screen when something was said.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'History', history: true, until: 'Roadmap' },
      { title: 'A meeting with video', press: [DOWN, DOWN, DOWN, ENTER], keys: '↓ ↓ ↓ Enter', until: 'watch video', note: 'w appears only when there is video.' },
      { title: 'Reading the transcript', press: ['2', ...Array(8).fill(DOWN)], keys: '2 ↓ × 8' },
      { title: 'Video opened', press: ['w'], keys: 'W', until: 'Opened the video', note: 'It plays from the line at the top.' },
    ],
  },
  {
    id: 'during-call', title: 'Notes and questions during a call', who: 'Someone on a call who wants to jot something down, or catch up after looking away.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'Recording', world: ({ library, background }) => liveMeeting(library, background, { bundle: true }), until: 'catch up',
        note: 'A note and a catch-up are one key each.' },
      { title: 'Typing a note', press: ['+', ...'Dana sounded unsure about November'], keys: '+ Dana sounded unsure about November',
        note: 'The note is timed when + is pressed, not when Enter is.' },
      { title: 'Noted', press: [ENTER], keys: 'Enter', until: 'Noted at' },
      { title: 'Your notes so far', press: ['1'], keys: '1', until: 'Your notes', note: 'In Notes, with the time it was written.' },
      { title: 'Asking', press: ['2', 'a'], keys: '2 A', until: 'what did I miss', note: 'Enter alone asks what you missed.' },
      { title: 'Reading the call', press: [ENTER], keys: 'Enter', until: 'Reading the call', note: 'Recording carries on; Esc stops waiting.' },
      { title: 'Catch up', until: 'From the call', note: 'The answer, then the moments it rests on, under the same names.' },
      { title: 'Saved as a note', press: ['+'], keys: '+', until: 'Noted at', note: 'The answer joins your notes, timed now.' },
      { title: 'Back to the call', press: [ESC], keys: 'Esc' },
      { title: 'A private meeting', press: ['a'], keys: 'A', until: 'AI is off',
        world: async ({ library }) => {
          const { loadMeetingArtifact, saveMeetingArtifact } = await import('../src/meeting-artifact.ts');
          saveMeetingArtifact(library, { ...loadMeetingArtifact(library, 'demo-live')!, ai: { off: true } });
        }, note: 'AI is off for it: nothing is sent, and it says so in a line, and in the title.' },
      { title: 'Nothing to ask', press: ['l'], keys: 'L', note: 'With AI off, catch up is not offered, as follow-up is not.' },
    ],
  },
  {
    id: 'after-call', title: 'Your notes, and a follow-up', who: 'Someone who wrote notes during a call and now owes the other side an email.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'History', history: true, until: 'Acme' },
      { title: 'Notes from your notes', press: [ENTER], keys: 'Enter', until: '1 Notes', note: '✎ marks a point that came from your own notes.' },
      { title: 'What ✎ means', press: ['?'], keys: '?', until: 'your own notes' },
      { title: 'A note after the call', press: [ESC, '+', ...'Send Priya the admin guide'], keys: 'Esc + Send Priya the admin guide' },
      { title: 'Noted', press: [ENTER], keys: 'Enter', until: 'Noted', note: 'The notes use it when they are written again.' },
      { title: 'A follow-up', press: ['u'], keys: 'U', until: 'Slack', note: 'Email or Slack.' },
      { title: 'Anything to add', press: ['e', ...'keep it short'], keys: 'E keep it short' },
      { title: 'Writing it', press: [ENTER], keys: 'Enter', until: 'Writing the email' },
      { title: 'The email', until: 'Subject', note: 'Copy it, or open it in Mail as a draft. Nothing is sent.' },
      { title: 'Where it came from', press: ['t'], keys: 'T', until: 'hide times', note: 'Times are there when you want them.' },
      { title: 'Write it again', press: ['g'], keys: 'G', until: 'Anything to add', note: 'What you typed last time comes back, to change.' },
      { title: 'It failed', press: [ENTER], keys: 'Enter', until: 'try again', world: () => { process.env.JOURNEY_MODEL_DOWN = '1'; },
        note: 'The AI did not answer this time. Enter tries again.' },
      { title: 'Notes the engine could not read', press: [ESC, 'h', DOWN, DOWN, DOWN, DOWN, ENTER], keys: 'Esc H ↓ ↓ ↓ ↓ Enter', until: 'Board',
        note: 'An older AI engine wrote these notes, so yours are listed as written, with one yellow line and the key that helps.' },
    ],
  },
  {
    id: 'old-engine', title: 'An AI engine older than Seashell', who: 'Someone whose notes left out what they typed.',
    machine: 'ready', library: 'demo', narrow: true, oldEngine: true,
    steps: [
      { title: 'History', history: true, until: 'Board' },
      { title: 'Notes without yours', press: [...Array(6).fill(UP), DOWN, DOWN, DOWN, DOWN, ENTER], keys: '↑ × 6 ↓ × 4 Enter', until: 'Board',
        note: 'One yellow line under your notes; the key bar leads with AI settings.' },
      { title: 'AI settings', press: [','], narrowPress: [ENTER], keys: ',', until: 'too old', note: 'Settings opens on AI notes, which says what to do in plain words.' },
      { title: 'A point whose line was removed', press: [ESC, ...Array(7).fill(DOWN)], narrowInstead: [ESC, ESC, ...Array(9).fill(DOWN)], keys: 'Esc ↓ × 7',
        until: 'line removed',
        note: 'Its words stay as written; the time column says its line is gone.' },
    ],
  },
  {
    id: 'brief', title: 'A brief before the next meeting', who: 'Someone with a meeting in 40 minutes who met these people before.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'The next meeting', world: ({ library }) => nextMeeting(library), until: 'Next:', note: 'The title line says what is next; b lists what is coming up.' },
      { title: 'Coming up', press: ['b'], keys: 'B', until: 'Coming up', note: 'The next 36 hours, tomorrow morning included, and where each brief stands.' },
      { title: 'Writing the brief', press: [ENTER], keys: 'Enter', until: '◐', note: 'From the past meetings with the same title or people. Esc stops it.' },
      { title: 'The brief', until: 'Still open', note: 'Each point says which meeting and when, dim on the right.' },
      { title: 'Back to the list', press: [ESC], keys: 'Esc', until: 'brief ready', note: 'It says the brief is ready.' },
      { title: 'Ready next time', press: [ENTER], keys: 'Enter', until: 'Still open', note: 'Saved in the Briefs folder: the second time it opens at once.' },
      { title: 'Choosing a point', press: [DOWN], keys: '↓', note: 'Who owns it sits on the right, as in the notes.' },
      { title: 'Where it was said', press: [ENTER], keys: 'Enter', until: '2 Transcript', note: 'The past meeting, at the line the point cites.' },
      { title: 'No history', press: ['b', DOWN, DOWN, ENTER], keys: 'B ↓ ↓ Enter', until: 'Nothing to brief from',
        note: 'A meeting with nobody met before has nothing to read, and says so.' },
    ],
  },
  {
    id: 'your-side', title: 'Your side was not heard', who: 'Someone reading a call where their microphone picked up almost nothing.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'History', history: true, until: 'Hiring' },
      { title: 'The meeting says so', press: [DOWN, DOWN, ENTER], keys: '↓ ↓ Enter', until: "Your side wasn't recorded", note: 'A yellow line, in the meeting only.' },
    ],
  },
  {
    id: 'mic-update', title: 'The microphone after an update', who: 'Someone who allowed the microphone once, then updated Seashell.',
    machine: 'mic-updated', library: 'demo', narrow: true,
    steps: [
      { title: 'After the update', until: 'needs your OK', note: 'The title says so, and the key that helps leads the key bar.' },
      { title: 'Microphone in Settings', press: [','], narrowPress: [ENTER], keys: ',', until: 'Needs your OK again',
        note: 'It was allowed before: this is the new copy asking, not a microphone never allowed.' },
      { title: 'Allowed again', press: [ENTER], keys: 'Enter', until: 'Microphone allowed', note: 'macOS asks once more; the recorder picks it up by itself.' },
    ],
  },
];

const LINES: [string, string][] = [
  ['LOCAL', 'Thanks for making time. I wanted to go through where you landed on the pilot.'],
  ['REMOTE_00', 'Sure. We looked at the pricing again and the per-seat number works for us.'],
  ['REMOTE_00', 'The open question is whether legal needs the data to stay in Canada.'],
  ['LOCAL', 'Everything runs on your own machines, so nothing leaves the building.'],
  ['REMOTE_01', 'That helps a lot. Can you send that in writing for our security review?'],
  ['LOCAL', 'Yes, I will send the security summary by Friday.'],
  ['REMOTE_00', 'Great. If that clears we can start the pilot with twelve people in November.'],
  ['REMOTE_01', 'I would want the admin controls turned on from day one.'],
  ['LOCAL', 'Agreed. Admin controls are on by default for the pilot.'],
  ['REMOTE_00', 'One more thing, who owns onboarding on your side?'],
  ['LOCAL', 'That would be me for the first two weeks, then our support team.'],
  ['REMOTE_01', 'Perfect. Let us plan a kickoff the week of the tenth.'],
];

const demoTranscript = (repeats = 3) => Array.from({ length: repeats * LINES.length }, (_, index) => {
  const [speaker, text] = LINES[index % LINES.length]!;
  return { id: `s${String(index).padStart(6, '0')}`, start: index * 7, end: index * 7 + 6, speaker, text };
});
const SPEAKERS = [
  { id: 'LOCAL', label: 'Microphone' },
  { id: 'REMOTE_00', label: 'Remote speaker 1' },
  { id: 'REMOTE_01', label: 'Remote speaker 2' },
];

async function seed(library: string): Promise<void> {
  const { createTranscriptRecord } = await import('../src/transcript-record.ts');
  const { saveTranscriptRecord } = await import('../src/transcript-library.ts');
  const { createMeetingArtifact, saveMeetingArtifact } = await import('../src/meeting-artifact.ts');
  const add = (id: string, title: string, when: number | Date, notes: boolean) => {
    // Priya was named in an earlier call, so Seashell suggests her name for this voice.
    const speakers = id === 'demo-acme' ? SPEAKERS.map((speaker) => speaker.id === 'REMOTE_01'
      ? { ...speaker, label: 'Priya', suggestion: { source: 'voice' as const, previous: speaker.label, similarity: 0.83 } } : speaker) : SPEAKERS;
    // Board prep lost a line heard in silence, which one of its points rested on.
    const record = createTranscriptRecord({ transcript: demoTranscript().filter((segment) => id !== 'demo-board' || segment.id !== 's000003'), speakers },
      { id, title, now: typeof when === 'number' ? new Date(Date.now() - when * 3_600_000) : when });
    const { directory } = saveTranscriptRecord(library, record);
    if (id === 'demo-roadmap') {
      // A pretend movie: the player page is written, never opened.
      const movie = join(directory, 'capture', 'video', 'segment-1.mov');
      mkdirSync(dirname(movie), { recursive: true });
      writeFileSync(movie, '');
      writeFileSync(join(directory, 'video.json'), JSON.stringify({ file: movie, startOffsetSeconds: 0, segments: [{ file: movie, startOffsetSeconds: 0 }] }));
    }
    if (id === 'demo-hiring') {
      // They talked for 40 minutes; the microphone heard 20 seconds.
      const now = Date.now();
      const source = { state: 'stopped', updatedAtUnixMs: now, warnings: [] };
      mkdirSync(join(directory, 'capture'), { recursive: true });
      writeFileSync(join(directory, 'capture', 'capture-health.json'), JSON.stringify({ schemaVersion: 1, updatedAtUnixMs: now,
        microphone: source, systemAudio: source,
        coverage: { yourSideAudibleSeconds: 20, otherSideAudibleSeconds: 2400, yourSideAudibleShare: 0.008, yourSideMissing: true } }));
    }
    // The Acme call came from a calendar invite: a follow-up is addressed to everyone on it but you.
    const artifact = createMeetingArtifact(record, id === 'demo-acme' ? { calendar: { provider: 'macos-eventkit', eventId: 'demo-acme-call', title,
      startAt: record.createdAt, endAt: record.createdAt, calendar: 'you@example.com', attendees: [{ name: 'You', email: 'you@example.com' },
        { name: 'Dana Whitfield', email: 'dana@acme.example' }, { name: 'Priya', email: 'priya@acme.example' }] } } : {});
    const typed = (noteId: string, text: string, at: number) => ({ id: noteId, text, at, addedAt: record.createdAt });
    if (id === 'demo-acme') artifact.ownerNotes = [typed('n1', 'Ask about the Canada question before the kickoff', 20), typed('n2', 'Priya cares most about admin controls', 52)];
    // Written by an engine too old for them, so they are listed as written.
    if (id === 'demo-board') artifact.ownerNotes = [typed('n3', 'They want the hiring plan before the next board meeting', 30)];
    if (notes) {
      artifact.status = 'ready';
      artifact.analysis = {
        final: true, runId: 'demo', createdAt: record.createdAt, template: 'Customer call',
        summary: 'Acme is ready to pilot with twelve people in November if the security review clears. Data stays on their own machines.',
        claims: [
          { id: 'c1', type: 'decision', text: 'Start the pilot with twelve people in November.', evidenceSegmentIds: ['s000006'], confidence: 0.9 },
          { id: 'c2', type: 'action_item', text: 'Send the security summary.', person: 'You', due: 'Fri', evidenceSegmentIds: ['s000005'], confidence: 0.9 },
          { id: 'c3', type: 'action_item', text: 'Plan a kickoff the week of the tenth.', evidenceSegmentIds: ['s000011'], confidence: 0.8 },
          { id: 'c4', type: 'risk', text: 'The pilot waits on their security review.', evidenceSegmentIds: ['s000004', 's000006'], confidence: 0.8 },
          { id: 'c5', type: 'open_question', text: 'Does their legal team need the data kept in Canada?', evidenceSegmentIds: ['s000002'], confidence: 0.8 },
          { id: 'c6', type: 'follow_up', text: 'Hand onboarding to the support team after two weeks.', person: 'You', evidenceSegmentIds: ['s000010'], confidence: 0.8 },
          { id: 'c7', type: 'note', text: 'Admin controls are on by default for the pilot.', evidenceSegmentIds: ['s000008'], confidence: 0.7,
            ...(id === 'demo-acme' ? { ownerNoteIds: ['n2'] } : {}) },
          // Only your notes say it: there is no line in the transcript to cite.
          ...(id === 'demo-acme' ? [{ id: 'c8', type: 'follow_up', text: 'Check whether their legal team needs the data in Canada before the kickoff.',
            person: 'You', evidenceSegmentIds: [], ownerNoteIds: ['n1'], confidence: 0.7 }] : []),
          // The line it rested on was heard in silence and removed from the transcript; the point stays, and says so.
          ...(id === 'demo-board' ? [{ id: 'c9', type: 'decision', text: 'Share the board deck once the hiring plan is final.',
            evidenceSegmentIds: [], removedEvidenceSegmentIds: ['s000003'], confidence: 0.7 }] : []),
        ] as never,
        notes: [
          { heading: 'Where they stand', items: [{ text: 'Per-seat pricing works for them.', evidenceSegmentIds: ['s000001'] }] },
          { heading: 'Next steps', items: [
            { text: 'Send the security summary.', evidenceSegmentIds: ['s000005'] },
            { text: 'Kickoff the week of the tenth.', evidenceSegmentIds: ['s000011'] },
          ] },
        ] as never,
        ...(id === 'demo-board' ? { ownerNotesUnread: true as const } : {}),
      };
      // Two of these repeat the notes and are left out; the rest are new.
      if (id === 'demo-acme') artifact.insights = [{ extractor: 'Customer pains', createdAt: record.createdAt, runId: 'demo-insight', fields: [
        { name: 'Pains', items: [
          { text: 'Their legal team may need the data kept in Canada.', evidenceSegmentIds: ['s000002'] },
          { text: 'Their security review needs it in writing.', evidenceSegmentIds: ['s000004'] },
        ] },
        { name: 'Budget', items: [{ text: 'Per-seat pricing works for them.', evidenceSegmentIds: ['s000001'] }] },
        { name: 'Asks', items: [{ text: 'Admin controls from day one.', evidenceSegmentIds: ['s000007'] }] },
      ] }];
      artifact.chat = [
        { id: 'q1', role: 'user', text: 'When does the pilot start?', createdAt: record.createdAt } as never,
        { id: 'a1', role: 'assistant', text: 'November, with twelve people, if the security review clears.', createdAt: record.createdAt, evidenceSegmentIds: ['s000006'] } as never,
      ];
    }
    saveMeetingArtifact(library, artifact);
  };
  add('demo-weekly', 'Weekly product sync', 27, false);
  add('demo-acme', 'Acme discovery call', 3, true);
  // Two on one day, so the list shows their times and its date column can be checked.
  const daysAgo = (days: number, hour: number, minute: number) => {
    const at = new Date(Date.now() - days * 86_400_000);
    at.setHours(hour, minute, 0, 0);
    return at;
  };
  add('demo-hiring', 'Hiring loop debrief', daysAgo(3, 14, 30), true);
  add('demo-roadmap', 'Roadmap review', daysAgo(3, 9, 5), true);
  add('demo-board', 'Board prep', 120, true);
}

/** The folders beside the library: an edited prompt, two extractors (one broken), an automation and its runs, two voices. */
async function seedFiles(root: string, library: string): Promise<void> {
  const { ensurePromptsDirectory, writePrompt } = await import('../src/prompts.ts');
  ensurePromptsDirectory(library);
  writePrompt(library, 'notes', 'Lead with what the customer asked for.\nKeep each bullet under fifteen words.\n');
  const extractors = join(root, 'Extractors');
  mkdirSync(extractors, { recursive: true });
  writeFileSync(join(extractors, 'customer-pains.md'), '---\nname: Customer pains\nwhen: always\nfields:\n  Pains: What is hard for them\n  Budget: Any price they mentioned\n---\n');
  writeFileSync(join(extractors, 'risks.md'), '---\nname: Risks\nwhen:\n  title: [review, board]\n---\n');
  const automations = join(root, 'Automations');
  mkdirSync(automations, { recursive: true });
  writeFileSync(join(automations, 'save-notes.md'), '---\nname: Save notes\nwhen: meeting ready\n---\n- write: ~/Documents/Meeting notes\n');
  writeFileSync(join(automations, 'crm.md'), '---\nname: Post to the CRM\nwhen: meeting ready\ntitle: [discovery]\n---\n- webhook: https://crm.example.com/hooks/meetings\n');
  const at = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  writeFileSync(join(library, 'automation-runs.jsonl'), [
    { at: at(27), automation: 'Save notes', hash: 'a', meetingId: 'demo-weekly', trigger: 'meeting-ready', status: 'ok',
      actions: [{ kind: 'write', target: '~/Documents/Meeting notes', status: 'ok' }] },
    { at: at(3), automation: 'Save notes', hash: 'a', meetingId: 'demo-acme', trigger: 'meeting-ready', status: 'ok',
      actions: [{ kind: 'write', target: '~/Documents/Meeting notes', status: 'ok' }] },
    { at: at(3), automation: 'Post to the CRM', hash: 'b', meetingId: 'demo-acme', trigger: 'meeting-ready', status: 'failed',
      actions: [{ kind: 'webhook', target: 'https://crm.example.com/hooks/meetings', status: 'failed', detail: 'the server failed (502)' }] },
  ].map((run) => JSON.stringify(run)).join('\n') + '\n');
  for (const [name, meetings] of [['Dana Whitfield', 4], ['Priya', 1]] as const) {
    const key = createHash('sha256').update(name.toLocaleLowerCase('en-US')).digest('hex').slice(0, 24);
    const people = join(root, 'Voices', 'people');
    mkdirSync(people, { recursive: true });
    writeFileSync(join(people, `${key}.json`), JSON.stringify({ version: 1, name, samples: Array.from({ length: meetings }, (_, index) => ({
      transcriptId: `demo-${index}`, speakerId: 'REMOTE_00', embedding: [0.1, 0.2, 0.3], seconds: 40, savedAt: at(24 * (index + 1)) })) }));
  }
}

/** Made-up answers, citing the made-up meeting they were asked about. */
function cannedAnswer(action: string, request: Record<string, any>): unknown {
  const ids = (request.segments ?? []).map((segment: { id: string }) => segment.id);
  const cite = (...wanted: string[]) => wanted.filter((id) => ids.includes(id));
  // Named as the request names them, which is as the transcript shows them.
  const asker = (request.segments ?? []).find((segment: { id: string }) => segment.id === 's000004')?.speakerLabel ?? 'They';
  if (action === 'chat' && request.partial) return {
    answer: `${asker} asked for the security summary in writing, and you said you would send it by Friday. If it clears, they start the pilot with twelve people in November.`,
    evidenceSegmentIds: cite('s000004', 's000005', 's000006'),
  };
  if (action === 'draft') return {
    ...(request.draft?.kind === 'email' ? { subject: 'Pilot next steps and the security summary' } : {}),
    paragraphs: [
      { kind: 'greeting', text: 'Hi Dana and Priya,', evidenceSegmentIds: [] },
      { kind: 'body', text: 'Thanks for the time today. The per-seat price works for you, and the data stays on your own machines.', evidenceSegmentIds: cite('s000001', 's000003') },
      { kind: 'body', text: 'I will send the security summary by Friday. If it clears your review, we start the pilot with twelve people in November, with admin controls on from day one.', evidenceSegmentIds: cite('s000005', 's000006', 's000008') },
      // The note typed after the call reaches the draft as "My notes:".
      ...(String(request.draft?.ask ?? '').includes('admin guide')
        ? [{ kind: 'body', text: 'I will also send Priya the admin guide.', evidenceSegmentIds: cite('s000007') }] : []),
      { kind: 'closing', text: 'Talk soon,', evidenceSegmentIds: [] },
    ],
  };
  if (action === 'brief') {
    const meeting = request.meetings?.[0];
    const sent = (meeting?.segments ?? []).map((segment: { id: string }) => segment.id);
    const source = (...wanted: string[]) => [{ meetingId: meeting.meetingId, evidenceSegmentIds: wanted.filter((id) => sent.includes(id)) }];
    return {
      summary: 'Last time they were ready to pilot in November if the security review cleared. You owe them the security summary, and their Canada question is still open.',
      sections: [
        { heading: 'Still open', items: [
          { text: 'Does their legal team need the data kept in Canada?', sources: source('s000002') },
          { text: 'You promised the security summary by Friday.', sources: source('s000005') },
        ] },
        { heading: 'Bring up', items: [
          { text: 'Confirm the kickoff the week of the tenth.', sources: source('s000011') },
          { text: 'Who owns onboarding after the first two weeks.', sources: source('s000010') },
        ] },
      ],
    };
  }
  return undefined;
}

/** What the recorder says is coming up on the calendar: the next meeting, with past meetings to brief from, then tomorrow's. */
async function nextMeeting(library: string) {
  const { writeNextMeeting } = await import('../src/briefs.ts');
  const startsAt = new Date(Date.now() + 40 * 60_000);
  startsAt.setSeconds(0, 0);
  const tomorrow = (hour: number, minute: number) => {
    const at = new Date(Date.now() + 86_400_000);
    at.setHours(hour, minute, 0, 0);
    return at.toISOString();
  };
  writeNextMeeting(library, { upcoming: { title: 'Roadmap review', startsAt: startsAt.toISOString(), eventId: 'demo-roadmap-series',
    attendees: [{ name: 'Dana Whitfield', email: 'dana@example.com' }] }, history: 1, later: [
    { upcoming: { title: 'Acme check-in', startsAt: tomorrow(10, 0), eventId: 'demo-acme-check-in',
      attendees: [{ name: 'Priya', email: 'priya@acme.example' }] }, history: 1 },
    { upcoming: { title: 'Lunch with Sam', startsAt: tomorrow(12, 30), eventId: 'demo-lunch', attendees: [{ name: 'Sam', email: 'sam@example.com' }] }, history: 0 },
  ] });
}

async function liveMeeting(library: string, background: Background, options: { microphoneDown?: boolean; bundle?: boolean } = {}) {
  const { createTranscriptRecord } = await import('../src/transcript-record.ts');
  const { saveTranscriptRecord } = await import('../src/transcript-library.ts');
  const { createMeetingArtifact, saveMeetingArtifact } = await import('../src/meeting-artifact.ts');
  const { CaptureHealthTracker } = await import('../src/capture-health.ts');
  const record = createTranscriptRecord({ transcript: demoTranscript(1).slice(0, 7), speakers: SPEAKERS },
    { id: 'demo-live', title: 'Design review', now: new Date(Date.now() - 120_000) });
  const saved = saveTranscriptRecord(library, record);
  saveMeetingArtifact(library, createMeetingArtifact(record));
  // The audio so far, where a note typed during the call is kept.
  if (options.bundle) {
    const { CaptureSessionStore } = await import('../src/capture-session.ts');
    new CaptureSessionStore({ libraryDir: library, sessionId: record.id, startedAtUnixMs: Date.parse(record.createdAt), createdAt: record.createdAt });
  }
  const health = new CaptureHealthTracker();
  if (options.microphoneDown) health.state('microphone', { state: 'unavailable', code: 'microphone_stopped', message: 'The microphone stopped.' });
  else health.pcm('microphone', { peak: 1000, rms: 500, rmsDbfs: -30 });
  health.pcm('systemAudio', { peak: 1000, rms: 500, rmsDbfs: -30 });
  background.writeBackgroundMeetingState(saved.directory, 'recording', { captureHealth: health.snapshot, audioSavedThroughMs: 110_000,
    draftStatus: { stage: 'waiting', detail: 'Waiting for speech', queueDepth: 0 } });
  background.writeBackgroundWatchStatus(library, { phase: 'recording', sessionId: record.id });
}

async function endMeeting(library: string, background: Background) {
  const { findTranscriptRecord } = await import('../src/transcript-library.ts');
  const { path } = findTranscriptRecord(library, 'demo-live');
  background.writeBackgroundMeetingState(dirname(path), 'processing');
  background.writeBackgroundWatchStatus(library, { phase: 'watching' });
}

/** The pretend Mac: what is set up, which the setup actions change. */
interface Mac { recorder: boolean; microphone: boolean; meet: boolean; calendar: boolean; screen: boolean; fresh: boolean; micSilent: boolean;
  /** An earlier copy of Seashell Microphone was allowed, before an update. */
  micAllowedBefore: boolean }

function dependencies(mac: Mac, oldEngine = false): FeatureStatusDependencies {
  return {
    // What the pretend engine can do, read from its usage line as the real check does: no prompt.
    engine: async () => new Set(['observe', 'reconcile', 'chat', 'extract', ...(oldEngine ? [] : ['brief', 'draft'])]),
    launchAtLogin: () => ({ enabled: mac.recorder, loaded: mac.recorder, label: 'demo', plistPath: '/demo', command: [] }),
    watchStatus: () => (mac.recorder ? { schemaVersion: 1, phase: 'watching', pid: 1, updatedAtUnixMs: Date.now() } : undefined) as never,
    meetConnection: async () => (mac.meet
      ? { state: 'idle', detail: 'Join a call', accessibilityTrusted: true }
      : { state: 'off', detail: 'Not connected', accessibilityTrusted: false }) as never,
    microphone: async () => (mac.microphone ? { authorization: 'authorized', detail: 'Allowed.' } : { authorization: 'notDetermined', detail: 'Not asked.' }) as never,
    microphoneAllowedBefore: () => mac.micAllowedBefore,
    calendar: async () => ({ authorization: mac.calendar ? 'authorized' : 'notDetermined', detail: 'Calendar.', calendars: 2 }) as never,
    lastMeeting: () => (mac.fresh ? undefined : { title: 'Acme discovery call', createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), microphoneChunks: 3,
      audibleMicrophoneChunks: mac.micSilent ? 0 : 3, computerChunks: 3, audibleComputerChunks: 3, meetingKey: 'meet:chrome:/abc-defg-hij' }) as never,
    speakerSeparationReady: () => !mac.fresh, aiEngineInstalled: () => !mac.fresh,
    transcriptionReady: () => true, systemAudioHelperReady: () => true,
    microphoneRecorderSince: () => Date.now() - 86_400_000,
    systemAudioRecorderSince: () => Date.now() - 86_400_000,
    screenRecording: async () => (mac.screen ? { authorization: 'authorized', detail: 'Allowed.' }
      : { authorization: 'notDetermined', detail: 'macOS has not asked yet.' }) as never,
  };
}

/** Setup that changes the pretend Mac instead of launchd, macOS permissions or System Settings. */
function setupActions(mac: Mac): SettingsActions {
  return {
    enableRecorder: () => { mac.recorder = true; },
    allowMicrophone: async () => { mac.microphone = true; return { authorization: 'authorized', detail: 'Allowed.' }; },
    connectMeet: async () => { mac.meet = true; return { detail: 'Google Meet connected.' }; },
    allowCalendar: async () => { mac.calendar = true; return { authorization: 'authorized', detail: 'Allowed.' }; },
    allowScreenRecording: async () => { mac.screen = true; return { authorization: 'authorized', detail: 'Allowed.' }; },
    // A pass is remembered beside the pretend settings, as the real check does.
    checkComputerAudio: async () => {
      (await import('../src/audio-checks.ts')).rememberAudioCheck('computer');
      return { heard: true, refused: false, detail: 'Heard your Mac. Meetings use it from the next call.' };
    },
    openTemplates: () => {}, openFolder: () => {}, openFile: () => {},
    // Trying an automation again never posts anywhere.
    retryAutomation: async () => [],
  };
}

const LEVELS: Record<Sound, { peak: number; rmsDbfs: number }> = {
  zeros: { peak: 0, rmsDbfs: Number.NEGATIVE_INFINITY },
  room: { peak: 40, rmsDbfs: -62 },
  speech: { peak: 9_000, rmsDbfs: -24 },
  music: { peak: 12_000, rmsDbfs: -20 },
};

/** A meter that hears whatever the room is set to, ten times a second, with a little movement. */
function pretendLevels(room: Room): LevelSources {
  const source = (which: keyof Room): LevelSource => ({ onLevel }) => {
    let tick = 0;
    const timer = setInterval(() => {
      const level = LEVELS[room[which]];
      const sway = level.peak ? Math.sin(tick++ / 2) * 6 : 0;
      onLevel({ peak: level.peak, rms: 0, rmsDbfs: level.rmsDbfs + sway });
    }, 100);
    return () => clearInterval(timer);
  };
  return { microphone: source('microphone'), computer: source('computer') };
}

/** One journey in this process: Bun's module mocks last for the process, so each gets its own. */
async function runJourney(journey: Journey, size: { columns: number; rows: number }): Promise<Frame[]> {
  const root = mkdtempSync(join(tmpdir(), 'seashell-journeys-'));
  const library = join(root, 'library');
  mkdirSync(library, { recursive: true });
  process.env.SEASHELL_CONFIG = join(root, 'config.json');
  process.env.SEASHELL_LIBRARY_DIR = library;
  process.env.SEASHELL_TEMPLATES_DIR = join(root, 'Templates');
  process.env.SEASHELL_PROMPTS_DIR = join(root, 'Prompts');
  process.env.SEASHELL_EXTRACTORS_DIR = join(root, 'Extractors');
  process.env.SEASHELL_AUTOMATIONS_DIR = join(root, 'Automations');
  process.env.SEASHELL_VOICES_DIR = join(root, 'Voices');
  process.env.SEASHELL_VOCABULARY_FILE = join(root, 'Vocabulary.txt');
  process.env.SEASHELL_BRIEFS_DIR = join(root, 'Briefs');
  process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
  process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
  process.env.SEASHELL_RUNTIME_DIR = join(root, 'Runtime');
  if (journey.standalone) process.env.SEASHELL_DISABLE_LISTENER = '1';
  else delete process.env.SEASHELL_DISABLE_LISTENER;
  const config = journey.config ?? (journey.standalone ? { meeting: { automation: { enabled: false } } }
    : journey.machine === 'fresh' ? {} : { meeting: { speakerBrowser: 'auto', backend: 'claude-code', model: 'sonnet' } });
  if (!journey.firstRun) writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify(config));
  const fresh = journey.machine === 'fresh';
  const updated = journey.machine === 'mic-updated';
  const mac: Mac = { recorder: !fresh, microphone: !fresh && !updated, meet: !fresh, calendar: false, screen: false, fresh, micSilent: journey.machine === 'mic-silent',
    micAllowedBefore: updated };
  const room: Room = { microphone: 'zeros', computer: 'zeros' };
  Object.defineProperty(process.stdout, 'columns', { value: size.columns });
  Object.defineProperty(process.stdout, 'rows', { value: size.rows });

  mock.module('../src/watch-lock.ts', () => ({ acquireMeetingWatchLock: () => undefined }));
  // Allowing the microphone from the app asks the pretend Mac, never macOS.
  const permission = { ...await import('../src/microphone-permission.ts') };
  mock.module('../src/microphone-permission.ts', () => ({ ...permission,
    allowMicrophone: async () => { mac.microphone = true; return { authorization: 'authorized', detail: 'Allowed.' }; } }));
  mock.module('../src/meeting-consent.ts', () => ({ writeMeetingConsent: () => undefined }));
  const features = { ...await import('../src/feature-status.ts') };
  mock.module('../src/feature-status.ts', () => ({ ...features,
    readFeatureStatuses: (options: object) => features.readFeatureStatuses({ ...options, dependencies: dependencies(mac, journey.oldEngine) } as never) }));
  const client = { ...await import('../src/humain-client.ts') };
  mock.module('../src/humain-client.ts', () => ({ ...client,
    async discoverHumainProviders() { return { integrations: [
      { id: 'claude-code', ready: true, detail: 'Connected' },
      { id: 'codex', ready: true, detail: 'Connected' },
      { id: 'local-openai', ready: false, detail: 'No server', nextStep: 'Connect a local server' },
    ] }; },
    async discoverHumainModels() { return ['opus', 'sonnet', 'haiku'].map((id) => ({ id, name: id, description: '', efforts: ['low', 'medium', 'high'] })); },
    // Journeys never call a model: the notes stay "being written" until the window closes, and a live
    // question, a follow-up or a brief gets a made-up answer after a moment.
    runHumainMeeting: (action: string, request: Record<string, any>, options: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('Journeys never call a model')));
      // A step can pretend the AI is not answering, to show how a failure reads.
      if (process.env.JOURNEY_MODEL_DOWN) { setTimeout(() => reject(new Error('Claude Code did not answer. Check you are online, then try again.')), 300); return; }
      const output = cannedAnswer(action, request);
      if (output) setTimeout(() => resolve({ runId: `journey-${action}`, compiledRunId: 'journey', status: 'succeeded', receipt: {}, output }), 700);
    }),
    // The pretend engine knows briefs, drafts, your notes and vocabulary, unless the journey's is older.
    meetingEngineActions: async () => new Set(['observe', 'reconcile', 'chat', 'extract', ...(journey.oldEngine ? [] : ['brief', 'draft'])]),
    // A pretend test: Claude Code answers, Codex is signed out. No prompt is sent anywhere.
    async testMeetingAi(routes: Record<string, { backend: string; model: string }>) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const distinct = new Map<string, { backend: string; model: string; roles: string[] }>();
      for (const [role, route] of Object.entries(routes)) {
        if (!route) continue;
        const key = `${route.backend}/${route.model}`;
        distinct.set(key, { ...route, roles: [...(distinct.get(key)?.roles ?? []), role] });
      }
      const results = [...distinct.values()].map((route, index) => route.backend === 'codex'
        ? { ...route, ok: false, failure: { kind: 'not-signed-in', message: '' }, reason: 'Codex is not signed in. Run codex login in a terminal, then test again.' }
        : { ...route, ok: true, latencyMs: 1400 + index * 900 });
      return { ok: results.every((result) => result.ok), engine: { ready: true }, routes: results };
    },
  }));
  // The player page is written into the pretend library; the browser is never opened.
  const video = { ...await import('../src/video-meeting.ts') };
  mock.module('../src/video-meeting.ts', () => ({ ...video,
    openMeetingVideo: (libraryDir: string, id: string, options: object = {}) => video.openMeetingVideo(libraryDir, id, { ...options, open: () => {} }) }));

  if (journey.library === 'demo') { await seed(library); await seedFiles(root, library); }
  const background = { ...await import('../src/background-watch-status.ts'), ...await import('../src/background-meeting-status.ts') } as Background;
  if (!journey.standalone) background.writeBackgroundWatchStatus(library, { phase: 'watching' });
  const { loadMeetingArtifact } = await import('../src/meeting-artifact.ts');
  const { default: App } = await import('../src/app.tsx');

  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let latest = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { latest = chunk.toString() || latest; done(); } }), size);
  const app = render(<App levels={pretendLevels(room)} setupActions={setupActions(mac)} openSettings={() => {}} />, { stdin: input as never, stdout: output as never, stderr: output as never,
    debug: true, patchConsole: false, exitOnCtrlC: false });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const type = async (keys: string) => { input.write(keys); await sleep(70); };
  const context: Context = { library, background, room, type, sleep, meeting: (id) => loadMeetingArtifact(library, id) };
  const frames: Frame[] = [];
  try {
    await sleep(500);
    for (const step of journey.steps) {
      await step.world?.(context);
      if (step.world) await sleep(900);
      if (step.history && !stripVTControlCharacters(latest).includes('Meetings')) await type('h');
      const keys = size === NARROW && step.narrowInstead ? step.narrowInstead : [...step.press ?? [], ...size === NARROW ? step.narrowPress ?? [] : []];
      for (const key of keys) await type(key);
      if (step.until) {
        const deadline = Date.now() + 2500;
        while (!stripVTControlCharacters(latest).includes(step.until) && Date.now() < deadline) await sleep(40);
      }
      await sleep(350);
      frames.push({ title: step.title, ...(step.note ? { note: step.note } : {}),
        ...(step.keys ?? step.press ? { keys: step.keys ?? step.press!.join(' ') } : {}),
        ansi: latest, text: stripVTControlCharacters(latest) });
    }
  } finally {
    app.unmount();
    input.destroy();
    output.destroy();
    rmSync(root, { recursive: true, force: true });
  }
  return frames;
}

// MARK: - Page

const COLORS = ['#3b3f46', '#ff6b6b', '#5fd38d', '#f2c14e', '#6cb2ff', '#d68cff', '#4fd1c5', '#e6e6e6'];
const BRIGHT = ['#8a8f98', '#ff8f8f', '#86e6ab', '#ffd978', '#9accff', '#e6b3ff', '#7fe6dc', '#ffffff'];
const escape = (value: string) => value.replace(/[&<>]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function ansiToHtml(ansi: string): string {
  let html = '', open = false;
  let state: { color?: string; background?: string; bold?: boolean; dim?: boolean; inverse?: boolean; italic?: boolean; underline?: boolean } = {};
  const style = () => {
    const parts: string[] = [];
    const color = state.inverse ? state.background ?? '#101216' : state.color;
    const background = state.inverse ? state.color ?? '#e6e6e6' : state.background;
    if (color) parts.push(`color:${color}`);
    if (background) parts.push(`background:${background}`);
    if (state.bold) parts.push('font-weight:700');
    if (state.dim) parts.push('opacity:.6');
    if (state.italic) parts.push('font-style:italic');
    if (state.underline) parts.push('text-decoration:underline');
    return parts.join(';');
  };
  for (const part of ansi.split(/(\x1b\[[0-9;]*m)/u)) {
    const sgr = /^\x1b\[([0-9;]*)m$/u.exec(part);
    if (!sgr) { html += escape(part); continue; }
    const codes = (sgr[1] || '0').split(';').map(Number);
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index]!;
      if (code === 0) state = {};
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 3) state.italic = true;
      else if (code === 4) state.underline = true;
      else if (code === 7) state.inverse = true;
      else if (code === 22) { state.bold = false; state.dim = false; }
      else if (code === 23) state.italic = false;
      else if (code === 24) state.underline = false;
      else if (code === 27) state.inverse = false;
      else if (code >= 30 && code <= 37) state.color = COLORS[code - 30];
      else if (code === 39) delete state.color;
      else if (code >= 40 && code <= 47) state.background = COLORS[code - 40];
      else if (code === 49) delete state.background;
      else if (code >= 90 && code <= 97) state.color = BRIGHT[code - 90];
      else if (code >= 100 && code <= 107) state.background = BRIGHT[code - 100];
      else if (code === 38 || code === 48) {
        const target = code === 38 ? 'color' : 'background';
        if (codes[index + 1] === 2) { state[target] = `rgb(${codes[index + 2]},${codes[index + 3]},${codes[index + 4]})`; index += 4; }
        else if (codes[index + 1] === 5) { const n = codes[index + 2]!; state[target] = n < 8 ? COLORS[n] : n < 16 ? BRIGHT[n - 8] : '#c8c8c8'; index += 2; }
      }
    }
    if (open) html += '</span>';
    const css = style();
    open = Boolean(css);
    if (open) html += `<span style="${css}">`;
  }
  return open ? `${html}</span>` : html;
}

interface Rendered { journey: Journey; size: 'wide' | 'narrow'; frames: Frame[] }

function renderPage(results: Rendered[], label: string): string {
  const sections = JOURNEYS.map((journey) => {
    const widths = results.filter((result) => result.journey.id === journey.id);
    if (!widths.length) return '';
    return `<section id="${journey.id}"><h2>${escape(journey.title)}</h2><p class="who">${escape(journey.who)}</p>
    ${widths.map(({ size, frames }) => `<h3>${size === 'wide' ? `${WIDE.columns} × ${WIDE.rows}` : `${NARROW.columns} × ${NARROW.rows}, narrow`}</h3><ol class="${size}">${frames.map((frame, index) => `<li>
      <p class="step"><b>${index + 1}. ${escape(frame.title)}</b>${frame.keys ? ` <kbd>${escape(frame.keys)}</kbd>` : ''}</p>
      ${frame.note ? `<p class="note">${escape(frame.note)}</p>` : ''}
      <pre class="term">${ansiToHtml(frame.ansi)}</pre></li>`).join('\n')}</ol>`).join('\n')}</section>`;
  }).join('\n');
  const toc = JOURNEYS.filter((journey) => results.some((result) => result.journey.id === journey.id))
    .map((journey) => `<a href="#${journey.id}">${escape(journey.title)}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Seashell journeys</title><style>
:root { color-scheme: light dark; --ink: #1c1c1e; --muted: #6e6e73; --line: #dcdce1; --bg: #f7f7f8; --chip: #fff; }
@media (prefers-color-scheme: dark) { :root { --ink: #f2f2f4; --muted: #a1a1a8; --line: #333338; --bg: #17181b; --chip: #24252a; } }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, system-ui, sans-serif; }
header, section { max-width: 1480px; margin: 0 auto; } h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 21px; margin: 48px 0 4px; } h3 { font-size: 13px; color: var(--muted); font-weight: 600; margin: 20px 0 8px; }
.who, .note, header p { color: var(--muted); margin: 0 0 8px; } nav { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
nav a { padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; color: inherit; text-decoration: none; background: var(--chip); }
ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 20px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 720px), 1fr)); } ol.narrow { grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); }
.step { margin: 0 0 2px; } kbd { font: 12px ui-monospace, Menlo, monospace; padding: 1px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--chip); }
.term { margin: 6px 0 0; padding: 10px 12px; overflow-x: auto; background: #101216; color: #e6e6e6; border-radius: 10px; font: 12px/1.32 ui-monospace, Menlo, monospace; }
</style></head><body><header><h1>Seashell journeys</h1><p>${escape(label)} · made-up data · ${results.reduce((total, result) => total + result.frames.length, 0)} screens</p><nav>${toc}</nav></header>${sections}</body></html>`;
}

if (process.argv[2] === '--journey') {
  const journey = JOURNEYS.find((candidate) => candidate.id === process.argv[3])!;
  const frames = await runJourney(journey, process.argv[4] === 'narrow' ? NARROW : WIDE);
  writeFileSync(process.argv[5]!, JSON.stringify(frames));
  process.exit(0);
}

const wanted = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const label = process.argv.find((argument) => argument.startsWith('--label='))?.slice(8) ?? 'Current build';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'frames'), { recursive: true });
const selected = JOURNEYS.filter((journey) => !wanted.length || wanted.includes(journey.id));
const jobs = selected.flatMap((journey) => [
  { journey, size: 'wide' as const },
  ...(journey.narrow ? [{ journey, size: 'narrow' as const }] : []),
]);
const results: Rendered[] = [];
let failed = 0;
const pending = [...jobs];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let job = pending.shift(); job; job = pending.shift()) {
    const path = join(OUT, `${job.journey.id}-${job.size}.json`);
    const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), '--journey', job.journey.id, job.size, path],
      { env: { ...process.env, FORCE_COLOR: '3' }, stdout: 'ignore', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timer);
    if (code !== 0) { failed += 1; console.error(`${job.journey.id} (${job.size}) failed:\n${error.slice(-1200)}`); continue; }
    const frames = JSON.parse(readFileSync(path, 'utf8')) as Frame[];
    rmSync(path);
    results.push({ ...job, frames });
    // Every screen fits its window: nothing runs past the edge or pushes the title line off the top.
    const size = job.size === 'wide' ? WIDE : NARROW;
    frames.forEach((frame, index) => {
      const lines = frame.text.replace(/\n$/u, '').split('\n');
      const over = lines.filter((line) => Bun.stringWidth(line) > size.columns);
      if (lines.length <= size.rows && !over.length) return;
      failed += 1;
      console.error(`${job.journey.id} (${job.size}) step ${index + 1} does not fit ${size.columns} × ${size.rows}: ` +
        `${lines.length} rows${over.length ? `, too wide: ${JSON.stringify(over[0])}` : ''}`);
    });
    frames.forEach((frame, index) => {
      const heading = `# ${job.journey.title} · ${job.size} · step ${index + 1}: ${frame.title}${frame.keys ? ` (pressed ${frame.keys})` : ''}\n`;
      writeFileSync(join(OUT, 'frames', `${job.journey.id}-${job.size}-${String(index + 1).padStart(2, '0')}.txt`), heading + frame.text);
    });
  }
}));
writeFileSync(join(OUT, 'index.html'), renderPage(results, label));
console.log(`${results.reduce((total, result) => total + result.frames.length, 0)} screens in ${join(OUT, 'index.html')}`);
process.exit(failed ? 1 : 0);
