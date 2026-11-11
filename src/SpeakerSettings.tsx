import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { KeyBar, Paragraph, Prompt, ScreenTitle, Toast } from './tui-chrome.tsx';
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
  /** Whether Settings says speaker separation is ready, so both screens say the same. */
  ready?: boolean;
}) {
  const [ready, setReady] = useState(() => props.ready ?? diarizationStatus().ready);
  useEffect(() => { if (props.ready !== undefined) setReady(props.ready); }, [props.ready]);
  const [engine] = useState(() => diarizationStatus().engine);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [result, setResult] = useState<SpeakerSetupResult>();
  /** What just worked, green in the key bar until the next key. */
  const [toast, setToast] = useState<string>();
  /** Turned on but macOS has not allowed Accessibility yet: checked again until it does. */
  const [waiting, setWaiting] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const meetOn = props.browser !== 'off';
  type Action = 'meet' | 'voices' | 'redo';
  // One row per feature, named as Settings names it. The row says how it stands; the key bar says what Enter does to it.
  const entries: Array<[Action, string, string, string]> = [
    ['meet', 'Google Meet names', meetOn ? 'On' : 'Off', meetOn ? 'turn off' : 'turn on'],
    ['voices', 'Who said what', ready ? 'Ready' : `Not set up · ${props.modelSize ?? '21 MB'}`, ready ? 'check' : 'download'],
    ...(props.canIdentify && ready ? [['redo', 'Redo speakers for this meeting', 'Keeps the old version', 'redo'] as [Action, string, string, string]] : []),
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
      if (!controller.signal.aborted) { setMessage(meetStatusMessage(status)); setWaiting(status.state === 'permission'); }
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
      if (!controller.signal.aborted) {
        setResult(next); setReady(next.ready);
        if (next.ready) { setMessage(undefined); setToast(next.detail); } else setMessage(next.detail);
      }
    } catch (cause) {
      if (!controller.signal.aborted) { setReady(diarizationStatus().ready); setMessage(cause instanceof Error ? cause.message : String(cause)); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  // While macOS asks, the row checks by itself, so Enter only ever switches it.
  useEffect(() => {
    if (!meetOn || !waiting || busy) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void checkMeetConnection(props.browser as MeetBrowserMode, controller.signal).then((status) => {
        if (controller.signal.aborted) return;
        setMessage(meetStatusMessage(status)); setWaiting(status.state === 'permission');
      }).catch(() => {});
    }, 1_500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [meetOn, waiting, busy, props.browser]);
  useInput((input, key) => {
    if (key.escape) { request.current?.abort(); props.onClose(); return; }
    if (busy) return;
    setToast(undefined);
    if (key.upArrow) setIndex((value) => Math.max(0, value - 1));
    else if (key.downArrow) setIndex((value) => Math.min(entries.length - 1, value + 1));
    else if (key.return) {
      // Enter switches Google Meet names: on connects and checks them, off stops reading Meet.
      if (action === 'meet') {
        if (meetOn) { props.onBrowser('off'); setResult(undefined); setMessage(undefined); setWaiting(false); setToast('Google Meet names off. Recording continues.'); }
        else { props.onBrowser('auto'); void checkMeet('auto', true); }
        return;
      }
      if (props.recording) { setMessage('Wait for the recording to finish, then come back here.'); return; }
      if (action === 'redo') { props.onIdentify(); return; }
      void setup(ready);
    }
  });
  const selected = entries[Math.min(index, entries.length - 1)]!;
  const labelWidth = Math.max(...entries.map(([, label]) => label.length)) + 2;
  const width = props.columns - 2;
  return <Box flexDirection="column" paddingX={1} {...(props.rows ? { height: props.rows } : {})} overflow="hidden">
    <ScreenTitle name="Speaker setup" />
    {entries.map(([id, label, value], i) => <Text key={id} inverse={i === index} wrap="truncate-end">
      {i === index ? '› ' : '  '}{label.padEnd(labelWidth)}<Text dimColor={i !== index}>{value}</Text>
    </Text>)}
    <Box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
      {selected[0] === 'meet' && <>
        <Paragraph width={width} text="Reads who is talking from Google Meet in Chrome, using Accessibility. Names are hints." />
        <Paragraph width={width} dimColor text="Keep Meet's People panel open if you are unmuted, and avoid other audio playing." />
        {!message && props.meetStatus && meetOn && <Paragraph width={width} text={meetStatusMessage(props.meetStatus)} />}
      </>}
      {selected[0] === 'voices' && (ready ? <>
        <Paragraph width={width} text="Numbers are not names. In a meeting's transcript, press r to name them." />
        <Paragraph width={width} dimColor text="Shared microphones and people talking over each other need review." />
      </> : engine === 'pyannote' ? <>
        <Paragraph width={width} text="Downloads a model; needs Hugging Face access and publisher contact sharing." />
        <Text color="cyan">{diarizationEnvironment().model.startsWith('/') ? diarizationEnvironment().model : `https://huggingface.co/${diarizationEnvironment().model}`}</Text>
        <Text color="yellow">seashell setup --speakers --login</Text>
      </> : <Paragraph width={width} text="Downloads a voice model once. It runs on this Mac; no account needed." />)}
      {selected[0] === 'redo' && <Paragraph width={width} text="Separates voices again and saves a copy. This meeting and its notes stay as they are." />}
      {message && <Paragraph width={width} color="yellow" text={message} />}
    </Box>
    {busy ? <Prompt text="◐ Working…" dimColor hints={[['Esc', 'cancel']]} columns={props.columns - 2} />
      : toast ? <Toast text={toast} columns={props.columns - 2} />
      : <KeyBar hints={[['Enter', selected[3]], ['↑↓', 'choose'], ['Esc', 'back']]} columns={props.columns - 2} help={false} />}
  </Box>;
}
