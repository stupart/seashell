import React from 'react';
import { Box, Text } from 'ink';
import type { CaptureHealthSnapshot, CaptureSourceHealth } from './capture-health.ts';

export type RecordingMode = 'watching' | 'awaiting-consent' | 'starting' | 'recording' | 'no-audio' | 'paused' | 'processing' | 'ready' | 'unavailable';
export interface RecordingStatusProps {
  mode: RecordingMode;
  title?: string;
  health?: CaptureHealthSnapshot;
  elapsedSeconds?: number;
  savedThroughSeconds?: number;
  draftLabel?: string;
  warning?: string;
  nowUnixMs?: number;
  approvalPending?: boolean;
}

export function recordingClock(seconds = 0): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
/** Use observed capture state, never the user's record intent, for this heading. */
export function captureRecordingMode(health?: CaptureHealthSnapshot): 'starting' | 'recording' | 'no-audio' {
  if (!health) return 'starting';
  const enabled = [health.microphone, health.systemAudio].filter(source => source.state !== 'disabled');
  if (enabled.some(source => (source.state === 'receiving' || source.state === 'quiet') && source.lastPcmAtUnixMs !== undefined)) return 'recording';
  if (enabled.every(source => source.state === 'unavailable' || source.state === 'stopped')) return 'no-audio';
  return 'starting';
}

function stalePcm(source: CaptureSourceHealth, now: number): boolean {
  return now - (source.lastPcmAtUnixMs ?? source.updatedAtUnixMs) > 8000;
}

function sourceLabel(source: CaptureSourceHealth | undefined, finished: boolean, now: number): string {
  if (!source) return 'status unconfirmed';
  if (source.state === 'disabled') return 'off';
  if (finished) {
    if (source.warnings.some(w => w.kind === 'unavailable' || w.kind === 'no-audio')) return 'interrupted — review recording';
    if (source.lastSignalAtUnixMs === undefined) return 'no sound confirmed';
    if (source.warnings.some(w => w.resolvedAtUnixMs === undefined && w.kind === 'reconnecting')) return 'interrupted — review recording';
    if (source.warnings.some(w => w.resolvedAtUnixMs === undefined && w.kind === 'quiet')) return 'sound captured · quiet at end';
    return 'sound captured';
  }
  if (source.state === 'unavailable' || source.state === 'stopped') return 'NOT CAPTURING';
  if (source.state === 'reconnecting') return 'reconnecting…';
  if (source.state === 'starting') return 'opening…';
  if (stalePcm(source, now)) return 'signal not updating';
  if (source.lastPcmAtUnixMs === undefined) return 'waiting for audio';
  if (source.state === 'quiet') return 'quiet — check if speaking';
  return source.lastSignalAtUnixMs === undefined ? 'waiting for sound' : 'sound detected';
}
export function recordingNeedsAttention(health?: CaptureHealthSnapshot, finished = false, nowUnixMs = Date.now()): boolean {
  if (!health) return false;
  return [health.microphone, health.systemAudio].some(source => source.state !== 'disabled' && (
    finished ? source.lastSignalAtUnixMs === undefined || source.warnings.some(w => w.kind === 'unavailable' || w.kind === 'no-audio' || (w.kind === 'reconnecting' && w.resolvedAtUnixMs === undefined))
      : ['quiet', 'unavailable', 'reconnecting', 'stopped'].includes(source.state) || (source.state === 'receiving' && stalePcm(source, nowUnixMs))
  ));
}

/** Keep capture, audible signal, durable save and text generation distinct. */
export default function RecordingStatus(props: RecordingStatusProps) {
  const finished = props.mode === 'ready' || props.mode === 'processing';
  const now = props.nowUnixMs ?? Date.now();
  const attention = recordingNeedsAttention(props.health, finished, now);
  const heading = props.mode === 'watching' ? 'Not recording · waiting for a meeting'
    : props.mode === 'awaiting-consent' ? props.approvalPending ? 'Not recording yet · start requested…' : 'Not recording · meeting needs your approval'
    : props.mode === 'unavailable' ? 'Recording status unconfirmed'
    : props.mode === 'no-audio' ? 'Audio unavailable · not capturing'
    : props.mode === 'paused' ? 'Paused · recording stopped'
    : props.mode === 'starting' ? 'Starting recording…'
    : props.mode === 'processing' ? 'Recording ended · finishing transcript'
    : props.mode === 'ready' ? attention ? 'Saved · audio needs review' : 'Saved · transcript ready'
    : `● Recording ${recordingClock(props.elapsedSeconds)}${attention ? ' · check audio' : ''}`;
  const showSources = ['starting', 'recording', 'no-audio', 'processing', 'ready'].includes(props.mode);
  const mic = sourceLabel(props.health?.microphone, finished, now);
  const computer = sourceLabel(props.health?.systemAudio, finished, now).replace('check if speaking', 'check if others are speaking');
  return <Box flexDirection="column" flexShrink={0} marginBottom={1} aria-label="Recording status">
    <Text bold color={attention || props.mode === 'no-audio' || props.mode === 'unavailable' || props.mode === 'awaiting-consent' ? 'yellow' : props.mode === 'recording' ? 'red' : 'cyan'}>{heading}</Text>
    {props.title && <Text>{props.title}</Text>}
    {showSources && <Text>Microphone: {mic}</Text>}
    {showSources && <Text>Computer audio: {computer}</Text>}
    {showSources && <Text>{props.savedThroughSeconds === undefined ? 'Saved audio: not confirmed'
      : props.savedThroughSeconds > 0 ? `Audio saved through ${recordingClock(props.savedThroughSeconds)}` : 'Waiting for the first audio save…'}
      {props.draftLabel ? ` · ${props.draftLabel}` : ''}</Text>}
    {attention && !finished && <Text color="yellow">[I] Audio help · Check your input if expected sound is missing.</Text>}
    {props.mode === 'awaiting-consent' && !props.approvalPending && <Text bold>[M] Record this meeting  [X] Ignore</Text>}
    {props.warning && <Text color="yellow">{props.warning}</Text>}
  </Box>;
}
