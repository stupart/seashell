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

export interface RecordingSummary {
  headline: string;
  color?: 'red' | 'yellow' | 'cyan';
  /** Mic, computer audio and saved audio, for a wide title line. */
  detail?: string;
  /** Rows that appear only when something needs the person. */
  problems: string[];
}

/**
 * One line for the title bar: capture, audible signal, durable save and text
 * generation stay distinct, but only what is wrong takes up rows. "Recording"
 * still means observed capture, never the person's intent.
 */
export function recordingSummary(props: RecordingStatusProps): RecordingSummary {
  const finished = props.mode === 'ready' || props.mode === 'processing';
  const now = props.nowUnixMs ?? Date.now();
  const attention = recordingNeedsAttention(props.health, finished, now);
  const label = props.mode === 'watching' ? 'Not recording · waiting for a meeting'
    : props.mode === 'awaiting-consent' ? props.approvalPending ? 'Not recording yet · start requested…' : 'Not recording · record this?'
    : props.mode === 'unavailable' ? 'Recording status unconfirmed'
    : props.mode === 'no-audio' ? 'Audio unavailable · not capturing'
    : props.mode === 'paused' ? 'Paused · recording stopped'
    : props.mode === 'starting' ? 'Starting recording…'
    : props.mode === 'processing' ? 'Recording ended · finishing transcript'
    : props.mode === 'ready' ? attention ? 'Saved · audio needs review' : 'Saved · transcript ready'
    : `● Recording ${recordingClock(props.elapsedSeconds)}`;
  const headline = props.title ? `${label} · ${props.title}` : label;
  const showSources = ['starting', 'recording', 'no-audio', 'processing', 'ready'].includes(props.mode);
  const mic = sourceLabel(props.health?.microphone, finished, now);
  const computer = sourceLabel(props.health?.systemAudio, finished, now).replace('check if speaking', 'check if others are speaking');
  const healthy = (value: string) => ['sound detected', 'sound captured', 'off'].includes(value);
  const saved = props.savedThroughSeconds === undefined ? 'Saved audio: not confirmed'
    : props.savedThroughSeconds > 0 ? `Audio saved through ${recordingClock(props.savedThroughSeconds)}` : 'Waiting for the first audio save…';
  const failing = [
    ...(showSources && attention && !healthy(mic) ? [`Microphone: ${mic}`] : []),
    ...(showSources && attention && !healthy(computer) ? [`Computer audio: ${computer}`] : []),
  ];
  const problems = [
    ...(failing.length ? [`${failing.join(' · ')}${finished ? '' : ' · i audio help'}`]
      : attention && !finished ? ['Check your input if expected sound is missing · i audio help'] : []),
    ...(props.warning ? [props.warning] : []),
    ...(props.draftLabel?.includes('delayed') ? [props.draftLabel] : []),
  ];
  return {
    headline,
    ...(attention || props.mode === 'no-audio' || props.mode === 'unavailable' || props.mode === 'awaiting-consent'
      ? { color: 'yellow' as const }
      : props.mode === 'recording' ? { color: 'red' as const } : {}),
    ...(showSources ? { detail: props.mode === 'processing' && props.draftLabel ? `${saved} · ${props.draftLabel}` : saved } : {}),
    problems,
  };
}
