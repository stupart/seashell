import React, { useEffect, useMemo, useRef, useState } from 'react';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { Box, Text, useInput } from 'ink';
import { defaultConfigPath, updateMeetingConfig, type SeashellConfig } from './config.ts';
import {
  FEATURE_ACTION_LABEL,
  FEATURE_STATE_COLOR,
  FEATURE_STATE_SYMBOL,
  readFeatureStatuses,
  type FeatureAction,
  type FeatureId,
  type FeatureStatus,
  type FeatureStatusDependencies,
} from './feature-status.ts';
import { initializeFirstInstall } from './first-install.ts';
import { enableMeetingLaunchAtLogin } from './launch-at-login.ts';
import { requestMeetAccessibilityPermission } from './meet-speakers.ts';
import { microphonePermission } from './microphone-permission.ts';
import { calendarPermission } from './calendar-permission.ts';
import { join } from 'path';
import { ensureTemplatesDirectory, PROFILE_FILE } from './meeting-templates.ts';
import { ensurePromptsDirectory, listPrompts, resetPrompt, type PromptSummary } from './prompts.ts';
import { ensureExtractorsDirectory, loadExtractors, type ExtractorWhen } from './extractors.ts';
import { askAutomationApprovalWithDialog, ensureAutomationsDirectory, loadAutomations, readAutomationRuns, runAutomations, runFailure,
  type AutomationRun } from './automations.ts';
import { forgetVoiceprint, listVoiceprints } from './voiceprints.ts';
import { screenCapturePermission } from './video-capture.ts';
import { checkComputerAudio, type ComputerAudioCheck } from './audio-levels.ts';
import { listTranscriptRecords } from './transcript-library.ts';
import { meetingWhen } from './tui-state.ts';
import { DEFAULT_MEETING_AUTOMATION, meetingApps, type AppRecordingPolicy } from './meeting-automation.ts';
import { KeyBar, Paragraph, Prompt, ScreenTitle, Toast, type Hint, type TitleStatus } from './tui-chrome.tsx';

/** Short names, shared with the guided setup so each thing has one name. */
export const MENU_LABEL: Record<FeatureId, string> = {
  recorder: 'Recorder',
  detection: 'Meeting detection',
  microphone: 'Microphone',
  'computer-audio': 'Computer audio',
  transcription: 'Transcription',
  'meet-names': 'Google Meet names',
  'speaker-separation': 'Who said what',
  voices: 'Saved voices',
  'ai-notes': 'AI notes',
  'notes-templates': 'Templates',
  prompts: 'Prompts',
  // What the notes call them; the files that make them live in the Extractors folder.
  extractors: 'Insights',
  automations: 'Automations',
  calendar: 'Calendar titles',
  video: 'Video',
};

export interface SettingsActions {
  enableRecorder?: () => void;
  connectMeet?: (signal: AbortSignal) => Promise<{ detail: string }>;
  allowMicrophone?: (signal: AbortSignal) => Promise<{ authorization: string; detail: string }>;
  allowCalendar?: (signal: AbortSignal) => Promise<{ authorization: string; detail: string }>;
  allowScreenRecording?: (signal: AbortSignal) => Promise<{ authorization: string; detail: string }>;
  /** The one-time check that lets the recorder use Seashell System Audio. */
  checkComputerAudio?: (signal: AbortSignal) => Promise<ComputerAudioCheck>;
  openTemplates?: (directory: string) => void;
  /** Extractors and automations: the folder in Finder. */
  openFolder?: (directory: string) => void;
  /** A prompt, in the person's text editor. */
  openFile?: (path: string) => void;
  /** Runs one automation again for the meeting whose run failed. */
  retryAutomation?: (automation: string, meetingId: string, signal: AbortSignal) => Promise<AutomationRun[]>;
}

/** Opens a folder in Finder. */
export function openFolder(directory: string): void {
  const result = spawnSync('/usr/bin/open', [directory], { stdio: 'ignore', timeout: 5_000 });
  if (result.error || result.status !== 0) throw new Error(`Could not open ${directory}`);
}

/** Opens a file in the person's text editor, as templates' "About me" opens; Finder shows it when that fails. */
export function openTextFile(path: string): void {
  const result = spawnSync('/usr/bin/open', ['-t', path], { stdio: 'ignore', timeout: 5_000 });
  if (!result.error && result.status === 0) return;
  const shown = spawnSync('/usr/bin/open', ['-R', path], { stdio: 'ignore', timeout: 5_000 });
  if (shown.error || shown.status !== 0) throw new Error(`Could not open ${path}`);
}

/** What Settings and the guided setup both need to fix things. */
export interface SetupActionProps {
  libraryDir: string;
  actions?: SettingsActions;
  /** Connecting Meet enables the reader before asking macOS for access. */
  onConnectMeet: () => void;
  /** Turning on titles saves the setting once macOS allows Calendar access. */
  onEnableCalendar: () => void;
  onOpenSpeakers: () => void;
  onOpenAI: () => void;
  /** Starting the recorder on a first run also writes the first settings. */
  onConfigChange?: (config: SeashellConfig) => void;
}

/** Starts the recorder the way `seashell setup` does on a first run, and restarts it after that. */
function enableRecorder(onConfigChange?: (config: SeashellConfig) => void): void {
  if (existsSync(defaultConfigPath())) { enableMeetingLaunchAtLogin(); return; }
  const result = initializeFirstInstall();
  onConfigChange?.(result.config);
  if (result.warning) throw new Error(result.warning);
}

/** What a setup step says: what to do while it runs, what it did, or why it failed. */
export interface SetupMessage {
  readonly text: string;
  /** progress: shown while the step runs · done: a confirmation, green in the key bar · failed: red. */
  readonly tone: 'progress' | 'done' | 'failed';
}

/**
 * The one key that fixes each thing, shared by Settings and the guided setup so
 * both do exactly the same. run() says whether the step finished.
 */
export function useSetupActions(props: SetupActionProps & { onFinished?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<SetupMessage>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const say = (tone: SetupMessage['tone']) => (text: string) => setMessage({ text, tone });
  const progress = say('progress'), done = say('done'), failed = say('failed');
  const failure = (cause: unknown) => failed(cause instanceof Error ? cause.message : String(cause));

  const run = async (action: FeatureAction): Promise<boolean> => {
    if (action === 'open-speakers') { props.onOpenSpeakers(); return true; }
    if (action === 'open-ai') { props.onOpenAI(); return true; }
    if (action === 'open-templates') {
      try {
        const directory = ensureTemplatesDirectory(props.libraryDir);
        (props.actions?.openTemplates ?? ((folder: string) => {
          spawnSync('/usr/bin/open', [folder], { stdio: 'ignore', timeout: 5_000 });
          spawnSync('/usr/bin/open', ['-t', join(folder, PROFILE_FILE)], { stdio: 'ignore', timeout: 5_000 });
        }))(directory);
        done('Opened the Templates folder and About me.');
        return true;
      } catch (cause) {
        failure(cause);
        return false;
      } finally { props.onFinished?.(); }
    }
    if (action === 'open-extractors' || action === 'open-automations') {
      try {
        const directory = action === 'open-extractors' ? ensureExtractorsDirectory(props.libraryDir) : ensureAutomationsDirectory(props.libraryDir);
        (props.actions?.openFolder ?? openFolder)(directory);
        done(`Opened the ${action === 'open-extractors' ? 'Extractors' : 'Automations'} folder in Finder.`);
        return true;
      } catch (cause) {
        failure(cause);
        return false;
      } finally { props.onFinished?.(); }
    }
    if (action === 'turn-on-video') {
      try {
        props.onConfigChange?.(updateMeetingConfig({ video: { enabled: true } }));
        done('Video on. Calls keep what was on screen.');
        return true;
      } catch (cause) {
        failure(cause);
        return false;
      } finally { props.onFinished?.(); }
    }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setMessage(undefined);
    let finished = false;
    try {
      if (action === 'enable-recorder') {
        progress('Starting the recorder…');
        (props.actions?.enableRecorder ?? (() => enableRecorder(props.onConfigChange)))();
        done('Recorder started. It also starts when you log in.');
        finished = true;
      } else if (action === 'connect-meet') {
        props.onConnectMeet();
        progress('Opening Accessibility setup… allow the Seashell entries macOS shows.');
        const result = await (props.actions?.connectMeet ?? (signal => requestMeetAccessibilityPermission(signal)))(controller.signal);
        if (!controller.signal.aborted) done(result.detail);
        finished = true;
      } else if (action === 'allow-microphone') {
        progress('macOS will ask about "Seashell Microphone". Choose Allow.');
        const result = await (props.actions?.allowMicrophone ?? (signal => microphonePermission({ request: true, signal })))(controller.signal);
        if (controller.signal.aborted) return false;
        if (result.authorization === 'denied' && !props.actions?.allowMicrophone) {
          spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'], { stdio: 'ignore', timeout: 5_000 });
        }
        finished = result.authorization === 'authorized';
        if (finished) done('Microphone allowed. Your side of meetings is recorded.'); else failed(result.detail);
      } else if (action === 'allow-calendar') {
        progress('macOS will ask about "Seashell Calendar". Choose Allow (Full Access).');
        const result = await (props.actions?.allowCalendar ?? (signal => calendarPermission({ request: true, signal })))(controller.signal);
        if (controller.signal.aborted) return false;
        if (result.authorization === 'authorized') {
          props.onEnableCalendar();
          done('Calendar titles on. Meetings take their event\'s name.');
          finished = true;
        } else {
          if ((result.authorization === 'denied' || result.authorization === 'writeOnly') && !props.actions?.allowCalendar) {
            spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'], { stdio: 'ignore', timeout: 5_000 });
          }
          failed(result.detail);
        }
      } else if (action === 'check-computer-audio') {
        progress('Playing a short sound to check. If macOS asks about "Seashell System Audio", choose Allow.');
        const result = await (props.actions?.checkComputerAudio ?? (signal => checkComputerAudio({ signal })))(controller.signal);
        if (controller.signal.aborted) return false;
        if (result.refused && !props.actions?.checkComputerAudio) {
          spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], { stdio: 'ignore', timeout: 5_000 });
        }
        finished = result.heard;
        if (finished) done(result.detail); else failed(result.detail);
      } else if (action === 'allow-screen-recording') {
        progress('macOS will ask about "Seashell Screen Capture". Choose Allow.');
        const result = await (props.actions?.allowScreenRecording ?? (signal => screenCapturePermission({ request: true, signal })))(controller.signal);
        if (controller.signal.aborted) return false;
        if (result.authorization !== 'authorized' && !props.actions?.allowScreenRecording) {
          spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], { stdio: 'ignore', timeout: 5_000 });
        }
        finished = result.authorization === 'authorized';
        if (finished) done('Video on. Calls keep what was on screen.'); else failed(result.detail);
      }
    } catch (cause) {
      if (!controller.signal.aborted) failure(cause);
    } finally {
      if (!controller.signal.aborted) { setBusy(false); props.onFinished?.(); }
    }
    return finished && !controller.signal.aborted;
  };
  /** Work that is not one of the fixes above, with the same busy row, Esc to cancel, and message after. */
  const task = async (text: string, work: (signal: AbortSignal) => Promise<SetupMessage>): Promise<void> => {
    const controller = new AbortController(); request.current = controller;
    setBusy(true); progress(text);
    try {
      const result = await work(controller.signal);
      if (!controller.signal.aborted) setMessage(result);
    } catch (cause) {
      if (!controller.signal.aborted) failure(cause);
    } finally {
      if (!controller.signal.aborted) { setBusy(false); props.onFinished?.(); }
    }
  };
  const cancel = () => { request.current?.abort(); setBusy(false); };
  return { run, task, busy, message, setMessage, done, failure, cancel };
}

// MARK: - Recording

type AppSetting = AppRecordingPolicy | 'default';
const POLICIES: readonly AppRecordingPolicy[] = ['automatic', 'ask', 'off'];
const APP_SETTINGS: readonly AppSetting[] = ['default', 'automatic', 'ask', 'off'];
const POLICY_WORDS: Record<AppSetting, string> = {
  automatic: 'Records by itself', ask: 'Asks first', off: 'Off', default: 'Same as Calls',
};

interface RecordingRow {
  readonly id: string;
  readonly label: string;
  readonly value: AppSetting;
  readonly choices: readonly AppSetting[];
  readonly help: string;
}

/** Which calls get recorded: the rule for all of them, browser calls with no calendar event, then each app. */
export function recordingRows(config: SeashellConfig): RecordingRow[] {
  const automation = config.meeting?.automation;
  const mode = automation?.enabled === false ? 'off' : automation?.mode ?? DEFAULT_MEETING_AUTOMATION.mode;
  const browsers = automation?.browserWithoutCalendar ?? DEFAULT_MEETING_AUTOMATION.browserWithoutCalendar;
  return [
    { id: 'mode', label: 'Calls', value: mode, choices: POLICIES,
      help: 'What Seashell does when it notices a call. Apps left blank follow this.' },
    { id: 'browser', label: 'Browser, no calendar', value: browsers, choices: POLICIES,
      help: 'A call in a browser with no calendar event. Asking first avoids recording videos.' },
    ...meetingApps().map(app => {
      const own = automation?.apps?.[app.id];
      return { id: app.id, label: app.name, value: own ?? 'default' as const, choices: APP_SETTINGS,
        help: `${app.name}: ${own === 'off' ? 'never recorded.' : own === 'ask' ? 'asks before recording.'
          : own === 'automatic' ? 'recorded without asking.' : 'follows Calls.'}` };
    }),
  ];
}

/** The summary beside Recording: the rule, and every app that differs from it. */
export function recordingSummary(config: SeashellConfig): string {
  const rows = recordingRows(config);
  const overrides = rows.slice(2).filter(row => row.value !== 'default')
    .map(row => `${row.label} ${POLICY_WORDS[row.value].toLowerCase()}`);
  return [POLICY_WORDS[rows[0]!.value], ...overrides].join(' · ');
}

/** Saves one recording row and returns the saved settings. */
function saveRecordingRow(config: SeashellConfig, row: RecordingRow, value: AppSetting): SeashellConfig {
  const automation = config.meeting?.automation;
  if (row.id === 'mode') {
    const mode = value as AppRecordingPolicy;
    // An older setting turned recording off a second way; choosing a mode must actually take effect.
    return updateMeetingConfig({ automation: { mode, ...(mode !== 'off' && automation?.enabled === false ? { enabled: true } : {}) } });
  }
  if (row.id === 'browser') return updateMeetingConfig({ automation: { browserWithoutCalendar: value as AppRecordingPolicy } });
  const apps = { ...automation?.apps };
  if (value === 'default') delete apps[row.id];
  else apps[row.id] = value;
  return updateMeetingConfig({ automation: { apps } });
}

// MARK: - Screen

type MenuItem =
  | { readonly kind: 'recording' }
  | { readonly kind: 'guide' }
  | { readonly kind: 'status'; readonly status: FeatureStatus };

/** The list in sections, each under a dim heading; the guided setup comes last. */
const SECTIONS: ReadonlyArray<readonly [string, ReadonlyArray<FeatureId | 'recording'>]> = [
  ['Recording', ['recording', 'recorder', 'detection', 'microphone', 'computer-audio', 'transcription']],
  ['Speakers', ['meet-names', 'speaker-separation', 'voices']],
  ['AI notes', ['ai-notes', 'notes-templates', 'prompts', 'extractors', 'automations']],
  ['Extras', ['calendar', 'video']],
];

const MENU_WIDTH = 26;
/** "Choose AI" reads "choose AI" in a key bar, never "choose ai". */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

const PROMPT_STATE: Record<PromptSummary['state'], string> = { default: 'As shipped', edited: 'Edited', empty: 'Empty · sends nothing' };

/** What an automation does, in words: never "webhook" or "write". */
const ACTION_WORDS: Record<string, string> = {
  write: 'saves a file', webhook: 'posts to a web address', shell: 'runs a command', extract: 'runs an extractor',
};

/** When an extractor runs, in a few words. */
function whenWords(when: ExtractorWhen): string {
  if (when.kind === 'always') return 'After every meeting';
  if (when.kind === 'manual') return 'By hand';
  const words = [...when.title, ...when.attendee, ...when.app];
  return `When it mentions ${words.slice(0, 3).join(', ')}${words.length > 3 ? '…' : ''}`;
}

/**
 * A file that does not load, as a row beside the ones that do: its name, then what is wrong in a
 * few words. `"Risks" has no fields. Open it to add some.` is `Risks  ✗ Nothing to pull out yet`.
 */
function problemParts(problem: { path: string; message: string }): [name: string, why: string] {
  const named = /^"([^"]*)"(?::)?\s*(.*)$/su.exec(problem.message);
  const name = named?.[1] || problem.path.split('/').at(-1)!.replace(/\.md$/u, '');
  const why = (named?.[2] ?? problem.message).trim();
  const words = /^has no fields\b/u.test(why) ? 'Nothing to pull out yet' : /^has no actions\b/u.test(why) ? 'Nothing to do yet'
    : why.replace(/\.$/u, '');
  return [name, words.charAt(0).toUpperCase() + words.slice(1)];
}

const RUN_SYMBOL: Record<AutomationRun['status'], [string, 'green' | 'red' | 'yellow']> = {
  ok: ['✓', 'green'], failed: ['✗', 'red'], skipped: ['!', 'yellow'],
};

/**
 * The title's status: whether recording works, counted from the same rows the list marks,
 * then how many optional rows to check. Never "extras", which is the name of one group.
 * Narrow, it says the same in fewer words.
 */
export function settingsStatus(statuses: readonly FeatureStatus[], room: number): TitleStatus {
  const fixes = statuses.filter(status => !status.optional && status.state !== 'ok').length;
  const extras = statuses.filter(status => status.optional && (status.state === 'broken' || status.state === 'attention')).length;
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const check = extras ? [`${extras} to check`] : [];
  const full = [fixes ? `Recording needs ${plural(fixes, 'fix', 'fixes')}` : 'Recording works', ...check].join(' · ');
  const short = [fixes ? `${fixes} to fix` : 'Recording works', ...check].join(' · ');
  return { text: Bun.stringWidth(full) <= room ? full : short, color: fixes || extras ? 'yellow' : 'green' };
}

/** Everything Seashell can do, whether it works right now, and one key to fix it. */
export default function SettingsScreen(props: SetupActionProps & {
  config: SeashellConfig;
  columns: number;
  rows?: number;
  onOpenGuide?: () => void;
  /** Listens to one source on its own, as Enter on a working Microphone or Computer audio row does. */
  onTest?: (source: 'microphone' | 'computer') => void;
  onClose: () => void;
  dependencies?: FeatureStatusDependencies;
  /** Open on this row, as a fix in the app's title line asks; otherwise on what needs the person. */
  focus?: FeatureId;
}) {
  const [statuses, setStatuses] = useState<FeatureStatus[]>();
  const [index, setIndex] = useState(0);
  // Wide, the detail sits beside the list; narrow, it opens over it.
  const [inDetail, setInDetail] = useState(false);
  const [rowIndex, setRowIndex] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loadError, setLoadError] = useState<string>();
  const opened = useRef(false);
  /** A yes-or-no question in the key bar's row, before anything is lost. */
  const [confirm, setConfirm] = useState<{ text: string; short?: string; yes: string; run: () => void }>();
  // Recording rows show what was just saved, whether or not the caller passes it back down.
  const [config, setConfig] = useState(props.config);
  useEffect(() => setConfig(props.config), [props.config]);
  const setup = useSetupActions({ ...props, onFinished: () => setRefresh(value => value + 1) });

  // Read from the settings as just saved here, so a change shows even before the caller passes it back.
  useEffect(() => {
    const controller = new AbortController();
    void readFeatureStatuses({ config, libraryDir: props.libraryDir, signal: controller.signal,
      ...(props.dependencies ? { dependencies: props.dependencies } : {}) })
      .then(next => {
        if (controller.signal.aborted) return;
        setStatuses(next);
        // Open on what needs the person; when nothing does, on the first row. Set with the list
        // itself, so a key pressed as it appears is never undone.
        if (opened.current) return;
        opened.current = true;
        const list = menuItems(next);
        const focused = list.findIndex(item => item.kind === 'status' && item.status.id === props.focus);
        const first = focused >= 0 ? focused : list.findIndex(item => item.kind === 'status' && !item.status.optional && item.status.state !== 'ok');
        if (first >= 0) setIndex(first);
      })
      .catch(cause => { if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [refresh, config]);

  // The lists behind Prompts, Extractors, Automations and Saved voices; read again after every change.
  const files = useMemo(() => {
    const safely = <T,>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
    const runs = safely(() => readAutomationRuns(props.libraryDir).slice(-5).reverse(), []);
    const titles = new Map(runs.length ? safely(() => listTranscriptRecords(props.libraryDir), []).map(entry => [entry.id, entry.title]) : []);
    return {
      prompts: safely(() => listPrompts(props.libraryDir), []),
      extractors: safely(() => loadExtractors(props.libraryDir), { extractors: [], problems: [] }),
      automations: safely(() => loadAutomations(props.libraryDir), { automations: [], problems: [] }),
      runs: runs.map(run => ({ ...run, title: titles.get(run.meetingId) ?? run.meetingId })),
      voices: safely(() => (props.dependencies?.voices ?? listVoiceprints)(), []),
    };
  }, [refresh, props.libraryDir]);

  const items = menuItems(statuses);
  const selected = items[Math.min(index, items.length - 1)];
  const rows = recordingRows(config);
  const compact = props.columns < 72;
  // Recording, prompts and saved voices have rows of their own to choose from.
  const list = selected?.kind === 'recording' ? 'recording' as const
    : selected?.kind === 'status' && (selected.status.id === 'prompts' || selected.status.id === 'voices') ? selected.status.id : undefined;
  const listLength = list === 'recording' ? rows.length : list === 'prompts' ? files.prompts.length : list === 'voices' ? files.voices.length : 0;
  // The latest run, when it failed only because a server did not answer: r tries it again.
  const retryRun = selected?.kind === 'status' && selected.status.id === 'automations' && (!compact || inDetail)
    && files.runs[0] && runFailure(files.runs[0])?.retry ? files.runs[0] : undefined;
  // Ink paints a frame before it swaps in the new input handler; read the latest state.
  const latest = useRef({ selected, itemCount: items.length, rows, inDetail, rowIndex, config, list, listLength, files, confirm, retryRun });
  latest.current = { selected, itemCount: items.length, rows, inDetail, rowIndex, config, list, listLength, files, confirm, retryRun };

  const changeRow = (step: number) => {
    const { rows, rowIndex, config } = latest.current;
    const row = rows[rowIndex];
    if (!row) return;
    const next = row.choices[(row.choices.indexOf(row.value) + step + row.choices.length) % row.choices.length]!;
    try {
      const saved = saveRecordingRow(config, row, next);
      setConfig(saved);
      props.onConfigChange?.(saved);
      setup.setMessage(undefined);
    } catch (cause) {
      setup.failure(cause);
    }
  };
  /** Does something now, says what it did in the key bar, and checks everything again. */
  const attempt = (work: () => string) => {
    try { setup.done(work()); }
    catch (cause) { setup.failure(cause); }
    setRefresh(value => value + 1);
  };
  /** Runs a failed automation again for its meeting; the run it adds says how it went. */
  const retry = (run: AutomationRun) => void setup.task(`Trying ${run.automation} again…`, async (signal) => {
    const again = props.actions?.retryAutomation ?? ((automation: string, meetingId: string, abort: AbortSignal) =>
      runAutomations(props.libraryDir, meetingId, { trigger: 'manual', only: automation, ask: askAutomationApprovalWithDialog, signal: abort }));
    const [result] = await again(run.automation, run.meetingId, signal);
    return !result || result.status === 'ok' ? { tone: 'done', text: `${run.automation} worked.` }
      : { tone: 'failed', text: result.status === 'skipped' ? `${run.automation} did not run.` : `${run.automation} failed again.` };
  });
  // Video is one switch: Enter turns it on, and asks macOS for Screen Recording if it must; Enter again turns it off.
  const switchVideo = (on: boolean) => {
    try {
      const saved = updateMeetingConfig({ video: { enabled: !on } });
      setConfig(saved);
      props.onConfigChange?.(saved);
    } catch (cause) { setup.failure(cause); return; }
    if (on) { setup.done('Video off. Calls record audio only.'); setRefresh(value => value + 1); }
    else void setup.run('allow-screen-recording');
  };

  useInput((input, key) => {
    const { selected, itemCount, rows, inDetail, list, listLength, rowIndex, files, confirm, retryRun } = latest.current;
    if (setup.busy) {
      if (key.escape) setup.cancel();
      return;
    }
    if (confirm) {
      if (input.toLowerCase() === 'y') { setConfirm(undefined); confirm.run(); }
      else if (input.toLowerCase() === 'n' || key.escape) setConfirm(undefined);
      return;
    }
    // A confirmation stays in the key bar until the next key.
    if (setup.message?.tone === 'done') setup.setMessage(undefined);
    const editingRows = inDetail && list !== undefined;
    if (key.escape || key.leftArrow && inDetail && list !== 'recording') {
      if (inDetail) { setInDetail(false); setup.setMessage(undefined); return; }
      props.onClose();
      return;
    }
    if (input === ',') { props.onClose(); return; }
    if (editingRows) {
      if (key.upArrow || input === 'k') { setRowIndex(value => Math.max(0, value - 1)); setup.setMessage(undefined); }
      else if (key.downArrow || input === 'j') { setRowIndex(value => Math.min(listLength - 1, value + 1)); setup.setMessage(undefined); }
      // ←→ change a row; space only ever records, in the app.
      else if (list === 'recording') { if (key.leftArrow || key.rightArrow) changeRow(key.leftArrow ? -1 : 1); }
      else if (list === 'prompts') {
        const prompt = files.prompts[rowIndex];
        if (!prompt) return;
        if (key.return) attempt(() => {
          ensurePromptsDirectory(props.libraryDir);
          (props.actions?.openFile ?? openTextFile)(prompt.path);
          return `Opened ${prompt.title}. Save it and the next meeting uses it.`;
        });
        else if (input === 'd' && prompt.state !== 'default') setConfirm({ text: `Undo your edits to ${prompt.title}?`, yes: 'undo',
          run: () => attempt(() => { resetPrompt(props.libraryDir, prompt.name); return `Undid your edits to ${prompt.title}.`; }) });
      } else if (list === 'voices') {
        const voice = files.voices[rowIndex];
        if (voice && key.return) setConfirm({ text: `Forget ${voice.name}'s voice? Past transcripts keep the name.`,
          short: `Forget ${voice.name}'s voice?`, yes: 'forget',
          run: () => attempt(() => {
            forgetVoiceprint(voice.name);
            // The list closes when its last person goes.
            if (listLength <= 1) setInDetail(false);
            setRowIndex(value => Math.max(0, Math.min(value, listLength - 2)));
            return `Forgot ${voice.name}'s voice. Seashell won't suggest that name again.`;
          }) });
      }
      return;
    }
    if (input === 'r' && retryRun) { retry(retryRun); return; }
    if (input === 'r') { setup.setMessage(undefined); setStatuses(undefined); setRefresh(value => value + 1); return; }
    if (!inDetail || !compact) {
      if (key.upArrow || input === 'k') { setIndex(value => Math.max(0, value - 1)); setup.setMessage(undefined); return; }
      if (key.downArrow || input === 'j') { setIndex(value => Math.min(itemCount - 1, value + 1)); setup.setMessage(undefined); return; }
    }
    if (!key.return && !(key.rightArrow && !inDetail)) return;
    if (selected?.kind === 'guide') props.onOpenGuide?.();
    else if (compact && !inDetail || list !== undefined && listLength > 0) { setInDetail(true); setRowIndex(0); setup.setMessage(undefined); }
    else if (key.return && selected?.kind === 'status' && selected.status.id === 'video') switchVideo(selected.status.state !== 'off');
    else if (key.return && selected?.kind === 'status' && selected.status.action) void setup.run(selected.status.action);
    // Only hearing it proves a microphone or the Mac's sound works, and the guide listens.
    else if (key.return && selected?.kind === 'status' && testable(selected)) {
      const source = selected.status.id === 'microphone' ? 'microphone' : 'computer';
      if (props.onTest) props.onTest(source); else props.onOpenGuide?.();
    }
  });

  function testable(item: MenuItem): boolean {
    return item.kind === 'status' && !item.status.action && (item.status.id === 'microphone' || item.status.id === 'computer-audio')
      && Boolean(props.onTest ?? props.onOpenGuide);
  }
  const summaryOf = (item: MenuItem) => item.kind === 'recording' ? recordingSummary(config)
    : item.kind === 'guide' ? 'Test mic and computer audio' : item.status.summary;
  const labelOf = (item: MenuItem) => item.kind === 'recording' ? 'Which calls'
    : item.kind === 'guide' ? 'Guided setup' : MENU_LABEL[item.status.id];
  const menuRow = (item: MenuItem, i: number) => {
    // While its rows are being changed, an item keeps its place without a second selection.
    const chosen = index === i && !(inDetail && item === selected && list !== undefined);
    // Every row keeps the glyph's column, so all the names start in one place.
    const symbol = item.kind === 'status' ? <><Text color={chosen ? undefined : FEATURE_STATE_COLOR[item.status.state]}>
      {FEATURE_STATE_SYMBOL[item.status.state]}</Text> </> : '  ';
    const label = labelOf(item);
    const key = item.kind === 'status' ? item.status.id : item.kind;
    if (!compact) return <Text key={key} inverse={chosen} bold={index === i && !chosen} wrap="truncate-end">
      {chosen ? '› ' : '  '}{symbol}{label}</Text>;
    // Narrow, each row also says how it stands, the way the meetings list shows dates.
    const room = Math.max(1, props.columns - 2 - 23);
    const summary = summaryOf(item);
    return <Text key={key} inverse={chosen} wrap="truncate-end">
      {chosen ? '› ' : '  '}{symbol}{label.padEnd(19)}
      <Text dimColor={!chosen}>{(summary.length > room ? `${summary.slice(0, room - 1)}…` : summary).padEnd(room)}</Text>
    </Text>;
  };
  // Section headings, each after a blank line, then the guide on its own at the end.
  const lines: Array<{ key: string; node: React.ReactNode; item?: number }> = [];
  items.forEach((item, i) => {
    const section = SECTIONS.find(([, ids]) => ids[0] === (item.kind === 'status' ? item.status.id : item.kind));
    if (section || item.kind === 'guide') {
      if (lines.length) lines.push({ key: `gap-${i}`, node: <Text key={`gap-${i}`}> </Text> });
      if (section) lines.push({ key: section[0], node: <Text key={section[0]} dimColor>  {section[0]}</Text> });
    }
    lines.push({ key: `item-${i}`, node: menuRow(item, i), item: i });
  });
  // A short window scrolls with the selection, so every row stays reachable, and a dim line
  // at either edge says how many rows are out of view that way.
  const height = props.rows ? Math.max(4, props.rows - 3) : lines.length + 1;
  const selectedLine = Math.max(0, lines.findIndex(line => line.item === index));
  let top = 0;
  let room = height;
  if (lines.length > height) {
    room = height - 1;
    if (selectedLine > room - 2) {
      room = height - 2;
      top = Math.max(1, Math.min(selectedLine - room + 2, lines.length - room));
      // At the end there is nothing below to count.
      if (top + room >= lines.length) { room = height - 1; top = lines.length - room; }
    }
  }
  const shown = lines.slice(top, top + room);
  // A heading never sits alone at the bottom edge, cut off from its rows, nor a blank at the top.
  while (shown.length && shown.at(-1)!.item === undefined && top + shown.length < lines.length) shown.pop();
  if (top > 0 && shown[0]?.key.startsWith('gap-')) { shown.shift(); top += 1; }
  const hidden = (from: number, to: number) => lines.slice(from, to).filter(line => line.item !== undefined).length;
  const above = hidden(0, top);
  const below = hidden(top + shown.length, lines.length);
  const menu = <Box flexDirection="column" flexShrink={0} {...(compact ? {} : { width: MENU_WIDTH, paddingRight: 1,
    borderStyle: 'single' as const, borderTop: false, borderBottom: false, borderLeft: false, borderDimColor: true })}>
    {statuses ? <>
      {above > 0 && <Text dimColor>  ↑ {above} more</Text>}
      {shown.map(line => line.node)}
      {below > 0 && <Text dimColor>  ↓ {below} more</Text>}
    </> : <Text dimColor>  {loadError ?? 'Checking what works…'}</Text>}
  </Box>;

  // The detail never shrinks its heading: the body below it gives way, and is cut, first.
  const width = compact ? props.columns - 2 : props.columns - 2 - MENU_WIDTH - 1;
  const heading = (title: string, summary?: React.ReactNode) => <Box flexDirection="column" flexShrink={0}>
    <Text bold wrap="truncate-end">{title}</Text>
    {summary}
  </Box>;
  /** One row of a list in the detail: chosen with › and inverse only while its rows are being chosen from. */
  const listRow = (key: string, i: number, label: string, value: React.ReactNode, labelWidth: number) => {
    const chosen = inDetail && i === rowIndex;
    return <Text key={key} inverse={chosen} wrap="truncate-end">{chosen ? '› ' : '  '}{label.slice(0, labelWidth - 1).padEnd(labelWidth)}
      <Text dimColor={!chosen}>{value}</Text></Text>;
  };
  // In the same columns as the files that load, so the broken one reads as one of them.
  const problemLines = (problems: readonly { path: string; message: string }[]) => problems.map(problem => {
    const [name, why] = problemParts(problem);
    return <Text key={problem.path} wrap="truncate-end">{'  '}{name.slice(0, 21).padEnd(22)}<Text color="red">✗ {why}</Text></Text>;
  });
  const filesBody = (id: FeatureId) => {
    if (id === 'prompts') return files.prompts.map((prompt, i) => listRow(prompt.name, i, prompt.title, PROMPT_STATE[prompt.state], 18));
    if (id === 'voices') return files.voices.map((voice, i) =>
      listRow(voice.name, i, voice.name, `${voice.meetings} ${voice.meetings === 1 ? 'meeting' : 'meetings'}`, 22));
    if (id === 'extractors') return <>
      {files.extractors.extractors.map(extractor => <Text key={extractor.path} wrap="truncate-end">
        {'  '}{extractor.name.slice(0, 21).padEnd(22)}<Text dimColor>{whenWords(extractor.when)} · {extractor.fields.length} {extractor.fields.length === 1 ? 'field' : 'fields'}</Text>
      </Text>)}
      {problemLines(files.extractors.problems)}
    </>;
    if (id === 'automations') return <>
      {files.automations.automations.map(automation => <Text key={automation.path} wrap="truncate-end">
        {'  '}{automation.name.slice(0, 21).padEnd(22)}<Text dimColor>{automation.enabled ? 'On' : 'Off'} · {[...new Set(automation.actions.map(action => ACTION_WORDS[action.kind] ?? action.kind))].join(', ')}</Text>
      </Text>)}
      {problemLines(files.automations.problems)}
      {files.runs.length > 0 && <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Text dimColor>  Last runs</Text>
        {files.runs.map((run, i) => {
          const [symbol, color] = RUN_SYMBOL[run.status];
          const why = runFailure(run)?.text ?? run.detail ?? run.actions.find(action => action.status === run.status && action.detail)?.detail;
          const again = run === retryRun ? ' r tries again.' : '';
          // What went wrong gets a line of its own, so it is never cut to make room for the meeting.
          return <Box key={`${run.at}-${i}`} flexDirection="column" flexShrink={0}>
            <Text wrap="truncate-end"><Text color={color}>{symbol}</Text> {run.automation}<Text dimColor> · {run.title} · {meetingWhen(run.at)}</Text></Text>
            {run.status !== 'ok' && why ? <Box paddingLeft={2}><Paragraph width={width - 2} color={color} text={`${why}${again}`} /></Box> : null}
          </Box>;
        })}
      </Box>}
    </>;
    return null;
  };
  const detail = !selected ? null : selected.kind === 'recording' ? <>
    {heading('Which calls', <Text dimColor wrap="truncate-end">Which calls Seashell records, and when it asks first.</Text>)}
    <Box flexDirection="column" flexShrink={1} overflow="hidden" marginTop={1}>
      {rows.map((row, i) => {
        const chosen = inDetail && i === rowIndex;
        // An app that follows Calls shows what that means, dim, so the ones set apart stand out.
        const value = chosen ? `‹ ${POLICY_WORDS[row.value]} ›` : row.value === 'default' ? undefined : POLICY_WORDS[row.value];
        return <React.Fragment key={row.id}>
          {i === 2 && <Text dimColor>  Apps</Text>}
          <Text inverse={chosen} wrap="truncate-end">{chosen ? '› ' : '  '}{row.label.padEnd(compact ? 22 : 24)}
            {value === undefined ? <Text dimColor>{POLICY_WORDS[rows[0]!.value]}</Text> : <Text>{value}</Text>}</Text>
        </React.Fragment>;
      })}
    </Box>
    {inDetail && rows[rowIndex] && <Box marginTop={1} flexShrink={0}><Paragraph text={rows[rowIndex]!.help} width={width} dimColor /></Box>}
  </> : selected.kind === 'guide' ? <>
    {heading('Guided setup')}
    <Box marginTop={1} flexShrink={1} overflow="hidden">
      <Paragraph width={width} text="Walks through the recorder, then listens to your microphone and your Mac's sound so you know both are heard. Then the extras. Steps that are already done are skipped." />
    </Box>
  </> : <>
    {heading(MENU_LABEL[selected.status.id],
      <Text color={FEATURE_STATE_COLOR[selected.status.state]} wrap="truncate-end">{FEATURE_STATE_SYMBOL[selected.status.state]} {selected.status.summary}</Text>)}
    <Box flexDirection="column" flexShrink={1} overflow="hidden">
      <Box marginTop={1} flexShrink={0}><Paragraph width={width} text={selected.status.detail} /></Box>
      {/* Yellow only when something needs doing; on a row that works, it is a note. */}
      {selected.status.fix && <Box marginTop={1} flexShrink={0}>{selected.status.state === 'ok'
        ? <Paragraph width={width} text={selected.status.fix} />
        : <Paragraph width={width} color="yellow" text={`Next: ${selected.status.fix}`} />}</Box>}
      {!selected.status.action && selected.status.state !== 'ok' && selected.status.command
        ? <Paragraph width={width} text={`Run: ${selected.status.command}`} /> : null}
      {['prompts', 'voices', 'extractors', 'automations'].includes(selected.status.id) &&
        <Box flexDirection="column" marginTop={1} flexShrink={0}>{filesBody(selected.status.id)}</Box>}
    </Box>
  </>;

  const action = selected?.kind === 'status' ? selected.status.action : undefined;
  const video = selected?.kind === 'status' && selected.status.id === 'video' ? selected.status : undefined;
  // One order everywhere: what Enter does, then moving, then r, then Esc.
  const hints: Hint[] = compact && !inDetail ? [['Enter', 'open'], ['↑↓', 'choose'], ['r', 'recheck'], ['Esc', 'back']]
    : inDetail && list === 'recording' ? [['←→', 'change'], ['↑↓', 'choose'], ['Esc', 'back']]
    : inDetail && list === 'prompts' ? [['Enter', 'edit'], ...(files.prompts[rowIndex]?.state !== 'default' ? [['d', 'undo edits'] as Hint] : []),
      ['↑↓', 'choose'], ['Esc', 'back']]
    : inDetail && list === 'voices' && listLength ? [['Enter', 'forget'], ['↑↓', 'choose'], ['Esc', 'back']]
    : [
      ...(selected?.kind === 'recording' ? [['Enter', 'change'] as Hint] : selected?.kind === 'guide' ? [['Enter', 'start'] as Hint]
        : video ? [['Enter', video.state === 'off' ? 'turn on' : 'turn off'] as Hint]
        : list === 'prompts' ? [['Enter', 'choose a prompt'] as Hint] : list === 'voices' && listLength ? [['Enter', 'choose someone'] as Hint]
        : action ? [['Enter', lowerFirst(FEATURE_ACTION_LABEL[action])] as Hint] : selected && testable(selected) ? [['Enter', 'test it now'] as Hint] : []),
      ...(compact ? [] : [['↑↓', 'choose'] as Hint]), ['r', retryRun ? 'try again' : 'recheck'], ['Esc', 'back'],
    ];
  const titleRoom = props.columns - 2 - 14;
  const failed = setup.message?.tone === 'failed' ? setup.message.text : undefined;

  return <Box flexDirection="column" paddingX={1} {...(props.rows ? { height: props.rows } : {})} overflow="hidden">
    <ScreenTitle name="Settings" status={statuses ? settingsStatus(statuses, titleRoom) : undefined} />
    <Box flexDirection="row" flexGrow={1} overflow="hidden">
      {(!compact || !inDetail) && menu}
      {(!compact || inDetail) && <Box flexDirection="column" flexGrow={1} minWidth={0} overflow="hidden" {...(compact ? {} : { paddingLeft: 1 })}>
        {detail}
        {/* What to do while a step runs is attention; why it failed is a failure. Both stay until the next move. */}
        {setup.busy && setup.message?.tone === 'progress' && <Box marginTop={1} flexShrink={0}><Paragraph width={width} color="yellow" text={setup.message.text} /></Box>}
        {failed && <Box marginTop={1} flexShrink={0}><Paragraph width={width} color="red" text={failed} /></Box>}
      </Box>}
    </Box>
    {setup.busy ? <Prompt text="◐ Working…" color="magenta" hints={[['Esc', 'cancel']]} columns={props.columns - 2} />
      : confirm ? <Prompt text={confirm.text} {...(confirm.short ? { short: confirm.short } : {})} color="yellow"
        hints={[['y', confirm.yes], ['n', 'keep']]} columns={props.columns - 2} />
      : setup.message?.tone === 'done' ? <Toast text={setup.message.text} columns={props.columns - 2} />
      : <KeyBar hints={hints} columns={props.columns - 2} help={false} />}
  </Box>;
}

/** The items in the order the list shows them: by section, then the guided setup. */
function menuItems(statuses: readonly FeatureStatus[] | undefined): MenuItem[] {
  if (!statuses) return [];
  return [
    ...SECTIONS.flatMap(([, ids]) => ids.flatMap((id): MenuItem[] => {
      if (id === 'recording') return [{ kind: 'recording' }];
      const status = statuses.find(candidate => candidate.id === id);
      return status ? [{ kind: 'status', status }] : [];
    })),
    { kind: 'guide' },
  ];
}
