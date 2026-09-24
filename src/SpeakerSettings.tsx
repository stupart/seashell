import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { diarizationEnvironment, diarizationStatus } from './diarization-environment.ts';
import { setupDiarization, type SpeakerSetupResult } from './diarization-setup.ts';

export default function SpeakerSettings(props: {
  recording: boolean;
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
  const entries = ['Set up / repair local model', 'Check offline readiness', 'Identify saved recording · review copy', 'Done'];
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
      if (index === 3) { props.onClose(); return; }
      if (props.recording) { setMessage('Pause recording and return here to set up or process speakers.'); return; }
      if (index === 2) {
        if (!ready) { setMessage('Set up the local model first.'); return; }
        if (!props.canIdentify) { setMessage('Open a saved recording from History first.'); return; }
        props.onIdentify(); return;
      }
      void setup(index === 1);
    }
  });
  return <Box flexDirection="column" paddingX={1}>
    <Text bold>Speakers · {ready ? 'Ready' : 'Setup required'}</Text>
    <Text>Separate remote voices after recording.</Text>
    <Text dimColor>Live labels still describe audio sources.</Text>
    {ready && <>
      <Text>Numbers are not names. Use [ / ] then R to rename.</Text>
      <Text dimColor>Shared microphones and overlap need review.</Text>
    </>}
    {!ready && <>
      <Text>Downloads a local model. No audio is uploaded.</Text>
      <Text>Requires a Hugging Face account and agreement to share contact details with the model publisher.</Text>
      <Text color="cyan">{diarizationEnvironment().model.startsWith('/') ? diarizationEnvironment().model : `https://huggingface.co/${diarizationEnvironment().model}`}</Text>
      <Text>Accept access, then in another terminal:</Text>
      <Text color="yellow">seashell setup --speakers --login</Text>
      <Text dimColor>Optional. Recording works without setup.</Text>
    </>}
    <Box flexDirection="column" marginY={1}>
      {entries.map((entry, i) => <Text key={entry} color={i === index ? 'cyan' : undefined}>{i === index ? '❯' : ' '} {entry}</Text>)}
    </Box>
    {message && <Text color={result?.ready ? 'green' : 'yellow'}>{message}</Text>}
    {props.recording && <Text color="yellow">Recording continues. Close this panel to pause before setup.</Text>}
    <Text dimColor>{busy ? 'Working… Esc cancels setup' : '↑↓ choose · Enter select · Esc close'}</Text>
  </Box>;
}
