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
import { ensureAutomationsDirectory, loadAutomations, readAutomationRuns, type AutomationRun } from './automations.ts';
import { forgetVoiceprint, listVoiceprints } from './voiceprints.ts';
import { screenCapturePermission } from './video-capture.ts';
import { listTranscriptRecords } from './transcript-library.ts';
import { meetingWhen } from './tui-state.ts';
import { DEFAULT_MEETING_AUTOMATION, meetingApps, type AppRecordingPolicy } from './meeting-automation.ts';
import { KeyBar, Paragraph, ScreenTitle, type Hint } from './tui-chrome.tsx';

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
  extractors: 'Extractors',
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
  openTemplates?: (directory: string) => void;
  /** Extractors and automations: the folder in Finder. */
  openFolder?: (directory: string) => void;
  /** A prompt, in the person's text editor. */
  openFile?: (path: string) => void;
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

/**
 * The one key that fixes each thing, shared by Settings and the guided setup so
 * both do exactly the same. run() says whether the step finished.
 */
export function useSetupActions(props: SetupActionProps & { onFinished?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);

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
        setMessage(`Opened ${directory}. Edit "About me", then any template; each ## heading is a section.`);
        return true;
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally { props.onFinished?.(); }
    }
    if (action === 'open-extractors' || action === 'open-automations') {
      try {
        const directory = action === 'open-extractors' ? ensureExtractorsDirectory(props.libraryDir) : ensureAutomationsDirectory(props.libraryDir);
        (props.actions?.openFolder ?? openFolder)(directory);
        setMessage(action === 'open-extractors'
          ? `Opened ${directory}. Each extractor is a Markdown file; the example shows how.`
          : `Opened ${directory}. Each automation is a Markdown file; the example stays off until you turn it on.`);
        return true;
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally { props.onFinished?.(); }
    }
    if (action === 'turn-on-video') {
      try {
        props.onConfigChange?.(updateMeetingConfig({ video: { enabled: true } }));
        setMessage('Video is on. Calls record their window from now on.');
        return true;
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally { props.onFinished?.(); }
    }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setMessage(undefined);
    let finished = false;
    try {
      if (action === 'enable-recorder') {
        setMessage('Starting the background recorder…');
        (props.actions?.enableRecorder ?? (() => enableRecorder(props.onConfigChange)))();
        setMessage('Background recorder started. It also starts when you log in.');
        finished = true;
      } else if (action === 'connect-meet') {
        props.onConnectMeet();
        setMessage('Opening Accessibility setup… allow the Seashell entries macOS shows.');
        const result = await (props.actions?.connectMeet ?? (signal => requestMeetAccessibilityPermission(signal)))(controller.signal);
        if (!controller.signal.aborted) setMessage(result.detail);
        finished = true;
      } else if (action === 'allow-microphone') {
        setMessage('macOS will ask about "Seashell Microphone". Choose Allow.');
        const result = await (props.actions?.allowMicrophone ?? (signal => microphonePermission({ request: true, signal })))(controller.signal);
        if (controller.signal.aborted) return false;
        if (result.authorization === 'denied' && !props.actions?.allowMicrophone) {
          spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'], { stdio: 'ignore', timeout: 5_000 });
        }
        finished = result.authorization === 'authorized';
        setMessage(finished ? 'Microphone allowed. Your side of meetings is now recorded.' : result.detail);
      } else if (action === 'allow-calendar') {
        setMessage('macOS will ask about "Seashell Calendar". Choose Allow (Full Access).');
        const result = await (props.actions?.allowCalendar ?? (signal => calendarPermission({ request: true, signal })))(controller.signal);
        if (controller.signal.aborted) return false;
        if (result.authorization === 'authorized') {
          props.onEnableCalendar();
          setMessage('Calendar titles are on. Meetings with a calendar event get its name and attendees.');
          finished = true;
        } else {
          if ((result.authorization === 'denied' || result.authorization === 'writeOnly') && !props.actions?.allowCalendar) {
            spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'], { stdio: 'ignore', timeout: 5_000 });
          }
          setMessage(result.detail);
        }
      } else if (action === 'allow-screen-recording') {
        setMessage('macOS will ask about "Seashell Screen Capture". Choose Allow.');
        const result = await (props.actions?.allowScreenRecording ?? (signal => screenCapturePermission({ request: true, signal })))(controller.signal);
        if (controller.signal.aborted) return false;
        if (result.authorization !== 'authorized' && !props.actions?.allowScreenRecording) {
          spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], { stdio: 'ignore', timeout: 5_000 });
        }
        finished = result.authorization === 'authorized';
        setMessage(finished ? 'Screen Recording allowed. Calls now keep their video.' : result.detail);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) { setBusy(false); props.onFinished?.(); }
    }
    return finished && !controller.signal.aborted;
  };
  const cancel = () => { request.current?.abort(); setBusy(false); };
  return { run, busy, message, setMessage, cancel };
}

// MARK: - Recording

type AppSetting = AppRecordingPolicy | 'default';
const POLICIES: readonly AppRecordingPolicy[] = ['automatic', 'ask', 'off'];
const APP_SETTINGS: readonly AppSetting[] = ['default', 'automatic', 'ask', 'off'];
const POLICY_WORDS: Record<AppSetting, string> = {
  automatic: 'Records by itself', ask: 'Asks first', off: 'Off', default: 'Default',
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
      help: 'What Seashell does when it notices a call. Apps on Default follow this.' },
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

const MENU_WIDTH = 26;
/** "Choose AI" reads "choose AI" in a key bar, never "choose ai". */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

const PROMPT_STATE: Record<PromptSummary['state'], string> = { default: 'As shipped', edited: 'Edited', empty: 'Empty · sends nothing' };

/** When an extractor runs, in a few words. */
function whenWords(when: ExtractorWhen): string {
  if (when.kind === 'always') return 'After every meeting';
  if (when.kind === 'manual') return 'By hand';
  const words = [...when.title, ...when.attendee, ...when.app];
  return `When it mentions ${words.slice(0, 3).join(', ')}${words.length > 3 ? '…' : ''}`;
}

const RUN_SYMBOL: Record<AutomationRun['status'], [string, 'green' | 'red' | 'yellow']> = {
  ok: ['✓', 'green'], failed: ['✗', 'red'], skipped: ['!', 'yellow'],
};

/** Everything Seashell can do, whether it works right now, and one key to fix it. */
export default function SettingsScreen(props: SetupActionProps & {
  config: SeashellConfig;
  columns: number;
  rows?: number;
  onOpenGuide?: () => void;
  onClose: () => void;
  dependencies?: FeatureStatusDependencies;
}) {
  const [statuses, setStatuses] = useState<FeatureStatus[]>();
  const [index, setIndex] = useState(0);
  // Wide, the detail sits beside the list; narrow, it opens over it.
  const [inDetail, setInDetail] = useState(false);
  const [rowIndex, setRowIndex] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loadError, setLoadError] = useState<string>();
  /** A yes-or-no question in the key bar's row, before anything is lost. */
  const [confirm, setConfirm] = useState<{ text: string; run: () => void }>();
  // Recording rows show what was just saved, whether or not the caller passes it back down.
  const [config, setConfig] = useState(props.config);
  useEffect(() => setConfig(props.config), [props.config]);
  const setup = useSetupActions({ ...props, onFinished: () => setRefresh(value => value + 1) });

  useEffect(() => {
    const controller = new AbortController();
    void readFeatureStatuses({ config: props.config, libraryDir: props.libraryDir, signal: controller.signal,
      ...(props.dependencies ? { dependencies: props.dependencies } : {}) })
      .then(next => { if (!controller.signal.aborted) setStatuses(next); })
      .catch(cause => { if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [refresh, props.config]);

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

  const items: MenuItem[] = [{ kind: 'recording' }, { kind: 'guide' },
    ...(statuses ?? []).map(status => ({ kind: 'status' as const, status }))];
  // Open on what needs the person; when nothing does, on the first row.
  const opened = useRef(false);
  useEffect(() => {
    if (!statuses || opened.current) return;
    opened.current = true;
    const first = items.findIndex(item => item.kind === 'status' && !item.status.optional && item.status.state !== 'ok');
    setIndex(Math.max(0, first));
  }, [statuses]);
  const selected = items[Math.min(index, items.length - 1)];
  const rows = recordingRows(config);
  const compact = props.columns < 72;
  // Recording, prompts and saved voices have rows of their own to choose from.
  const list = selected?.kind === 'recording' ? 'recording' as const
    : selected?.kind === 'status' && (selected.status.id === 'prompts' || selected.status.id === 'voices') ? selected.status.id : undefined;
  const listLength = list === 'recording' ? rows.length : list === 'prompts' ? files.prompts.length : list === 'voices' ? files.voices.length : 0;
  // Ink paints a frame before it swaps in the new input handler; read the latest state.
  const latest = useRef({ selected, itemCount: items.length, rows, inDetail, rowIndex, config, list, listLength, files, confirm });
  latest.current = { selected, itemCount: items.length, rows, inDetail, rowIndex, config, list, listLength, files, confirm };

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
      setup.setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const attempt = (work: () => string) => {
    try { setup.setMessage(work()); }
    catch (cause) { setup.setMessage(cause instanceof Error ? cause.message : String(cause)); }
    setRefresh(value => value + 1);
  };
  const toggleVideo = (on: boolean) => attempt(() => {
    const saved = updateMeetingConfig({ video: { enabled: !on } });
    setConfig(saved);
    props.onConfigChange?.(saved);
    return on ? 'Video is off. Calls record audio only.' : 'Video is on. Calls record their window from now on.';
  });

  useInput((input, key) => {
    const { selected, itemCount, rows, inDetail, list, listLength, rowIndex, files, confirm } = latest.current;
    if (setup.busy) {
      if (key.escape) setup.cancel();
      return;
    }
    if (confirm) {
      if (input.toLowerCase() === 'y') { setConfirm(undefined); confirm.run(); }
      else if (input.toLowerCase() === 'n' || key.escape) setConfirm(undefined);
      return;
    }
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
      else if (list === 'recording') { if (key.leftArrow || key.rightArrow || input === ' ') changeRow(key.leftArrow ? -1 : 1); }
      else if (list === 'prompts') {
        const prompt = files.prompts[rowIndex];
        if (!prompt) return;
        if (key.return) attempt(() => {
          ensurePromptsDirectory(props.libraryDir);
          (props.actions?.openFile ?? openTextFile)(prompt.path);
          return `Opened ${prompt.name}.md. Save it and the next meeting uses it.`;
        });
        else if (input === 'd' && prompt.state !== 'default') setConfirm({ text: `Put ${prompt.title} back as shipped? Your changes are lost.`,
          run: () => attempt(() => { resetPrompt(props.libraryDir, prompt.name); return `${prompt.title} is back as shipped.`; }) });
      } else if (list === 'voices') {
        const voice = files.voices[rowIndex];
        if (voice && key.return) setConfirm({ text: `Forget ${voice.name}'s voice? Past transcripts keep the name.`,
          run: () => attempt(() => {
            forgetVoiceprint(voice.name);
            // The list closes when its last person goes.
            if (listLength <= 1) setInDetail(false);
            setRowIndex(value => Math.max(0, Math.min(value, listLength - 2)));
            return `Forgot ${voice.name}'s voice. Seashell no longer suggests that name.`;
          }) });
      }
      return;
    }
    if (input === 'r') { setup.setMessage(undefined); setStatuses(undefined); setRefresh(value => value + 1); return; }
    if (!inDetail || !compact) {
      if (key.upArrow || input === 'k') { setIndex(value => Math.max(0, value - 1)); setup.setMessage(undefined); return; }
      if (key.downArrow || input === 'j') { setIndex(value => Math.min(itemCount - 1, value + 1)); setup.setMessage(undefined); return; }
    }
    if (input === ' ' && selected?.kind === 'status' && selected.status.id === 'video') { toggleVideo(selected.status.state !== 'off'); return; }
    if (!key.return && !(key.rightArrow && !inDetail)) return;
    if (selected?.kind === 'guide') props.onOpenGuide?.();
    else if (compact && !inDetail || list !== undefined && listLength > 0) { setInDetail(true); setRowIndex(0); setup.setMessage(undefined); }
    else if (key.return && selected?.kind === 'status' && selected.status.action) void setup.run(selected.status.action);
    // Only hearing it proves a microphone or the Mac's sound works, and the guide listens.
    else if (key.return && selected && testable(selected)) props.onOpenGuide?.();
  });

  const needs = (statuses ?? []).filter(status => !status.optional && status.state !== 'ok');
  function testable(item: MenuItem): boolean {
    return item.kind === 'status' && !item.status.action && (item.status.id === 'microphone' || item.status.id === 'computer-audio')
      && Boolean(props.onOpenGuide);
  }
  const summaryOf = (item: MenuItem) => item.kind === 'recording' ? recordingSummary(config)
    : item.kind === 'guide' ? 'Test mic and computer audio' : item.status.summary;
  const labelOf = (item: MenuItem) => item.kind === 'recording' ? 'Recording'
    : item.kind === 'guide' ? 'Guided setup' : MENU_LABEL[item.status.id];
  const menuRow = (item: MenuItem, i: number) => {
    // While its rows are being changed, an item keeps its place without a second selection.
    const chosen = index === i && !(inDetail && item === selected && list !== undefined);
    const symbol = item.kind === 'status' ? <><Text color={chosen ? undefined : FEATURE_STATE_COLOR[item.status.state]}>
      {FEATURE_STATE_SYMBOL[item.status.state]}</Text> </> : null;
    const label = labelOf(item);
    if (!compact) return <Text key={item.kind === 'status' ? item.status.id : item.kind} inverse={chosen} bold={index === i && !chosen} wrap="truncate-end">
      {chosen ? '› ' : '  '}{symbol}{label}</Text>;
    // Narrow, each row also says how it stands, the way the meetings list shows dates.
    const room = Math.max(1, props.columns - 2 - 23);
    const summary = summaryOf(item);
    return <Text key={item.kind === 'status' ? item.status.id : item.kind} inverse={chosen} wrap="truncate-end">
      {chosen ? '› ' : '  '}{symbol}{label.padEnd(item.kind === 'status' ? 19 : 21)}
      <Text dimColor={!chosen}>{(summary.length > room ? `${summary.slice(0, room - 1)}…` : summary).padEnd(room)}</Text>
    </Text>;
  };
  const firstOptional = items.findIndex(item => item.kind === 'status' && item.status.optional);
  const menu = <Box flexDirection="column" flexShrink={0} {...(compact ? {} : { width: MENU_WIDTH, paddingRight: 1,
    borderStyle: 'single' as const, borderTop: false, borderBottom: false, borderLeft: false, borderDimColor: true })}>
    {items.flatMap((item, i) => i === firstOptional
      ? [<Text key="optional-heading" dimColor>  Optional</Text>, menuRow(item, i)] : [menuRow(item, i)])}
    {!statuses && <Text dimColor>  {loadError ?? 'Checking what works…'}</Text>}
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
  const problemLines = (problems: readonly { path: string; message: string }[]) => problems.map(problem =>
    <Text key={problem.path} color="red" wrap="truncate-end">✗ {problem.path.split('/').at(-1)}: {problem.message}</Text>);
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
        {'  '}{automation.name.slice(0, 21).padEnd(22)}<Text dimColor>{automation.enabled ? 'On' : 'Off'} · {[...new Set(automation.actions.map(action => action.kind))].join(', ')}</Text>
      </Text>)}
      {problemLines(files.automations.problems)}
      {files.runs.length > 0 && <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Text dimColor>  Last runs</Text>
        {files.runs.map((run, i) => {
          const [symbol, color] = RUN_SYMBOL[run.status];
          const why = run.detail ?? run.actions.find(action => action.status === run.status && action.detail)?.detail;
          return <Text key={`${run.at}-${i}`} wrap="truncate-end"><Text color={color}>{symbol}</Text> {run.automation} · {run.title}
            <Text dimColor> · {meetingWhen(run.at)}{run.status !== 'ok' && why ? ` · ${why}` : ''}</Text></Text>;
        })}
      </Box>}
    </>;
    return null;
  };
  const detail = !selected ? null : selected.kind === 'recording' ? <>
    {heading('Recording', <Text dimColor wrap="truncate-end">Which calls Seashell records, and when it asks first.</Text>)}
    <Box flexDirection="column" flexShrink={1} overflow="hidden" marginTop={1}>
      {rows.map((row, i) => {
        const chosen = inDetail && i === rowIndex;
        const value = chosen ? `‹ ${POLICY_WORDS[row.value]} ›` : POLICY_WORDS[row.value];
        return <React.Fragment key={row.id}>
          {i === 2 && <Text dimColor>  Apps</Text>}
          <Text inverse={chosen} wrap="truncate-end">{chosen ? '› ' : '  '}{row.label.padEnd(compact ? 22 : 24)}
            <Text dimColor={!chosen && row.value === 'default'}>{value}</Text></Text>
        </React.Fragment>;
      })}
    </Box>
    {inDetail && rows[rowIndex] && <Box marginTop={1} flexShrink={0}><Paragraph text={rows[rowIndex]!.help} width={width} dimColor /></Box>}
  </> : selected.kind === 'guide' ? <>
    {heading('Guided setup')}
    <Box marginTop={1} flexShrink={1} overflow="hidden">
      <Paragraph width={width} text="Walks through the background recorder, then listens to your microphone and your Mac's sound so you know both are heard. Then the optional extras. Steps that are already done are skipped." />
    </Box>
  </> : <>
    {heading(`${selected.status.label}${selected.status.optional ? ' · optional' : ''}`,
      <Text color={FEATURE_STATE_COLOR[selected.status.state]} wrap="truncate-end">{FEATURE_STATE_SYMBOL[selected.status.state]} {selected.status.summary}</Text>)}
    <Box flexDirection="column" flexShrink={1} overflow="hidden">
      <Box marginTop={1} flexShrink={0}><Paragraph width={width} text={selected.status.detail} /></Box>
      {selected.status.state !== 'ok' && selected.status.fix && <Box marginTop={1} flexShrink={0}>
        <Paragraph width={width} color={selected.status.state === 'broken' ? 'red' : 'yellow'} text={`Next: ${selected.status.fix}`} /></Box>}
      {!selected.status.action && selected.status.state !== 'ok' && selected.status.command
        ? <Paragraph width={width} text={`Run: ${selected.status.command}`} /> : null}
      {['prompts', 'voices', 'extractors', 'automations'].includes(selected.status.id) &&
        <Box flexDirection="column" marginTop={1} flexShrink={0}>{filesBody(selected.status.id)}</Box>}
    </Box>
  </>;

  const action = selected?.kind === 'status' ? selected.status.action : undefined;
  const videoOn = selected?.kind === 'status' && selected.status.id === 'video' && selected.status.state !== 'off';
  const hints: Hint[] = compact && !inDetail ? [['Enter', 'open'], ['↑↓', 'choose'], ['r', 'recheck'], ['Esc', 'back']]
    : inDetail && list === 'recording' ? [['↑↓', 'choose'], ['←→', 'change'], ['Esc', 'done']]
    : inDetail && list === 'prompts' ? [['Enter', 'edit'], ...(files.prompts[rowIndex]?.state !== 'default' ? [['d', 'put back as shipped'] as Hint] : []),
      ['↑↓', 'choose'], ['Esc', 'done']]
    : inDetail && list === 'voices' && listLength ? [['Enter', 'forget'], ['↑↓', 'choose'], ['Esc', 'done']]
    : [
      ...(selected?.kind === 'recording' ? [['Enter', 'change'] as Hint] : selected?.kind === 'guide' ? [['Enter', 'start'] as Hint]
        : list === 'prompts' ? [['Enter', 'choose a prompt'] as Hint] : list === 'voices' && listLength ? [['Enter', 'choose someone'] as Hint]
        : action ? [['Enter', lowerFirst(FEATURE_ACTION_LABEL[action])] as Hint] : selected && testable(selected) ? [['Enter', 'test it now'] as Hint] : []),
      ...(videoOn ? [['space', 'turn video off'] as Hint] : []),
      ...(compact ? [] : [['↑↓', 'choose'] as Hint]), ['r', 'recheck'], ['Esc', 'back'],
    ];
  const titleDetail = statuses ? <Text color={needs.length ? 'yellow' : 'green'}>
    {`  ${needs.length ? `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you`
      : compact ? 'Everything works' : 'Everything needed to record meetings works'}`}
  </Text> : undefined;

  return <Box flexDirection="column" paddingX={1} {...(props.rows ? { height: props.rows } : {})} overflow="hidden">
    <ScreenTitle name="Settings" detail={titleDetail} />
    <Box flexDirection="row" flexGrow={1} overflow="hidden">
      {(!compact || !inDetail) && menu}
      {(!compact || inDetail) && <Box flexDirection="column" flexGrow={1} minWidth={0} overflow="hidden" {...(compact ? {} : { paddingLeft: 1 })}>
        {detail}
        {setup.message && <Box marginTop={1} flexShrink={0}><Paragraph width={width} color="yellow" text={setup.message} /></Box>}
      </Box>}
    </Box>
    {setup.busy ? <Text color="yellow">Working… Esc cancels</Text>
      : confirm ? <Text color="yellow" wrap="truncate-end">{confirm.text}  y yes  n no</Text>
      : <KeyBar hints={hints} columns={props.columns - 2} help={false} />}
  </Box>;
}
