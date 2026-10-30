import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { KeyBar } from './tui-chrome.tsx';
import { diarizationEnvironment, diarizationStatus } from './diarization-environment.ts';
import { setupDiarization, type SpeakerSetupResult } from './diarization-setup.ts';
import { checkMeetConnection, requestMeetAccessibilityPermission, type MeetBrowserMode, type MeetProbe } from './meet-speakers.ts';

function meetStatusMessage(status: MeetProbe): string {
  if (status.state !== 'permission') return status.detail;
  return status.detail.startsWith('Background meetings:')
    ? 'Background access missing. Allow the background host shown in System Settings → Privacy & Security → Accessibility. Terminal access alone is not enough. Then Check.'
    : 'This window needs access. Allow its helper/app in System Settings → Privacy & Security → Accessibility. Then Check.';
}

export default function SpeakerSettings(props: {
  recording: boolean;
  browser: MeetBrowserMode | 'off';
  meetStatus?: MeetProbe;
  onBrowser: (browser: MeetBrowserMode | 'off') => void;
  canIdentify: boolean;
  onIdentify: () => void;
  onClose: () => void;
  columns: number;
  rows?: number;
  modelSize?: string;
}) {
  const [ready, setReady] = useState(() => diarizationStatus().ready);
  const [engine] = useState(() => diarizationStatus().engine);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [result, setResult] = useState<SpeakerSetupResult>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const meetOn = props.browser !== 'off';
  type Action = 'meet' | 'meet-off' | 'voices' | 'redo';
  const entries: Array<[Action, string, string]> = [
    ['meet', 'Names from Google Meet', meetOn ? 'On · Enter checks it' : 'Off · Enter connects it'],
    ...(meetOn ? [['meet-off', 'Turn off names from Meet', ''] as [Action, string, string]] : []),
    ['voices', 'Tell voices apart', ready ? 'Ready · Enter checks it' : `Not set up · Enter downloads ${props.modelSize ?? '21 MB'}`],
    ...(props.canIdentify && ready ? [['redo', 'Redo speakers for this meeting', 'Makes a copy to review'] as [Action, string, string]] : []),
  ];
  const action = entries[Math.min(index, entries.length - 1)]![0];
  const checkMeet = async (browser: MeetBrowserMode, connect = false) => {
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setResult(undefined);
    setMessage(connect ? 'Opening Accessibility setup…' : 'Checking Meet connection…');
    try {
      const status = connect
        ? await requestMeetAccessibilityPermission(controller.signal)
        : await checkMeetConnection(browser, controller.signal);
      if (!controller.signal.aborted) setMessage(meetStatusMessage(status));
    } catch (cause) {
      if (!controller.signal.aborted) setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const setup = async (check: boolean) => {
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setResult(undefined); setMessage(undefined);
    try {
      const next = await setupDiarization({ check, login: false, signal: controller.signal,
        onStatus: (text) => { if (!controller.signal.aborted) setMessage(text); } });
      if (!controller.signal.aborted) { setResult(next); setReady(next.ready); setMessage(next.detail); }
    } catch (cause) {
      if (!controller.signal.aborted) { setReady(diarizationStatus().ready); setMessage(cause instanceof Error ? cause.message : String(cause)); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  useInput((input, key) => {
    if (key.escape) { request.current?.abort(); props.onClose(); return; }
    if (busy) return;
    if (key.upArrow) setIndex((value) => Math.max(0, value - 1));
    else if (key.downArrow) setIndex((value) => Math.min(entries.length - 1, value + 1));
    else if (key.return) {
      if (action === 'meet') {
        if (meetOn) void checkMeet(props.browser as MeetBrowserMode);
        else { props.onBrowser('auto'); void checkMeet('auto', true); }
        return;
      }
      if (action === 'meet-off') { props.onBrowser('off'); setIndex(0); setMessage('Names from Meet are off. Recording continues.'); return; }
      if (props.recording) { setMessage('Wait for the recording to finish, then come back here.'); return; }
      if (action === 'redo') { props.onIdentify(); return; }
      void setup(ready);
    }
  });
  const selected = entries[Math.min(index, entries.length - 1)]!;
  return <Box flexDirection="column" paddingX={1} {...(props.rows ? { height: props.rows } : {})} overflow="hidden">
    <Text wrap="truncate-end">🐚 <Text bold color="cyan">Sea Shell</Text>  <Text bold>Speaker names</Text></Text>
    <Text dimColor wrap="truncate-end">{'─'.repeat(Math.max(1, props.columns - 2))}</Text>
    {entries.map(([id, label, value], i) => <Text key={id} inverse={i === index} wrap="truncate-end">
      {i === index ? '› ' : '  '}{label.padEnd(32)}{value}
    </Text>)}
    <Box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
      {(selected[0] === 'meet' || selected[0] === 'meet-off') && <>
        <Text>Reads who is talking from Google Meet in Chrome, using Accessibility. Names are hints.</Text>
        <Text dimColor>Keep Meet's People panel open if you are unmuted, and avoid other audio playing.</Text>
        {!message && props.meetStatus && meetOn && <Text>{meetStatusMessage(props.meetStatus)}</Text>}
      </>}
      {selected[0] === 'voices' && (ready ? <>
        <Text>Numbers are not names. In a meeting's transcript, press r to name them.</Text>
        <Text dimColor>Shared microphones and people talking over each other need review.</Text>
      </> : engine === 'pyannote' ? <>
        <Text>Downloads a model; needs Hugging Face access and publisher contact sharing.</Text>
        <Text color="cyan">{diarizationEnvironment().model.startsWith('/') ? diarizationEnvironment().model : `https://huggingface.co/${diarizationEnvironment().model}`}</Text>
        <Text color="yellow">seashell setup --speakers --login</Text>
      </> : <Text>Downloads a voice model once. It runs on this Mac; no account needed.</Text>)}
      {selected[0] === 'redo' && <Text>Separates voices again and saves a copy. This meeting and its notes stay as they are.</Text>}
      {message && <Text color={result?.ready ? 'green' : 'yellow'}>{message}</Text>}
    </Box>
    {busy ? <Text color="yellow">Working… Esc cancels</Text>
      : <KeyBar hints={[['↑↓', 'choose'], ['Enter', 'select'], ['Esc', 'back']]} columns={props.columns - 2} help={false} />}
  </Box>;
}
