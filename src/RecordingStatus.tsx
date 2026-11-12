import type { CaptureHealthSnapshot, CaptureSourceHealth, CaptureVideoHealth } from './capture-health.ts';
import type { Hint } from './tui-chrome.tsx';

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
  // The call app let go of its microphone, so Seashell did too; it opens again if the call comes back.
  if (source.state === 'released') return 'released · the call let go of it';
  // The recorder keeps checking, and starts the moment macOS allows it.
  if (source.state === 'unavailable' && source.code === MICROPHONE_NOT_ALLOWED) return 'not allowed';
  if (source.state === 'unavailable' || source.state === 'stopped') return 'not capturing';
  if (source.state === 'reconnecting') return 'reconnecting…';
  if (source.state === 'starting') return 'opening…';
  if (stalePcm(source, now)) return 'signal not updating';
  if (source.lastPcmAtUnixMs === undefined) return 'waiting for audio';
  if (oneSided(source)) return 'silent — muted or wrong mic?';
  if (source.state === 'quiet') return 'quiet — check if speaking';
  return source.lastSignalAtUnixMs === undefined ? 'waiting for sound' : 'sound detected';
}
/**
 * What audio help leads with during a call: what Seashell observed from the source that needs a look,
 * and from when in the call. "Your mic has sent silence since 1:12."
 */
export function sourceFinding(health: CaptureHealthSnapshot | undefined, startedAtUnixMs: number | undefined, nowUnixMs = Date.now()):
  { text: string; source: 'microphone' | 'computer' } | undefined {
  if (!health) return undefined;
  const at = (unixMs?: number) => unixMs === undefined || startedAtUnixMs === undefined ? undefined
    : recordingClock(Math.max(0, unixMs - startedAtUnixMs) / 1000);
  const describe = (source: CaptureSourceHealth, name: string, silent: string) => {
    if (source.state === 'disabled') return undefined;
    if (source.state === 'unavailable' || source.state === 'stopped' || source.state === 'receiving' && stalePcm(source, nowUnixMs)) {
      const last = at(source.lastPcmAtUnixMs);
      return last ? `${name} stopped at ${last}.` : `${name} has sent nothing since the call started.`;
    }
    if (oneSided(source) || source.state === 'quiet') {
      const last = at(source.lastSignalAtUnixMs);
      return last ? `${name} ${silent} since ${last}.` : `${name} ${silent} since the call started.`;
    }
    return undefined;
  };
  const mic = describe(health.microphone, 'Your mic', 'has sent silence');
  if (mic) return { text: mic, source: 'microphone' };
  const computer = describe(health.systemAudio, 'Computer audio', 'has been silent');
  return computer ? { text: computer, source: 'computer' } : undefined;
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
  /** What is happening, then the meeting's title. It keeps the title line's own colour whatever happens:
   * only its ● is red, and only the alert says something is wrong. */
  headline: string;
  /** The headline without the meeting's title: what is happening. */
  label: string;
  /** Mic, computer audio and saved audio, for a wide title line. */
  detail?: string;
  /** Everything that needs the person, in full: for `seashell` output and logs. */
  problems: string[];
  /** The most urgent problem in a few words, for the title's status slot: red while a source fails,
   * yellow when it needs a look. The key that helps leads the key bar. */
  alert?: { text: string; short?: string; color: 'red' | 'yellow'; fix?: Hint };
}

const MIC_HELP: Hint = ['i', 'mic help'];
const AUDIO_HELP: Hint = ['i', 'audio help'];
/** Enter asks macOS for the microphone, or opens its Privacy pane once macOS has said no. */
export const ALLOW_MIC: Hint = ['Enter', 'allow mic'];
/** A recording's microphone that macOS has not allowed (src/live-microphone.ts). */
const MICROPHONE_NOT_ALLOWED = 'microphone_permission';

/** A recorder warning for the title's status slot: whole when it is short, its first sentence when narrow. */
function warningAlert(warning: string): { text: string; short?: string; fix?: Hint } {
  if (/not responding/iu.test(warning)) return { text: 'Recorder not responding', fix: [',', 'fix recorder'] };
  if (/not hearing you|muted/iu.test(warning)) return { text: 'Mic silent', fix: MIC_HELP };
  const cut = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 1)}…` : text;
  const whole = warning.trim().replace(/\.$/u, '');
  const first = whole.split(/(?<=[.!?])\s/u)[0]!.replace(/[.!?]$/u, '');
  return { text: whole.length <= 56 ? whole : cut(first, 56), short: cut(first, 32) };
}

/** What the video films while a call records: always said, so it is never a surprise. */
export function videoStatus(video: CaptureVideoHealth | undefined): string | undefined {
  if (!video) return undefined;
  if (video.state === 'recording') return video.filming ? `Filming ${video.filming}` : 'Filming the call';
  if (video.state === 'waiting') return 'Not filming: no call window showing';
  if (video.state === 'starting') return 'Video starting…';
  return video.state === 'unavailable' ? 'No video' : undefined;
}

/** "Live text paused: your Mac is busy…": drafts stopped on purpose, while the audio records. */
const LIVE_TEXT_PAUSED_LEAD = 'Live text paused';
/** Live text that is behind or paused is said; the recording itself is fine. */
const draftProblem = (label?: string): boolean => Boolean(label?.includes('delayed') || label?.startsWith(LIVE_TEXT_PAUSED_LEAD));

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
    // Filming a whole display is said in the title itself, where nothing cuts it off.
    : `● Recording ${recordingClock(props.elapsedSeconds)}${props.health?.video?.screenFilmed ? ' · filming the whole screen' : ''}`;
  const headline = props.title ? `${label} · ${props.title}` : label;
  const showSources = ['starting', 'recording', 'no-audio', 'processing', 'ready'].includes(props.mode);
  const mic = sourceLabel(props.health?.microphone, finished, now, props.health?.coverage?.yourSideMissing);
  const computer = sourceLabel(props.health?.systemAudio, finished, now).replace('check if speaking', 'check if others are speaking');
  const healthy = (value: string) => ['sound detected', 'sound captured', 'off'].includes(value);
  // Once the call is over, how far the audio got only matters when it did not all arrive.
  const audio = props.mode === 'processing' ? 'Audio saved · writing notes'
    : props.savedThroughSeconds === undefined ? 'Saved audio: not confirmed'
    : props.savedThroughSeconds > 0 ? `Audio saved through ${recordingClock(props.savedThroughSeconds)}` : 'Waiting for the first audio save…';
  const video = finished ? undefined : videoStatus(props.health?.video);
  const saved = video ? `${audio} · ${video}` : audio;
  const micBad = showSources && attention && !healthy(mic);
  const computerBad = showSources && attention && !healthy(computer);
  const failing = [
    ...(micBad ? [`Microphone: ${mic}`] : []),
    ...(computerBad ? [`Computer audio: ${computer}`] : []),
  ];
  const notAllowed = micBad && mic === 'not allowed';
  const problems = [
    ...(failing.length ? [`${failing.join(' · ')}${finished ? '' : notAllowed ? ' · Enter to allow' : ' · i audio help'}`]
      : attention && !finished ? ['Check your input if expected sound is missing · i audio help'] : []),
    ...(props.warning ? [props.warning] : []),
    ...(draftProblem(props.draftLabel) ? [props.draftLabel!] : []),
  ];
  // Not capturing at all is a failure; quiet, one-sided or unconfirmed sound needs a look.
  const failed = (source?: CaptureSourceHealth) => !finished && (source?.state === 'unavailable' || source?.state === 'stopped');
  // One name for a microphone Seashell cannot hear, whether it stopped or sends silence.
  const micWords = notAllowed ? 'Mic not allowed' : mic.startsWith('quiet') ? 'Mic quiet' : mic === 'your side wasn’t recorded' ? 'Your side not recorded'
    : finished ? 'Mic interrupted' : 'Mic silent';
  const computerWords = computer.startsWith('quiet') ? 'Call audio quiet' : finished ? 'Computer audio interrupted' : 'Computer audio silent';
  // A microphone macOS has not allowed is said as such: Enter fixes it, whatever else is wrong.
  const sourceAlert = notAllowed ? micWords : micBad && computerBad ? finished ? 'Audio interrupted' : 'Nothing heard'
    : micBad ? micWords : computerBad ? computerWords
    : attention && !finished ? 'Check your input' : undefined;
  // Audio help opens on whatever is wrong; once the call is over there is nothing left to check.
  const help = finished ? {} : { fix: notAllowed ? ALLOW_MIC : micBad && !computerBad ? MIC_HELP : AUDIO_HELP };
  const alert = sourceAlert
    ? { text: sourceAlert, ...help,
      color: failed(props.health?.microphone) || failed(props.health?.systemAudio) ? 'red' as const : 'yellow' as const }
    : props.warning ? { ...warningAlert(props.warning), color: 'yellow' as const }
    : draftProblem(props.draftLabel) ? { text: props.draftLabel!.startsWith(LIVE_TEXT_PAUSED_LEAD) ? 'Live text paused' : 'Live text delayed',
      color: 'yellow' as const } : undefined;
  return {
    headline,
    label,
    ...(alert ? { alert } : {}),
    ...(showSources ? { detail: saved } : {}),
    problems,
  };
}
