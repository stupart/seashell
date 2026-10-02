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

const MENU_LABEL: Record<FeatureId, string> = {
  recorder: 'Recorder',
  detection: 'Meeting detection',
  microphone: 'Microphone',
  'computer-audio': 'Computer audio',
  transcription: 'Transcription',
  'meet-names': 'Meet names',
  'speaker-separation': 'Who said what',
  'ai-notes': 'AI notes',
  calendar: 'Calendar titles',
};

export interface SettingsActions {
  enableRecorder?: () => void;
  connectMeet?: (signal: AbortSignal) => Promise<{ detail: string }>;
  allowMicrophone?: (signal: AbortSignal) => Promise<{ authorization: string; detail: string }>;
  allowCalendar?: (signal: AbortSignal) => Promise<{ authorization: string; detail: string }>;
}

/** Everything Seashell can do, whether it works right now, and one key to fix it. */
export default function SettingsScreen(props: {
  config: SeashellConfig;
  libraryDir: string;
  columns: number;
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

  const selected = index > 0 ? statuses?.[index - 1] : undefined;
  const itemCount = 1 + (statuses?.length ?? 0);
  // Ink paints a frame before it swaps in the new input handler; read the latest state.
  const latest = useRef({ statuses, index, selected, itemCount });
  latest.current = { statuses, index, selected, itemCount };

  const run = async (action: FeatureAction) => {
    if (action === 'open-speakers') { props.onOpenSpeakers(); return; }
    if (action === 'open-ai') { props.onOpenAI(); return; }
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
    const { statuses, index, selected, itemCount } = latest.current;
    if (key.upArrow || input === 'k') { setIndex(value => Math.max(0, value - 1)); setMessage(undefined); }
    else if (key.downArrow || input === 'j') { setIndex(value => Math.min(itemCount - 1, value + 1)); setMessage(undefined); }
    else if (input === 'r') { setMessage(undefined); setStatuses(undefined); setRefresh(value => value + 1); }
    else if (key.return && selected?.action) void run(selected.action);
    else if (key.return && index === 0 && statuses) {
      // From the overview, Enter jumps to the first thing that needs you.
      const next = statuses.findIndex(status => !status.optional && status.state !== 'ok');
      if (next >= 0) setIndex(next + 1);
    }
  });

  const compact = props.columns < 72;
  const menuWidth = compact ? 19 : 24;
  const required = statuses?.filter(status => !status.optional) ?? [];
  const needs = required.filter(status => status.state !== 'ok');
  const labelWidth = Math.max(0, ...(statuses ?? []).map(status => status.label.length));
  const row = (status: FeatureStatus) => <Box key={status.id}>
    <Text color={FEATURE_STATE_COLOR[status.state]}>{FEATURE_STATE_SYMBOL[status.state]} </Text>
    <Text>{compact ? MENU_LABEL[status.id].padEnd(17) : status.label.padEnd(labelWidth)}  </Text>
    <Text dimColor={status.state === 'off'}>{status.summary}</Text>
  </Box>;

  const menu = <Box flexDirection="column" width={menuWidth} flexShrink={0}>
    <Text color={index === 0 ? 'cyan' : undefined}>{index === 0 ? '❯' : ' '} Overview</Text>
    {(statuses ?? []).map((status, i) => <Box key={status.id}>
      <Text color={index === i + 1 ? 'cyan' : undefined}>{index === i + 1 ? '❯' : ' '} </Text>
      <Text color={FEATURE_STATE_COLOR[status.state]}>{FEATURE_STATE_SYMBOL[status.state]} </Text>
      <Text color={index === i + 1 ? 'cyan' : undefined} wrap="truncate-end">{MENU_LABEL[status.id]}</Text>
    </Box>).flatMap((item, i) => statuses![i]!.optional && !statuses![i - 1]?.optional
      ? [<Text key="optional-heading" dimColor>  Optional</Text>, item] : [item])}
  </Box>;

  const content = !statuses ? <Text dimColor>Checking what works…</Text>
    : !selected ? <>
      <Text bold>Overview</Text>
      <Text color={needs.length ? 'yellow' : 'green'}>
        {needs.length ? `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you: ${needs.map(status => status.label).join(', ')}.`
          : 'Everything needed to record meetings works.'}
      </Text>
      <Box flexDirection="column" marginTop={1}>{required.map(row)}</Box>
      <Text dimColor> </Text>
      <Text dimColor>Optional</Text>
      <Box flexDirection="column">{statuses.filter(status => status.optional).map(row)}</Box>
      <Text dimColor> </Text>
      <Text dimColor>{needs.length ? 'Enter goes to the first item that needs you.' : 'Choose an item for details.'} Terminal: seashell status</Text>
    </> : <>
      <Text bold>{selected.label}{selected.optional ? ' · optional' : ''}{compact ? <Text dimColor>  {index}/{itemCount - 1}</Text> : null}</Text>
      <Text color={FEATURE_STATE_COLOR[selected.state]}>{FEATURE_STATE_SYMBOL[selected.state]} {selected.summary}</Text>
      <Box marginTop={1}><Text>{selected.detail}</Text></Box>
      {selected.state !== 'ok' && selected.fix && <Box marginTop={1}><Text color="yellow">Next: {selected.fix}</Text></Box>}
      {selected.action
        ? <Text color="cyan">[Enter] {FEATURE_ACTION_LABEL[selected.action]}</Text>
        : selected.state !== 'ok' && selected.command ? <Text color="cyan">Run: {selected.command}</Text> : null}
    </>;

  return <Box flexDirection="column" paddingX={1}>
    <Text bold>Settings</Text>
    <Box flexDirection="row" marginTop={1}>
      {/* Narrow terminals give the whole width to the page; ↑↓ still moves between items. */}
      {!compact && menu}
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray" paddingX={1}>
        {content}
        {message && <Box marginTop={1}><Text color="yellow">{message}</Text></Box>}
      </Box>
    </Box>
    <Text dimColor>{busy ? 'Working… Esc cancels' : '↑↓ choose · Enter fix · R recheck · Esc close'}</Text>
  </Box>;
}
