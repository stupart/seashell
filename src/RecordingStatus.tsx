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

const oneSided = (source: CaptureSourceHealth) => source.warnings.some(w => w.kind === 'one-sided' && w.resolvedAtUnixMs === undefined);

function sourceLabel(source: CaptureSourceHealth | undefined, finished: boolean, now: number, missing = false): string {
  if (!source) return 'status unconfirmed';
  if (source.state === 'disabled') return 'off';
  if (finished) {
    if (source.warnings.some(w => w.kind === 'unavailable' || w.kind === 'no-audio')) return 'interrupted — review recording';
    if (missing) return 'your side wasn’t recorded';
    if (source.lastSignalAtUnixMs === undefined) return 'no sound confirmed';
    if (source.warnings.some(w => w.resolvedAtUnixMs === undefined && w.kind === 'reconnecting')) return 'interrupted — review recording';
    if (source.warnings.some(w => w.resolvedAtUnixMs === undefined && w.kind === 'quiet')) return 'sound captured · quiet at end';
    return 'sound captured';
  }
  if (source.state === 'unavailable' || source.state === 'stopped') return 'not capturing';
  if (source.state === 'reconnecting') return 'reconnecting…';
  if (source.state === 'starting') return 'opening…';
  if (stalePcm(source, now)) return 'signal not updating';
  if (source.lastPcmAtUnixMs === undefined) return 'waiting for audio';
  if (oneSided(source)) return 'not hearing you — muted or wrong mic?';
  if (source.state === 'quiet') return 'quiet — check if speaking';
  return source.lastSignalAtUnixMs === undefined ? 'waiting for sound' : 'sound detected';
}
export function recordingNeedsAttention(health?: CaptureHealthSnapshot, finished = false, nowUnixMs = Date.now()): boolean {
  if (!health) return false;
  if (finished && health.coverage?.yourSideMissing) return true;
  return [health.microphone, health.systemAudio].some(source => source.state !== 'disabled' && (
    finished ? source.lastSignalAtUnixMs === undefined || source.warnings.some(w => w.kind === 'unavailable' || w.kind === 'no-audio' || (w.kind === 'reconnecting' && w.resolvedAtUnixMs === undefined))
      : ['quiet', 'unavailable', 'reconnecting', 'stopped'].includes(source.state) || (source.state === 'receiving' && stalePcm(source, nowUnixMs)) || oneSided(source)
  ));
}

export interface RecordingSummary {
  headline: string;
  /** The headline without the meeting's title: what is happening. */
  label: string;
  color?: 'red' | 'yellow' | 'cyan';
  /** Mic, computer audio and saved audio, for a wide title line. */
  detail?: string;
  /** Everything that needs the person, in full: for `seashell` output and logs. */
  problems: string[];
  /** The most urgent problem in a few words, for the title's status slot: red while a source fails. */
  alert?: { text: string; short?: string; color: 'red' | 'yellow' };
}

/** A recorder warning for the title's status slot: whole when it is short, its first sentence when narrow. */
function warningAlert(warning: string): { text: string; short: string } {
  if (/not responding/iu.test(warning)) return { text: 'Recorder not responding · , check', short: 'Recorder not responding' };
  if (/not hearing you|muted/iu.test(warning)) return { text: 'Not hearing you · i help', short: 'Not hearing you' };
  const cut = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 1)}…` : text;
  const whole = warning.trim().replace(/\.$/u, '');
  const first = whole.split(/(?<=[.!?])\s/u)[0]!.replace(/[.!?]$/u, '');
  return { text: whole.length <= 56 ? whole : cut(first, 56), short: cut(first, 32) };
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
  // A call that was noticed is asked about in the key bar; the title only says what is happening.
  const label = props.mode === 'watching' ? 'Ready · watching for calls'
    : props.mode === 'awaiting-consent' ? props.approvalPending ? 'Starting the recording…' : 'Call noticed'
    : props.mode === 'unavailable' ? 'Recording status unconfirmed'
    : props.mode === 'no-audio' ? 'Audio unavailable · not capturing'
    : props.mode === 'paused' ? 'Paused · recording stopped'
    : props.mode === 'starting' ? 'Starting recording…'
    : props.mode === 'processing' ? 'Call ended'
    : props.mode === 'ready' ? attention ? 'Saved · audio needs review' : 'Saved · transcript ready'
    : `● Recording ${recordingClock(props.elapsedSeconds)}`;
  const headline = props.title ? `${label} · ${props.title}` : label;
  const showSources = ['starting', 'recording', 'no-audio', 'processing', 'ready'].includes(props.mode);
  const mic = sourceLabel(props.health?.microphone, finished, now, props.health?.coverage?.yourSideMissing);
  const computer = sourceLabel(props.health?.systemAudio, finished, now).replace('check if speaking', 'check if others are speaking');
  const healthy = (value: string) => ['sound detected', 'sound captured', 'off'].includes(value);
  // Once the call is over, how far the audio got only matters when it did not all arrive.
  const saved = props.mode === 'processing' ? 'Audio saved · writing notes'
    : props.savedThroughSeconds === undefined ? 'Saved audio: not confirmed'
    : props.savedThroughSeconds > 0 ? `Audio saved through ${recordingClock(props.savedThroughSeconds)}` : 'Waiting for the first audio save…';
  const micBad = showSources && attention && !healthy(mic);
  const computerBad = showSources && attention && !healthy(computer);
  const failing = [
    ...(micBad ? [`Microphone: ${mic}`] : []),
    ...(computerBad ? [`Computer audio: ${computer}`] : []),
  ];
  const problems = [
    ...(failing.length ? [`${failing.join(' · ')}${finished ? '' : ' · i audio help'}`]
      : attention && !finished ? ['Check your input if expected sound is missing · i audio help'] : []),
    ...(props.warning ? [props.warning] : []),
    ...(props.draftLabel?.includes('delayed') ? [props.draftLabel] : []),
  ];
  // Not capturing at all is a failure; quiet, one-sided or unconfirmed sound needs a look.
  const failed = (source?: CaptureSourceHealth) => !finished && (source?.state === 'unavailable' || source?.state === 'stopped');
  const micWords = mic.startsWith('not hearing you') ? 'Not hearing you' : mic.startsWith('quiet') ? 'Mic quiet'
    : mic === 'your side wasn’t recorded' ? 'Your side not recorded' : finished ? 'Mic interrupted' : 'Mic not heard';
  const computerWords = computer.startsWith('quiet') ? 'Call audio quiet' : finished ? 'Computer audio interrupted' : 'Computer audio not heard';
  const help = finished ? '' : ' · i help';
  const sourceAlert = micBad && computerBad ? `${finished ? 'Audio interrupted' : 'Nothing heard'}${help}`
    : micBad ? `${micWords}${help}` : computerBad ? `${computerWords}${help}`
    : attention && !finished ? 'Check your input · i help' : undefined;
  // Narrow, the key goes first: the key bar shows i too.
  const alert = sourceAlert
    ? { text: sourceAlert, short: sourceAlert.replace(' · i help', ''),
      color: failed(props.health?.microphone) || failed(props.health?.systemAudio) ? 'red' as const : 'yellow' as const }
    : props.warning ? { ...warningAlert(props.warning), color: 'yellow' as const }
    : props.draftLabel?.includes('delayed') ? { text: 'Live text delayed', color: 'yellow' as const } : undefined;
  return {
    headline,
    label,
    ...(alert ? { alert } : {}),
    ...(attention || props.mode === 'no-audio' || props.mode === 'unavailable' || props.mode === 'awaiting-consent'
      ? { color: 'yellow' as const }
      : props.mode === 'recording' ? { color: 'red' as const } : {}),
    ...(showSources ? { detail: saved } : {}),
    problems,
  };
}
