import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { CaptureVideoSegment, CaptureVideoSlot, CaptureVideoTarget } from './capture-session.ts';
import { helperPermission, type HelperPermissionOptions, type HelperPermissionStatus } from './helper-permission.ts';
import { prepareRuntimeHelper, SCREEN_CAPTURE_RUNTIME_HELPER } from './runtime-host.ts';

export const SCREEN_CAPTURE_HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'bin', 'seashell-screen-capture');
/** The native helper's exit status when macOS Screen Recording access is off. */
export const SCREEN_CAPTURE_PERMISSION_EXIT_CODE = 77;
const NO_FRAMES_EXIT_CODE = 3;

export type VideoQuality = 'low' | 'medium' | 'high';
export const VIDEO_QUALITIES: readonly VideoQuality[] = Object.freeze(['low', 'medium', 'high']);
export type VideoState = 'starting' | 'recording' | 'stopped' | 'unavailable';

/**
 * What to record. A window is a meeting app's main window, found by its
 * process or bundle; when none fits, the helper records the main display.
 */
export type VideoTarget =
  | {
      readonly kind: 'window';
      readonly pid?: number;
      readonly bundleIds?: readonly string[];
      readonly appName?: string;
      /** Only windows whose titles look like a call (a recording started by hand). */
      readonly callWindowOnly?: boolean;
    }
  | { readonly kind: 'display'; readonly display: number };

export interface VideoCaptureRequest {
  readonly target: VideoTarget;
  readonly fps: number;
  readonly quality: VideoQuality;
}

/** What the helper reported about one recorded movie, read from its sidecar. */
export interface VideoSegmentInfo {
  readonly firstFrameUnixMs: number;
  readonly durationMs?: number;
  readonly frames?: number;
  readonly bytes?: number;
  readonly codec?: string;
  readonly width?: number;
  readonly height?: number;
  readonly target?: CaptureVideoTarget;
  readonly finished: boolean;
}

export type VideoCaptureResult =
  | { readonly saved: true; readonly segment: VideoSegmentInfo; readonly requestedStop: boolean }
  | { readonly saved: false; readonly reason: 'permission' | 'no-frames' | 'failed'; readonly message: string; readonly requestedStop: boolean };

export interface StartVideoCaptureOptions {
  readonly request: VideoCaptureRequest;
  readonly outputPath: string;
  readonly sidecarPath: string;
  readonly sessionStartedAtUnixMs: number;
  readonly onFirstFrame?: (segment: VideoSegmentInfo) => void;
  readonly onWarning?: (message: string) => void;
  /** Test/development override; production uses the stable runtime copy. */
  readonly command?: string;
  /** How long a stopping helper may take to finish its file before SIGKILL. */
  readonly stopTimeoutMs?: number;
}

export interface VideoCaptureHandle {
  /** Settles when the helper exits; never rejects. */
  readonly done: Promise<VideoCaptureResult>;
  stop(): void;
}

const PERMISSION_HELP = 'Video is on, but Screen Recording is off for Seashell Screen Capture. ' +
  'Run seashell meeting video setup, or turn video off with seashell meeting video off.';

let preparedHelper: string | undefined;

/** The stable copy keeps its Screen Recording permission across updates. */
export function defaultScreenCaptureHelper(): string {
  if (process.platform !== 'darwin' || !existsSync(SCREEN_CAPTURE_HELPER)) return SCREEN_CAPTURE_HELPER;
  if (!preparedHelper || !existsSync(preparedHelper)) {
    try { preparedHelper = prepareRuntimeHelper(SCREEN_CAPTURE_HELPER, SCREEN_CAPTURE_RUNTIME_HELPER); }
    catch { preparedHelper = SCREEN_CAPTURE_HELPER; }
  }
  return preparedHelper;
}

const PERMISSION_DETAILS = {
  authorized: 'Seashell Screen Capture can record call windows, including in the background.',
  denied: 'Screen Recording is not on for Seashell Screen Capture. Run seashell meeting video setup, then turn on ' +
    'Seashell Screen Capture in System Settings → Privacy & Security → Screen & System Audio Recording.',
  notDetermined: 'macOS has not asked yet. Run seashell meeting video setup.',
  unavailable: 'The Seashell screen capture helper is missing. Reinstall or run bash scripts/build-native.sh.',
};

export function screenCapturePermission(options: HelperPermissionOptions = {}): Promise<HelperPermissionStatus> {
  return helperPermission(options.helperPath ?? SCREEN_CAPTURE_HELPER, SCREEN_CAPTURE_RUNTIME_HELPER, PERMISSION_DETAILS, options);
}

export function screenCaptureArguments(options: Pick<StartVideoCaptureOptions, 'request' | 'outputPath' | 'sidecarPath' | 'sessionStartedAtUnixMs'>): string[] {
  const { request } = options;
  const target = request.target;
  return [
    '--output', options.outputPath,
    '--sidecar', options.sidecarPath,
    '--session-origin-unix-ms', String(options.sessionStartedAtUnixMs),
    '--fps', String(request.fps),
    '--quality', request.quality,
    ...(target.kind === 'display' ? ['--display', String(target.display)] : [
      ...(target.pid && target.pid > 0 ? ['--pid', String(target.pid)] : []),
      ...(target.bundleIds ?? []).flatMap((id) => ['--bundle-id', id]),
      ...(target.appName ? ['--app-name', target.appName] : []),
      ...(target.callWindowOnly ? ['--call-window-only'] : []),
    ]),
  ];
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function targetFrom(value: unknown): CaptureVideoTarget | undefined {
  if (!plain(value) || (value.kind !== 'window' && value.kind !== 'display')) return undefined;
  // Window titles stay in the sidecar; the manifest and video.json name only the app.
  return Object.freeze({
    kind: value.kind,
    ...(typeof value.app === 'string' && value.app ? { app: value.app } : {}),
    ...(typeof value.bundleId === 'string' && value.bundleId ? { bundleId: value.bundleId } : {}),
    ...(Number.isSafeInteger(value.display) ? { display: value.display as number } : {}),
  });
}

function optionalInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

/** The helper rewrites its sidecar atomically at the first frame and at the end. */
export function readVideoSidecar(path: string): VideoSegmentInfo | undefined {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
  if (!plain(value) || !Number.isSafeInteger(value.firstFrameUnixMs)) return undefined;
  const target = targetFrom(value.target);
  const number = (key: string) => optionalInteger(value[key]);
  return Object.freeze({
    firstFrameUnixMs: value.firstFrameUnixMs as number,
    ...(number('durationMs') === undefined ? {} : { durationMs: number('durationMs') }),
    ...(number('frames') === undefined ? {} : { frames: number('frames') }),
    ...(typeof value.codec === 'string' ? { codec: value.codec } : {}),
    ...(number('width') === undefined ? {} : { width: number('width') }),
    ...(number('height') === undefined ? {} : { height: number('height') }),
    ...(target ? { target } : {}),
    finished: value.finished === true,
  });
}

/** Record one movie with the native helper. Failures resolve, never throw. */
export function startVideoCapture(options: StartVideoCaptureOptions): VideoCaptureHandle {
  let requestedStop = false;
  let settled = false;
  let failure: { code: string; message: string } | undefined;
  let target: CaptureVideoTarget | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone: (result: VideoCaptureResult) => void = () => {};
  const done = new Promise<VideoCaptureResult>((resolve) => { resolveDone = resolve; });
  const finish = (result: VideoCaptureResult) => {
    if (settled) return;
    settled = true;
    if (killTimer) clearTimeout(killTimer);
    resolveDone(Object.freeze(result));
  };
  let child: ChildProcess;
  try {
    child = spawn(options.command ?? defaultScreenCaptureHelper(), screenCaptureArguments(options), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    finish({ saved: false, reason: 'failed', requestedStop,
      message: `Could not start the screen recorder: ${error instanceof Error ? error.message : String(error)}` });
    return { done, stop() {} };
  }
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch {
      failure = { code: 'failed', message: line.trim().slice(0, 500) };
      return;
    }
    if (!plain(event)) return;
    const message = typeof event.message === 'string' ? event.message : undefined;
    if (event.type === 'target') {
      target = targetFrom(event);
      if (typeof event.note === 'string') options.onWarning?.(event.note);
    } else if (event.type === 'first-frame' && Number.isSafeInteger(event.firstFrameUnixMs)) {
      options.onFirstFrame?.(Object.freeze({
        firstFrameUnixMs: event.firstFrameUnixMs as number,
        ...(target ? { target } : {}),
        finished: false,
      }));
    } else if (event.type === 'warning' && message) {
      options.onWarning?.(message);
    } else if (event.type === 'error' && message) {
      failure = { code: typeof event.code === 'string' ? event.code : 'failed', message };
    }
  };
  let pending = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (data: string) => {
    pending += data;
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      handleLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (pending.length > 16_384) pending = pending.slice(-16_384);
  });
  child.on('error', (error) => {
    failure = { code: 'failed', message: `Could not start the screen recorder: ${error.message}` };
    // A missing executable may never close; settle here as well.
    if (child.pid === undefined) finish({ saved: false, reason: 'failed', requestedStop, message: failure.message });
  });
  child.on('close', (code, signal) => {
    handleLine(pending);
    const sidecar = readVideoSidecar(options.sidecarPath);
    let bytes = 0;
    try { bytes = statSync(options.outputPath).size; } catch {}
    // A forced stop or a crash keeps every fragment written before it.
    if (sidecar && bytes > 0) {
      finish({ saved: true, requestedStop, segment: Object.freeze({ ...sidecar, bytes, ...(sidecar.target || !target ? {} : { target }) }) });
      return;
    }
    const permission = code === SCREEN_CAPTURE_PERMISSION_EXIT_CODE || failure?.code === 'permission';
    const noFrames = code === NO_FRAMES_EXIT_CODE || failure?.code === 'no-frames';
    finish({
      saved: false,
      requestedStop,
      reason: permission ? 'permission' : noFrames ? 'no-frames' : 'failed',
      message: permission ? PERMISSION_HELP
        : noFrames ? 'No screen frames arrived, so no video was saved. The call window may have been minimized.'
          : failure?.message ?? `The screen recorder stopped (${signal ?? `exit ${code ?? 'unknown'}`}).`,
    });
  });
  return {
    done,
    stop() {
      if (requestedStop || settled) return;
      requestedStop = true;
      try { child.kill('SIGINT'); } catch {}
      // The helper finishes its movie on SIGINT; fragments survive a SIGKILL.
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, options.stopTimeoutMs ?? 10_000);
      killTimer.unref();
    },
  };
}

export interface StartVideoTrackOptions {
  readonly request: VideoCaptureRequest;
  readonly sessionStartedAtUnixMs: number;
  /** A fresh movie and sidecar path in the capture bundle, for each attempt. */
  readonly nextSegment: () => CaptureVideoSlot;
  /** Called at the first frame and again when the movie is final. */
  readonly onSegment: (segment: Omit<CaptureVideoSegment, 'recordedAt'>) => void | Promise<unknown>;
  readonly onState?: (state: VideoState) => void;
  readonly onWarning: (message: string) => void;
  /** Test seam for one helper run. */
  readonly starter?: typeof startVideoCapture;
  readonly maxRestarts?: number;
  readonly restartDelayMs?: number;
}

export interface VideoTrackHandle {
  /** Settles once the last movie is final and recorded; never rejects. */
  readonly done: Promise<void>;
  stop(): void;
}

/**
 * Keep video running for a whole meeting. A helper that dies mid-call starts
 * again into a new movie, a few times at most; the movies so far stay saved.
 * Missing permission or a closed display is a warning, never a retry loop.
 */
export function startVideoTrack(options: StartVideoTrackOptions): VideoTrackHandle {
  const maximumRestarts = options.maxRestarts ?? 3;
  let stopped = false;
  let current: VideoCaptureHandle | undefined;
  let cancelDelay: (() => void) | undefined;
  const state = (value: VideoState) => options.onState?.(value);
  const record = (segment: Omit<CaptureVideoSegment, 'recordedAt'>): Promise<void> => Promise.resolve()
    .then(async () => { await options.onSegment(segment); })
    .catch((error: unknown) => options.onWarning(
      `Video is saved, but the capture could not list it: ${error instanceof Error ? error.message : String(error)}`));
  const attempt = async (): Promise<VideoCaptureResult | undefined> => {
    let slot: CaptureVideoSlot;
    try { slot = options.nextSegment(); } catch (error) {
      options.onWarning(`Video was not recorded: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    const segment = (info: VideoSegmentInfo): Omit<CaptureVideoSegment, 'recordedAt'> => Object.freeze({
      id: slot.id,
      sequence: slot.sequence,
      relativePath: slot.relativePath,
      sidecarRelativePath: slot.sidecarRelativePath,
      firstFrameMs: info.firstFrameUnixMs - options.sessionStartedAtUnixMs,
      ...(info.durationMs === undefined ? {} : { durationMs: info.durationMs }),
      ...(info.frames === undefined ? {} : { frames: info.frames }),
      ...(info.bytes === undefined ? {} : { bytes: info.bytes }),
      ...(info.codec === undefined ? {} : { codec: info.codec }),
      ...(info.width === undefined ? {} : { width: info.width }),
      ...(info.height === undefined ? {} : { height: info.height }),
      fps: options.request.fps,
      quality: options.request.quality,
      ...(info.target === undefined ? {} : { target: info.target }),
      finished: info.finished,
    });
    let firstFrame: Promise<void> = Promise.resolve();
    current = (options.starter ?? startVideoCapture)({
      request: options.request,
      outputPath: slot.path,
      sidecarPath: slot.sidecarPath,
      sessionStartedAtUnixMs: options.sessionStartedAtUnixMs,
      // Listed at once, so a crash of Seashell itself still finds this movie.
      onFirstFrame: (info) => { state('recording'); firstFrame = record(segment(info)); },
      onWarning: options.onWarning,
    });
    if (stopped) current.stop();
    const result = await current.done;
    await firstFrame;
    if (result.saved) await record(segment(result.segment));
    return result;
  };
  const done = (async () => {
    state('starting');
    for (let restarts = 0; ; restarts++) {
      const result = await attempt();
      if (result?.requestedStop) { state('stopped'); return; }
      // A failure the helper hit by itself is reported even if a stop followed it.
      if (!result || (!result.saved && result.reason !== 'failed')) {
        if (result && !result.saved) options.onWarning(result.message);
        state('unavailable');
        return;
      }
      if (stopped) { state('stopped'); return; }
      const why = result.saved ? 'The screen recorder stopped unexpectedly.' : result.message;
      if (restarts >= maximumRestarts) {
        options.onWarning(`${why} Video stays off for the rest of this recording; audio continues.`);
        state('unavailable');
        return;
      }
      options.onWarning(`${why} Starting video again.`);
      state('starting');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { cancelDelay = undefined; resolve(); }, options.restartDelayMs ?? 2_000);
        cancelDelay = () => { clearTimeout(timer); cancelDelay = undefined; resolve(); };
      });
      if (stopped) { state('stopped'); return; }
    }
  })().catch((error: unknown) => {
    options.onWarning(`Video stopped: ${error instanceof Error ? error.message : String(error)}`);
    state('unavailable');
  });
  return {
    done,
    stop() {
      stopped = true;
      cancelDelay?.();
      current?.stop();
    },
  };
}
