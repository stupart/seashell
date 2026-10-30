import React, { useEffect, useRef, useState } from 'react';
import { spawnSync } from 'child_process';
import { Box, Text, useInput } from 'ink';
import type { SeashellConfig } from './config.ts';
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
import { enableMeetingLaunchAtLogin } from './launch-at-login.ts';
import { requestMeetAccessibilityPermission } from './meet-speakers.ts';
import { microphonePermission } from './microphone-permission.ts';
import { calendarPermission } from './calendar-permission.ts';
import { join } from 'path';
import { ensureTemplatesDirectory, PROFILE_FILE } from './meeting-templates.ts';
import { KeyBar, ScreenTitle, type Hint } from './tui-chrome.tsx';

const MENU_LABEL: Record<FeatureId, string> = {
  recorder: 'Recorder',
  detection: 'Meeting detection',
  microphone: 'Microphone',
  'computer-audio': 'Computer audio',
  transcription: 'Transcription',
  'meet-names': 'Meet names',
  'speaker-separation': 'Who said what',
  'ai-notes': 'AI notes',
  'notes-templates': 'Templates',
  calendar: 'Calendar titles',
};

export interface SettingsActions {
  enableRecorder?: () => void;
  connectMeet?: (signal: AbortSignal) => Promise<{ detail: string }>;
  allowMicrophone?: (signal: AbortSignal) => Promise<{ authorization: string; detail: string }>;
  allowCalendar?: (signal: AbortSignal) => Promise<{ authorization: string; detail: string }>;
  openTemplates?: (directory: string) => void;
}

/** Everything Seashell can do, whether it works right now, and one key to fix it. */
export default function SettingsScreen(props: {
  config: SeashellConfig;
  libraryDir: string;
  columns: number;
  rows?: number;
  /** Connecting Meet enables the reader before asking macOS for access. */
  onConnectMeet: () => void;
  /** Turning on titles saves the setting once macOS allows Calendar access. */
  onEnableCalendar: () => void;
  onOpenSpeakers: () => void;
  onOpenAI: () => void;
  onClose: () => void;
  dependencies?: FeatureStatusDependencies;
  actions?: SettingsActions;
}) {
  const [statuses, setStatuses] = useState<FeatureStatus[]>();
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    void readFeatureStatuses({ config: props.config, libraryDir: props.libraryDir, signal: controller.signal,
      ...(props.dependencies ? { dependencies: props.dependencies } : {}) })
      .then(next => { if (!controller.signal.aborted) setStatuses(next); })
      .catch(cause => { if (!controller.signal.aborted) setMessage(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [refresh, props.config]);
  useEffect(() => () => request.current?.abort(), []);

  // Open on what needs the person; when nothing does, on the first row.
  const opened = useRef(false);
  useEffect(() => {
    if (!statuses || opened.current) return;
    opened.current = true;
    setIndex(Math.max(0, statuses.findIndex(status => !status.optional && status.state !== 'ok')));
  }, [statuses]);
  const selected = statuses?.[index];
  const itemCount = statuses?.length ?? 0;
  // Ink paints a frame before it swaps in the new input handler; read the latest state.
  const latest = useRef({ statuses, index, selected, itemCount });
  latest.current = { statuses, index, selected, itemCount };

  const run = async (action: FeatureAction) => {
    if (action === 'open-speakers') { props.onOpenSpeakers(); return; }
    if (action === 'open-ai') { props.onOpenAI(); return; }
    if (action === 'open-templates') {
      try {
        const directory = ensureTemplatesDirectory(props.libraryDir);
        (props.actions?.openTemplates ?? ((folder: string) => {
          spawnSync('/usr/bin/open', [folder], { stdio: 'ignore', timeout: 5_000 });
          spawnSync('/usr/bin/open', ['-t', join(folder, PROFILE_FILE)], { stdio: 'ignore', timeout: 5_000 });
        }))(directory);
        setMessage(`Opened ${directory}. Edit "About me", then any template; each ## heading is a section.`);
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : String(cause));
      }
      setRefresh(value => value + 1);
      return;
    }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setMessage(undefined);
    try {
      if (action === 'enable-recorder') {
        setMessage('Starting the background recorder…');
        (props.actions?.enableRecorder ?? (() => { enableMeetingLaunchAtLogin(); }))();
        setMessage('Background recorder started. It also starts when you log in.');
      } else if (action === 'connect-meet') {
        props.onConnectMeet();
        setMessage('Opening Accessibility setup… allow the Seashell entries macOS shows.');
        const result = await (props.actions?.connectMeet ?? (signal => requestMeetAccessibilityPermission(signal)))(controller.signal);
        if (!controller.signal.aborted) setMessage(result.detail);
      } else if (action === 'allow-microphone') {
        setMessage('macOS will ask about "Seashell Microphone". Choose Allow.');
        const result = await (props.actions?.allowMicrophone ?? (signal => microphonePermission({ request: true, signal })))(controller.signal);
        if (controller.signal.aborted) return;
        if (result.authorization === 'denied' && !props.actions?.allowMicrophone) {
          spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'], { stdio: 'ignore', timeout: 5_000 });
        }
        setMessage(result.authorization === 'authorized' ? 'Microphone allowed. Your side of meetings is now recorded.' : result.detail);
      } else if (action === 'allow-calendar') {
        setMessage('macOS will ask about "Seashell Calendar". Choose Allow (Full Access).');
        const result = await (props.actions?.allowCalendar ?? (signal => calendarPermission({ request: true, signal })))(controller.signal);
        if (controller.signal.aborted) return;
        if (result.authorization === 'authorized') {
          props.onEnableCalendar();
          setMessage('Calendar titles are on. Meetings with a calendar event get its name and attendees.');
        } else {
          if ((result.authorization === 'denied' || result.authorization === 'writeOnly') && !props.actions?.allowCalendar) {
            spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'], { stdio: 'ignore', timeout: 5_000 });
          }
          setMessage(result.detail);
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) { setBusy(false); setRefresh(value => value + 1); }
    }
  };

  useInput((input, key) => {
    if (key.escape || (input === ',' && !busy)) { request.current?.abort(); props.onClose(); return; }
    if (busy) return;
    const { selected, itemCount } = latest.current;
    if (key.upArrow || input === 'k') { setIndex(value => Math.max(0, value - 1)); setMessage(undefined); }
    else if (key.downArrow || input === 'j') { setIndex(value => Math.min(itemCount - 1, value + 1)); setMessage(undefined); }
    else if (input === 'r') { setMessage(undefined); setStatuses(undefined); setRefresh(value => value + 1); }
    else if (key.return && selected?.action) void run(selected.action);
  });

  const compact = props.columns < 72;
  const needs = (statuses ?? []).filter(status => !status.optional && status.state !== 'ok');
  const menuRow = (status: FeatureStatus, i: number) => <Text key={status.id} inverse={index === i} wrap="truncate-end">
    {index === i ? '› ' : '  '}<Text color={index === i ? undefined : FEATURE_STATE_COLOR[status.state]}>{FEATURE_STATE_SYMBOL[status.state]}</Text> {MENU_LABEL[status.id]}
  </Text>;
  const firstOptional = (statuses ?? []).findIndex(status => status.optional);
  const menu = <Box flexDirection="column" width={compact ? undefined : 26} flexShrink={0} paddingRight={1}
    {...(compact ? {} : { borderStyle: 'single' as const, borderTop: false, borderBottom: false, borderLeft: false, borderDimColor: true })}>
    {(statuses ?? []).flatMap((status, i) => i === firstOptional
      ? [<Text key="optional-heading" dimColor>  Optional</Text>, menuRow(status, i)] : [menuRow(status, i)])}
  </Box>;

  const content = !statuses ? <Text dimColor>Checking what works…</Text> : selected ? <>
    <Text bold>{selected.label}{selected.optional ? ' · optional' : ''}</Text>
    <Text color={FEATURE_STATE_COLOR[selected.state]}>{FEATURE_STATE_SYMBOL[selected.state]} {selected.summary}</Text>
    <Box marginTop={1}><Text>{selected.detail}</Text></Box>
    {selected.state !== 'ok' && selected.fix && <Box marginTop={1}><Text color="yellow">Next: {selected.fix}</Text></Box>}
    {!selected.action && selected.state !== 'ok' && selected.command ? <Text>Run: {selected.command}</Text> : null}
  </> : null;
  const hints: Hint[] = [
    ...(selected?.action ? [['Enter', FEATURE_ACTION_LABEL[selected.action].toLowerCase()] as Hint] : []),
    ['↑↓', 'choose'], ['r', 'recheck'], ['Esc', 'back'],
  ];

  return <Box flexDirection="column" paddingX={1} {...(props.rows ? { height: props.rows } : {})} overflow="hidden">
    <ScreenTitle name="Settings" detail={statuses ? <Text color={needs.length ? 'yellow' : 'green'}>
      {`  ${needs.length ? `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you` : 'Everything needed to record meetings works'}`}
    </Text> : undefined} />
    <Box flexDirection={compact ? 'column' : 'row'} flexGrow={1} overflow="hidden">
      {menu}
      <Box flexDirection="column" flexGrow={1} minWidth={0} {...(compact ? { marginTop: 1 } : { paddingLeft: 1 })}>
        {content}
        {message && <Box marginTop={1}><Text color="yellow">{message}</Text></Box>}
      </Box>
    </Box>
    {busy ? <Text color="yellow">Working… Esc cancels</Text> : <KeyBar hints={hints} columns={props.columns - 2} help={false} />}
  </Box>;
}
