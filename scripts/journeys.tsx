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
  /** How the keys read to a person, when they are not printable. */
  keys?: string;
  /** Change the world before the frame: a meeting starts, a recording fails. */
  world?: (context: Context) => Promise<void> | void;
  /** Wait until this appears, so the frame is never captured mid-update. */
  until?: string;
  /** History starts open on a wide window and closed on a narrow one. */
  history?: boolean;
}
type Machine = 'fresh' | 'ready' | 'mic-silent';
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
      { title: 'Speakers setup', press: ['v'], until: 'peaker', note: 'Setting up who-said-what.' },
      { title: 'Back to the app', press: [ESC], keys: 'Esc' },
      { title: 'AI setup', press: ['p'], until: 'AI', note: 'Choosing what writes the notes.' },
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
        world: ({ sleep }) => sleep(6_000), until: 'sending silence' },
      { title: 'Spoke', note: 'Speech-level sound passes the step and lets go of the microphone.',
        world: ({ room }) => { room.microphone = 'speech'; }, until: 'Heard you' },
      { title: 'Computer audio', press: [ENTER], keys: 'Enter', until: 'Listening' },
      { title: 'Played a sound', world: ({ room }) => { room.computer = 'music'; }, until: 'Heard your Mac' },
      { title: 'Optional extras', press: [ENTER], keys: 'Enter', until: 'Optional extras' },
      { title: 'Finish chosen', press: [DOWN, DOWN, DOWN, DOWN], keys: '↓ ↓ ↓ ↓' },
      { title: 'Done', press: [ENTER], keys: 'Enter', until: "You're set" },
      { title: 'Back in the app', press: [ENTER], keys: 'Enter', until: 'ready', note: 'What the guide heard counts: nothing left to fix.' },
    ],
  },
  {
    id: 'meeting', title: 'A meeting, start to finish', who: 'Someone with Seashell open during a call that the background recorder picks up.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'Waiting for a meeting', note: 'Nothing happening yet.' },
      { title: 'A call is noticed', note: 'A browser call without a calendar event: Seashell asks first.',
        world: ({ library, background }) => background.writeBackgroundWatchStatus(library, { phase: 'awaiting-consent',
          candidate: { id: 'call', title: 'Design review', appName: 'Chrome' }, consentId: 'demo-1' }), until: 'record this' },
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
      { title: 'Transcript', press: ['2'], keys: '2' },
      { title: 'Chat', press: ['3'], keys: '3' },
      { title: 'Asking a question', press: ['a'], keys: 'A', note: 'Typing a question about the meeting.' },
      { title: 'Question typed', press: [...'What did we promise Acme?'], keys: 'What did we promise Acme?' },
      { title: 'Cancelled', press: [ESC], keys: 'Esc' },
      { title: 'Notes setup', press: ['1', 'n'], keys: '1 N', until: 'Notes setup', note: 'Template, a note to the AI, and whether AI may see it.' },
      { title: 'Back', press: [ESC], keys: 'Esc' },
      { title: 'Export', press: ['2', 'e'], keys: '2 E', note: 'Getting the transcript out.' },
    ],
  },
  {
    id: 'find', title: 'Find something from a past meeting', who: 'Someone trying to remember what was said last week.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'History', history: true, until: 'Acme' },
      { title: 'Search', press: ['/'], keys: '/', note: 'Search box opens.' },
      { title: 'Typing', press: [...'pricing'], keys: 'pricing' },
      { title: 'Results', press: [ENTER], keys: 'Enter' },
      { title: 'Opened a result', press: [ENTER], keys: 'Enter', until: '1 Notes' },
      { title: 'Delete asked', press: ['d'], keys: 'D', note: 'Moving a meeting to the Trash.' },
      { title: 'Delete cancelled', press: ['n'], keys: 'N' },
    ],
  },
  {
    id: 'speakers', title: 'Put names on speakers', who: 'Someone who sees "Remote speaker 1" and wants a real name.',
    machine: 'ready', library: 'demo', narrow: true,
    steps: [
      { title: 'History', history: true, until: 'Acme' },
      { title: 'Meeting transcript', press: [ENTER, '2'], keys: 'Enter 2', until: 'Remote' },
      { title: 'Picking a speaker', press: ['r'], keys: 'R', until: 'Name a speaker', note: 'Who can be named?' },
      { title: 'Chose one', press: [DOWN, ENTER], keys: '↓ Enter' },
      { title: 'Name typed', press: [...'Dana'], keys: 'Dana' },
      { title: 'Saved', press: [ENTER], keys: 'Enter' },
      { title: 'Hide speakers', press: ['s'], keys: 'S', note: 'Toggle.' },
      { title: 'Show speakers again, hide times', press: ['s', 't'], keys: 'S T' },
      { title: 'Speaker settings', press: ['t', 'v'], keys: 'T V', until: 'peaker' },
    ],
  },
  {
    id: 'ai-setup', title: 'Turn on AI notes', who: 'Someone who pressed for notes before choosing an AI.',
    machine: 'fresh', library: 'demo', narrow: true,
    steps: [
      { title: 'History', history: true, until: 'Weekly' },
      { title: 'Meeting without notes', press: [DOWN, ENTER], keys: '↓ Enter', until: '1 Notes' },
      { title: 'Asked for notes', press: ['g'], keys: 'G', note: 'No AI chosen yet: what happens?' },
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
        world: ({ library, background }) => liveMeeting(library, background, { microphoneDown: true }), until: 'NOT CAPTURING' },
      { title: 'Audio help', press: ['i'], keys: 'I', until: 'Sound' },
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
      { title: 'Guided setup again', press: [UP, UP, UP, UP, UP, UP, UP, UP, ENTER], keys: '↑ × 8 Enter', until: 'Guided setup',
        note: 'Re-run any time to hear the microphone again.' },
      { title: 'Back to Settings', press: [ESC], keys: 'Esc', until: 'Recording' },
      { title: 'Help', press: [ESC, '?'], keys: 'Esc ?', until: 'Keys' },
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
    const record = createTranscriptRecord({ transcript: demoTranscript(), speakers: SPEAKERS },
      { id, title, now: typeof when === 'number' ? new Date(Date.now() - when * 3_600_000) : when });
    saveTranscriptRecord(library, record);
    const artifact = createMeetingArtifact(record);
    if (notes) {
      artifact.status = 'ready';
      artifact.analysis = {
        final: true, runId: 'demo', createdAt: record.createdAt, template: 'Customer call',
        summary: 'Acme is ready to pilot with twelve people in November if the security review clears. Data stays on their own machines.',
        claims: [
          { id: 'c1', type: 'decision', text: 'Start the pilot with twelve people in November.', evidenceSegmentIds: ['s000006'], confidence: 0.9 },
          { id: 'c2', type: 'action_item', text: 'Send the security summary by Friday.', person: 'You', evidenceSegmentIds: ['s000005'], confidence: 0.9 },
          { id: 'c3', type: 'action_item', text: 'Plan a kickoff the week of the tenth.', evidenceSegmentIds: ['s000011'], confidence: 0.8 },
          { id: 'c4', type: 'note', text: 'Legal may require data to stay in Canada.', evidenceSegmentIds: ['s000002'], confidence: 0.7 },
        ] as never,
        notes: [
          { heading: 'Where they stand', items: [{ text: 'Per-seat pricing works for them.', evidenceSegmentIds: ['s000001'] }] },
          { heading: 'Next steps', items: [
            { text: 'You send the security summary by Friday.', evidenceSegmentIds: ['s000005'] },
            { text: 'Kickoff the week of the tenth.', evidenceSegmentIds: ['s000011'] },
          ] },
        ] as never,
      };
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

async function liveMeeting(library: string, background: Background, options: { microphoneDown?: boolean } = {}) {
  const { createTranscriptRecord } = await import('../src/transcript-record.ts');
  const { saveTranscriptRecord } = await import('../src/transcript-library.ts');
  const { createMeetingArtifact, saveMeetingArtifact } = await import('../src/meeting-artifact.ts');
  const { CaptureHealthTracker } = await import('../src/capture-health.ts');
  const record = createTranscriptRecord({ transcript: demoTranscript(1).slice(0, 7), speakers: SPEAKERS },
    { id: 'demo-live', title: 'Design review', now: new Date(Date.now() - 120_000) });
  const saved = saveTranscriptRecord(library, record);
  saveMeetingArtifact(library, createMeetingArtifact(record));
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
interface Mac { recorder: boolean; microphone: boolean; meet: boolean; calendar: boolean; fresh: boolean; micSilent: boolean }

function dependencies(mac: Mac): FeatureStatusDependencies {
  return {
    launchAtLogin: () => ({ enabled: mac.recorder, loaded: mac.recorder, label: 'demo', plistPath: '/demo', command: [] }),
    watchStatus: () => (mac.recorder ? { schemaVersion: 1, phase: 'watching', pid: 1, updatedAtUnixMs: Date.now() } : undefined) as never,
    meetConnection: async () => (mac.meet
      ? { state: 'idle', detail: 'Join a call', accessibilityTrusted: true }
      : { state: 'off', detail: 'Not connected', accessibilityTrusted: false }) as never,
    microphone: async () => (mac.microphone ? { authorization: 'authorized', detail: 'Allowed.' } : { authorization: 'notDetermined', detail: 'Not asked.' }) as never,
    calendar: async () => ({ authorization: mac.calendar ? 'authorized' : 'notDetermined', detail: 'Calendar.', calendars: 2 }) as never,
    lastMeeting: () => (mac.fresh ? undefined : { title: 'Acme discovery call', createdAt: new Date().toISOString(), microphoneChunks: 3,
      audibleMicrophoneChunks: mac.micSilent ? 0 : 3, computerChunks: 3, audibleComputerChunks: 3, meetingKey: 'meet:chrome:/abc-defg-hij' }) as never,
    speakerSeparationReady: () => !mac.fresh, aiEngineInstalled: () => !mac.fresh,
    transcriptionReady: () => true, systemAudioHelperReady: () => true,
    microphoneRecorderSince: () => Date.now() - 86_400_000,
  };
}

/** Setup that changes the pretend Mac instead of launchd, macOS permissions or System Settings. */
function setupActions(mac: Mac): SettingsActions {
  return {
    enableRecorder: () => { mac.recorder = true; },
    allowMicrophone: async () => { mac.microphone = true; return { authorization: 'authorized', detail: 'Allowed.' }; },
    connectMeet: async () => { mac.meet = true; return { detail: 'Google Meet connected.' }; },
    allowCalendar: async () => { mac.calendar = true; return { authorization: 'authorized', detail: 'Allowed.' }; },
    openTemplates: () => {},
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
  process.env.SEASHELL_DISABLE_SYSTEM_AUDIO = '1';
  process.env.SEASHELL_MEETING_COMMAND_PATH = join(root, 'meeting-command.json');
  if (journey.standalone) process.env.SEASHELL_DISABLE_LISTENER = '1';
  else delete process.env.SEASHELL_DISABLE_LISTENER;
  const config = journey.standalone ? { meeting: { automation: { enabled: false } } }
    : journey.machine === 'fresh' ? {} : { meeting: { speakerBrowser: 'auto', backend: 'claude-code', model: 'sonnet' } };
  if (!journey.firstRun) writeFileSync(process.env.SEASHELL_CONFIG, JSON.stringify(config));
  const fresh = journey.machine === 'fresh';
  const mac: Mac = { recorder: !fresh, microphone: !fresh, meet: !fresh, calendar: false, fresh, micSilent: journey.machine === 'mic-silent' };
  const room: Room = { microphone: 'zeros', computer: 'zeros' };
  Object.defineProperty(process.stdout, 'columns', { value: size.columns });
  Object.defineProperty(process.stdout, 'rows', { value: size.rows });

  mock.module('../src/watch-lock.ts', () => ({ acquireMeetingWatchLock: () => undefined }));
  mock.module('../src/meeting-consent.ts', () => ({ writeMeetingConsent: () => undefined }));
  const features = { ...await import('../src/feature-status.ts') };
  mock.module('../src/feature-status.ts', () => ({ ...features,
    readFeatureStatuses: (options: object) => features.readFeatureStatuses({ ...options, dependencies: dependencies(mac) } as never) }));
  const client = { ...await import('../src/humain-client.ts') };
  mock.module('../src/humain-client.ts', () => ({ ...client,
    async discoverHumainProviders() { return { integrations: [
      { id: 'claude-code', ready: true, detail: 'Connected' },
      { id: 'codex', ready: true, detail: 'Connected' },
      { id: 'local-openai', ready: false, detail: 'No server', nextStep: 'Connect a local server' },
    ] }; },
    async discoverHumainModels() { return ['opus', 'sonnet', 'haiku'].map((id) => ({ id, name: id, description: '', efforts: ['low', 'medium', 'high'] })); },
    async runHumainMeeting() { throw new Error('Journeys never call a model'); },
  }));

  if (journey.library === 'demo') await seed(library);
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
      for (const key of step.press ?? []) await type(key);
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
