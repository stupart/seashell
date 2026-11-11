import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { rememberAudioCheck } from './audio-checks.ts';
import { defaultMicrophoneRecorder, MICROPHONE_PERMISSION_EXIT_CODE } from './live-microphone.ts';
import {
  defaultSystemAudioHelper,
  LIVE_CAPTURE_SAMPLE_RATE,
  parseNativeSystemAudioEvent,
  pcmS16leSignalLevel,
  SYSTEM_AUDIO_HELPER,
  type PcmSignalLevel,
} from './live-system-audio.ts';
import { terminateManagedChild, trackChildProcess } from './process-lifecycle.ts';

export interface LevelProblem {
  readonly kind: 'permission' | 'missing' | 'stopped';
  readonly message: string;
}

/** Starts listening and reports a level about ten times a second; the returned function stops it. */
export type LevelSource = (listener: {
  onLevel: (level: PcmSignalLevel) => void;
  onProblem: (problem: LevelProblem) => void;
}) => () => void;

/** 100 ms of 16 kHz, 16-bit mono. */
const WINDOW_BYTES = LIVE_CAPTURE_SAMPLE_RATE * 2 / 10;

function listen(child: ChildProcess, onLevel: (level: PcmSignalLevel) => void): () => void {
  const untrack = trackChildProcess(child);
  let pending: Buffer = Buffer.alloc(0);
  child.stdout?.on('data', (data: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    while (pending.length >= WINDOW_BYTES) {
      onLevel(pcmS16leSignalLevel(pending.subarray(0, WINDOW_BYTES)));
      pending = pending.subarray(WINDOW_BYTES);
    }
  });
  return () => { untrack(); void terminateManagedChild(child); };
}

/** The same recorder background meetings use, so a pass here means meetings hear you too. */
export const microphoneLevels: LevelSource = ({ onLevel, onProblem }) => {
  const recorder = defaultMicrophoneRecorder();
  const child = spawn(recorder.command, [...recorder.args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stopped = false;
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-400); });
  child.on('error', (error) => { if (!stopped) onProblem({ kind: 'missing', message: `The microphone recorder could not start: ${error.message}` }); });
  child.on('close', (code) => {
    if (stopped) return;
    onProblem(code === MICROPHONE_PERMISSION_EXIT_CODE
      ? { kind: 'permission', message: 'Microphone access is off for Seashell Microphone.' }
      : { kind: 'stopped', message: `The microphone recorder stopped${stderr.trim() ? `: ${stderr.trim()}` : '.'}` });
  });
  const stop = listen(child, onLevel);
  return () => { stopped = true; stop(); };
};

/** The computer-audio helper under its own identity, Seashell System Audio: a
 * pass here is what lets the background recorder switch to it. */
export const computerLevels: LevelSource = ({ onLevel, onProblem }) => {
  if (!existsSync(SYSTEM_AUDIO_HELPER)) {
    onProblem({ kind: 'missing', message: 'The computer-audio recorder is not installed. Update Seashell.' });
    return () => {};
  }
  const child = spawn(defaultSystemAudioHelper(), ['--sample-rate', String(LIVE_CAPTURE_SAMPLE_RATE), '--chunk-ms', '100'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let stopped = false;
  let failure: LevelProblem | undefined;
  let events = '';
  child.stderr?.on('data', (data: Buffer) => {
    const lines = (events + data.toString()).split('\n');
    events = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const event = parseNativeSystemAudioEvent(line);
        if (event.type === 'error') failure = { kind: event.code === 'permission_denied' ? 'permission' : 'stopped', message: event.message };
      } catch { /* Only errors matter here. */ }
    }
  });
  child.on('error', (error) => { if (!stopped) onProblem({ kind: 'missing', message: `The computer-audio recorder could not start: ${error.message}` }); });
  child.on('close', (code) => {
    if (!stopped) onProblem(failure ?? { kind: 'stopped', message: `The computer-audio recorder stopped (exit ${code}).` });
  });
  const stop = listen(child, onLevel);
  return () => { stopped = true; stop(); };
};

/** Any sound the Mac plays, even a short alert. */
export const COMPUTER_PASS = { dbfs: -50, windows: 2 } as const;

export interface ComputerAudioCheck {
  readonly heard: boolean;
  /** macOS said no to Seashell System Audio. */
  readonly refused: boolean;
  readonly detail: string;
}

const MEANWHILE = 'Meetings keep recording with the background recorder meanwhile.';

/** A short alert, so the check never depends on something else playing. */
function playAlert(): void {
  const player = spawn('/usr/bin/afplay', ['/System/Library/Sounds/Glass.aiff'], { stdio: 'ignore' });
  player.on('error', () => {});
}

/**
 * The one-time check, for when you are at the Mac: play a short sound and
 * listen for it through Seashell System Audio's own identity. macOS asks once
 * the first time. A pass is remembered (src/audio-checks.ts), and from then on
 * the background recorder records computer audio with it.
 */
export function checkComputerAudio(options: {
  readonly source?: LevelSource;
  readonly play?: () => void;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly remember?: () => void;
} = {}): Promise<ComputerAudioCheck> {
  const play = options.play ?? playAlert;
  return new Promise((resolve) => {
    let finished = false;
    let loud = 0;
    let stop: (() => void) | undefined;
    const finish = (result: ComputerAudioCheck) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(sounds);
      options.signal?.removeEventListener('abort', cancel);
      stop?.();
      if (result.heard) (options.remember ?? (() => rememberAudioCheck('computer')))();
      resolve(result);
    };
    const cancel = () => finish({ heard: false, refused: false, detail: 'Check stopped.' });
    const timer = setTimeout(() => finish({ heard: false, refused: false,
      detail: `Nothing was heard. If macOS asked, choose Allow, then check again. Check your Mac is not muted. ${MEANWHILE}` }),
      options.timeoutMs ?? 20_000);
    const sounds = setInterval(play, 2_000);
    if (options.signal?.aborted) { cancel(); return; }
    options.signal?.addEventListener('abort', cancel, { once: true });
    stop = (options.source ?? computerLevels)({
      onLevel: (level) => {
        if (level.rmsDbfs >= COMPUTER_PASS.dbfs && ++loud >= COMPUTER_PASS.windows) {
          finish({ heard: true, refused: false, detail: 'Heard your Mac through Seashell System Audio. Meetings use it from the next call.' });
        }
      },
      onProblem: (problem) => finish(problem.kind === 'permission'
        ? { heard: false, refused: true, detail: `macOS has not allowed Seashell System Audio. Turn it on in Privacy & Security → Screen & System Audio Recording, then check again. ${MEANWHILE}` }
        : { heard: false, refused: false, detail: `${problem.message} ${MEANWHILE}` }),
    });
    if (finished) stop();
    else play();
  });
}
