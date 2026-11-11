import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { SeashellConfig } from './config.ts';
import { meetingApps, sameApplicationFamily, type MeetingCandidate } from './meeting-automation.ts';
import { meetingCommandPath, writeMeetingCommand } from './meeting-command.ts';
import type { VideoCaptureRequest, VideoQuality, VideoTarget } from './video-capture.ts';

/** meeting.video in config.json. */
export interface MeetingVideoConfig {
  /** Record the call's window with each call recording. */
  enabled?: boolean;
  /** Per app, by the ids of `seashell meeting apps`: false turns video off for that app. */
  apps?: Partial<Record<string, boolean>>;
  /** Frames per second, 1 to 30. Slides and screen shares need very few. */
  fps?: number;
  quality?: VideoQuality;
}

/**
 * On for calls. At 2 fps and medium quality a screen share measured about
 * 60 MB an hour (at most about 135 for constant motion; see the README), less
 * than the meeting's own audio, which is about 230 MB an hour.
 */
export const DEFAULT_MEETING_VIDEO = Object.freeze({ enabled: true, fps: 2, quality: 'medium' as VideoQuality });

/** What a recording started by hand asked to film; neither means "the call, or the screen". */
export interface VideoChoice {
  readonly window?: string;
  readonly display?: number;
}

interface VideoRequestFile {
  readonly schemaVersion: 1;
  readonly createdAtUnixMs: number;
  readonly window?: string;
  readonly display?: number;
}

/** Beside the record-by-hand command, so tests that move one move both. */
export function videoRequestPath(): string {
  return join(dirname(meetingCommandPath()), 'meeting-video-request.json');
}

export function writeVideoRequest(choice: VideoChoice = {}, path = videoRequestPath(), nowUnixMs = Date.now()): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const value: VideoRequestFile = {
    schemaVersion: 1,
    createdAtUnixMs: nowUnixMs,
    ...(choice.window ? { window: choice.window } : {}),
    ...(choice.display === undefined ? {} : { display: choice.display }),
  };
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
}

export function clearVideoRequest(path = videoRequestPath()): void {
  rmSync(path, { force: true });
}

/** Read once and delete. Like the start command it goes with, a stale request is dropped. */
export function consumeVideoRequest(path = videoRequestPath(), nowUnixMs = Date.now(), maximumAgeMs = 30_000): VideoChoice | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { value = undefined; }
  finally { rmSync(path, { force: true }); }
  const file = value as Partial<VideoRequestFile> | undefined;
  if (!file || file.schemaVersion !== 1 || !Number.isSafeInteger(file.createdAtUnixMs)) return undefined;
  const age = nowUnixMs - Number(file.createdAtUnixMs);
  if (age < 0 || age > maximumAgeMs) return undefined;
  return Object.freeze({
    ...(typeof file.window === 'string' && file.window.trim() ? { window: file.window.trim() } : {}),
    ...(Number.isSafeInteger(file.display) && Number(file.display) >= 1 ? { display: Number(file.display) } : {}),
  });
}

/**
 * Record now, with video: what Space-with-video in the app and
 * `seashell record --video` do. The background recorder owns capture and picks
 * both files up on its next check.
 */
export function startRecordingWithVideo(choice: VideoChoice = {}): void {
  writeVideoRequest(choice);
  writeMeetingCommand('start');
}

function meetingAppFor(bundleId: string) {
  return bundleId ? meetingApps().find((app) => app.bundleIds.some((id) => sameApplicationFamily(bundleId, id))) : undefined;
}

/** `--window zoom`, `--window "Google Chrome"`, or any other app's name. */
export function videoTargetFor(choice: VideoChoice): VideoTarget {
  if (choice.display !== undefined) return { kind: 'display', display: choice.display };
  if (choice.window) {
    const wanted = choice.window.toLocaleLowerCase();
    const app = meetingApps().find((candidate) => candidate.id === wanted || candidate.name.toLocaleLowerCase() === wanted);
    return { kind: 'window', appName: app?.name ?? choice.window, ...(app ? { bundleIds: app.bundleIds } : {}) };
  }
  // Nothing named: a call's window if one is open, otherwise the main display.
  return { kind: 'window', bundleIds: meetingApps().flatMap((app) => app.bundleIds), callWindowOnly: true };
}

/**
 * Whether this recording gets video, and of what. A call records its app's
 * window when video is on for that app. A recording started by hand gets video
 * only when it was asked for, so pressing Space never films the screen unasked.
 */
export function meetingVideoRequest(
  config: SeashellConfig,
  candidate: MeetingCandidate,
  consume: () => VideoChoice | undefined = consumeVideoRequest,
): VideoCaptureRequest | undefined {
  const video = config.meeting?.video;
  const settings = { fps: video?.fps ?? DEFAULT_MEETING_VIDEO.fps, quality: video?.quality ?? DEFAULT_MEETING_VIDEO.quality };
  try {
    if (candidate.kind === 'manual') {
      const choice = consume();
      return choice ? { target: videoTargetFor(choice), ...settings } : undefined;
    }
    if (!(video?.enabled ?? DEFAULT_MEETING_VIDEO.enabled)) return undefined;
    const app = meetingAppFor(candidate.bundleId);
    if (app && video?.apps?.[app.id] === false) return undefined;
    const bundleIds = [...new Set([candidate.bundleId, ...(app?.bundleIds ?? [])].filter(Boolean))];
    return {
      target: { kind: 'window', ...(candidate.pid > 0 ? { pid: candidate.pid } : {}), bundleIds, ...(app ? { appName: app.name } : {}) },
      ...settings,
    };
  } catch {
    // Choosing a video target must never stop the audio from starting.
    return undefined;
  }
}
