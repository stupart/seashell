import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { diarizationEnvironment, diarizationStatus } from './diarization-environment.ts';
import { setupDiarization, type SpeakerSetupResult } from './diarization-setup.ts';
import { probeMeetSpeakers, meetPermissionHelp, type MeetBrowser, type MeetProbe } from './meet-speakers.ts';

export default function SpeakerSettings(props: {
  recording: boolean;
  browser: MeetBrowser | 'off';
  meetStatus?: MeetProbe;
  onBrowser: (browser: MeetBrowser | 'off') => void;
  canIdentify: boolean;
  onIdentify: () => void;
  onClose: () => void;
}) {
  const [ready, setReady] = useState(() => diarizationStatus().ready);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [result, setResult] = useState<SpeakerSetupResult>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const entries = ['Connect Google Meet · Chrome', 'Connect Google Meet · Safari', 'Check Meet connection', 'Turn off Meet reader',
    'Set up / repair local voice model', 'Check offline model readiness', 'Identify saved recording · review copy', 'Done'];
  const checkMeet = async (browser: MeetBrowser) => {
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setResult(undefined);
    try {
      const status = await probeMeetSpeakers(browser, controller.signal);
      if (!controller.signal.aborted) setMessage(status.detail);
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
      if (index === 7) { props.onClose(); return; }
      if (index < 2) {
        const browser = index === 0 ? 'chrome' : 'safari';
        props.onBrowser(browser); void checkMeet(browser); return;
      }
      if (index === 2) {
        if (props.browser === 'off') { setMessage('Choose your Meet browser first.'); return; }
        void checkMeet(props.browser); return;
      }
      if (index === 3) { props.onBrowser('off'); setMessage('Meet reader off. Audio recording continues.'); return; }
      if (props.recording) { setMessage('Pause recording and return here to set up or process speakers.'); return; }
      if (index === 6) {
        if (!ready) { setMessage('Set up the local model first.'); return; }
        if (!props.canIdentify) { setMessage('Open a saved recording from History first.'); return; }
        props.onIdentify(); return;
      }
      void setup(index === 5);
    }
  });
  return <Box flexDirection="column" paddingX={1}>
    <Text bold>Speakers</Text>
    <Text>Meet · {props.browser} | Local voices · {ready ? 'Ready' : 'Optional setup'}</Text>
    <Box flexDirection="column" marginY={1}>
      {entries.map((entry, i) => <Text key={entry} color={i === index ? 'cyan' : undefined}>{i === index ? '❯' : ' '} {entry}</Text>)}
    </Box>
    {index < 4 && <>
      <Text dimColor>Reads visible Meet tiles locally. No model needed.</Text>
      <Text dimColor>Names are timing hints; avoid other audio playback.</Text>
      {!message && props.browser !== 'off' && <Text>{props.meetStatus?.detail ?? meetPermissionHelp(props.browser)}</Text>}
    </>}
    {index >= 4 && index < 7 && ready && <>
      <Text>Numbers are not names. Use [ / ] then R to rename.</Text>
      <Text dimColor>Shared microphones and overlap need review.</Text>
    </>}
    {index >= 4 && index < 7 && !ready && <>
      <Text>Downloads a model; requires Hugging Face access and publisher contact sharing.</Text>
      <Text color="cyan">{diarizationEnvironment().model.startsWith('/') ? diarizationEnvironment().model : `https://huggingface.co/${diarizationEnvironment().model}`}</Text>
      <Text color="yellow">seashell setup --speakers --login</Text>
    </>}
    {message && <Text color={result?.ready ? 'green' : 'yellow'}>{message}</Text>}
    {props.recording && <Text dimColor>Recording continues. Voice model setup requires pausing.</Text>}
    <Text dimColor>{busy ? 'Working… Esc cancels setup' : '↑↓ choose · Enter select · Esc close'}</Text>
  </Box>;
}
