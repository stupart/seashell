import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentMeetingRoutes } from './ai-provider.ts';
import { readBackgroundMeetingStatus } from './background-meeting-status.ts';
import { readBackgroundWatchStatus } from './background-watch-status.ts';
import { loadCaptureSession } from './capture-session.ts';
import type { SeashellConfig } from './config.ts';
import { diarizationStatus } from './diarization-environment.ts';
import { resolveHumainExecutable } from './humain-client.ts';
import { meetingLaunchAtLoginStatus } from './launch-at-login.ts';
import { checkMeetConnection, type MeetProbe } from './meet-speakers.ts';
import { microphonePermission, type MicrophonePermissionStatus } from './microphone-permission.ts';
import { calendarPermission } from './calendar-permission.ts';
import type { HelperPermissionStatus } from './helper-permission.ts';
import { DEFAULT_WHISPER_MODEL_FILENAME } from './model-config.ts';
import { microphoneRuntimeHelperPath } from './runtime-host.ts';
import { listTranscriptRecords } from './transcript-library.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** ok: works · attention: works partly or needs one step · off: not set up (optional) · broken: should work and does not. */
export type FeatureState = 'ok' | 'attention' | 'off' | 'broken';
export type FeatureAction = 'enable-recorder' | 'connect-meet' | 'allow-microphone' | 'allow-calendar' | 'open-speakers' | 'open-ai';
export type FeatureId = 'recorder' | 'detection' | 'microphone' | 'computer-audio' | 'transcription'
  | 'meet-names' | 'speaker-separation' | 'ai-notes' | 'calendar';

export interface FeatureStatus {
  readonly id: FeatureId;
  readonly label: string;
  readonly optional: boolean;
  readonly state: FeatureState;
  /** A few words for the overview row. */
  readonly summary: string;
  /** What the feature does and what was observed. */
  readonly detail: string;
  /** The one thing to do next, in plain words. */
  readonly fix?: string;
  /** What Enter does in Settings, when Seashell can do it for you. */
  readonly action?: FeatureAction;
  /** The same step from a terminal. */
  readonly command?: string;
}

export const FEATURE_ACTION_LABEL: Record<FeatureAction, string> = {
  'enable-recorder': 'Start the background recorder',
  'connect-meet': 'Connect Google Meet',
  'allow-microphone': 'Allow microphone',
  'allow-calendar': 'Turn on calendar titles',
  'open-speakers': 'Open speaker setup',
  'open-ai': 'Choose AI',
};

/** What the most recent recorded meeting actually captured, per source. */
export interface MeetingEvidence {
  readonly title: string;
  readonly createdAt: string;
  readonly microphoneChunks: number;
  readonly audibleMicrophoneChunks: number;
  readonly computerChunks: number;
  readonly audibleComputerChunks: number;
  readonly meetingKey?: string;
}

export interface FeatureStatusDependencies {
  readonly launchAtLogin?: typeof meetingLaunchAtLoginStatus;
  readonly watchStatus?: typeof readBackgroundWatchStatus;
  readonly meetConnection?: (browser: 'auto' | 'chrome' | 'safari', signal?: AbortSignal) => Promise<MeetProbe>;
  readonly microphone?: (signal?: AbortSignal) => Promise<MicrophonePermissionStatus>;
  readonly calendar?: (signal?: AbortSignal) => Promise<HelperPermissionStatus>;
  readonly lastMeeting?: (libraryDir: string) => MeetingEvidence | undefined;
  readonly speakerSeparationReady?: () => boolean;
  readonly aiEngineInstalled?: () => boolean;
  readonly transcriptionReady?: () => boolean;
  readonly systemAudioHelperReady?: () => boolean;
  /** When the native microphone recorder was installed; earlier meetings could not hear you. */
  readonly microphoneRecorderSince?: () => number | undefined;
}

export function lastMeetingEvidence(libraryDir: string): MeetingEvidence | undefined {
  for (const entry of listTranscriptRecords(libraryDir)) {
    if (entry.kind !== 'meeting' || entry.captureState === 'recording' || entry.captureState === 'processing') continue;
    const manifestPath = join(entry.directory, 'capture', 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const chunks = loadCaptureSession(manifestPath).chunks;
      const count = (track: string, audible?: boolean) =>
        chunks.filter(chunk => chunk.trackId === track && (audible === undefined || chunk.audible === audible)).length;
      const meetingKey = readBackgroundMeetingStatus(entry.directory)?.meetingKey;
      return {
        title: entry.title, createdAt: entry.createdAt,
        microphoneChunks: count('microphone'), audibleMicrophoneChunks: count('microphone', true),
        computerChunks: count('system-audio'), audibleComputerChunks: count('system-audio', true),
        ...(meetingKey ? { meetingKey } : {}),
      };
    } catch { continue; }
  }
  return undefined;
}

function aiEngineInstalled(): boolean {
  try { resolveHumainExecutable(); return true; } catch { return false; }
}

const when = (evidence: MeetingEvidence) =>
  new Date(evidence.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * One honest checklist for every capability: permission and process state are
 * read without prompting, and recording quality is judged from what the last
 * meeting actually saved, not from configuration alone.
 */
export async function readFeatureStatuses(options: {
  readonly config: SeashellConfig;
  readonly libraryDir: string;
  readonly signal?: AbortSignal;
  readonly dependencies?: FeatureStatusDependencies;
}): Promise<FeatureStatus[]> {
  const deps = options.dependencies ?? {};
  const meeting = options.config.meeting;
  const automation = meeting?.automation;
  const automationOn = automation?.enabled !== false && automation?.mode !== 'off';
  const browser = meeting?.speakerBrowser ?? 'off';
  const calendarOn = meeting?.calendar?.enabled === true && meeting.calendar.policy !== 'off';
  const [meet, microphone, calendarAccess] = await Promise.all([
    browser === 'off' ? Promise.resolve(undefined)
      : (deps.meetConnection ?? checkMeetConnection)(browser, options.signal)
        .catch((): MeetProbe => ({ state: 'unavailable', detail: 'Meeting detection could not be checked.' })),
    (deps.microphone ?? (signal => microphonePermission({ ...(signal ? { signal } : {}) })))(options.signal)
      .catch((): MicrophonePermissionStatus => ({ authorization: 'unknown', detail: 'Could not check microphone access.' })),
    // Only ask about Calendar once titles are on; turning them on asks anyway.
    !calendarOn ? Promise.resolve(undefined)
      : (deps.calendar ?? (signal => calendarPermission({ ...(signal ? { signal } : {}) })))(options.signal)
        .catch((): HelperPermissionStatus => ({ authorization: 'unknown', detail: 'Could not check calendar access.' })),
  ]);
  const evidence = (deps.lastMeeting ?? lastMeetingEvidence)(options.libraryDir);
  const statuses: FeatureStatus[] = [];

  // Background recorder: the login agent plus a watcher that is actually alive.
  const login = (deps.launchAtLogin ?? meetingLaunchAtLoginStatus)();
  const watch = (deps.watchStatus ?? readBackgroundWatchStatus)(options.libraryDir);
  const alive = Boolean(watch && watch.phase !== 'unavailable' && watch.phase !== 'stopped');
  statuses.push({
    id: 'recorder', label: 'Background recorder', optional: false,
    ...(!automationOn ? { state: 'off', summary: 'Automatic recording is off',
      detail: 'Meetings are only recorded when you start them yourself.',
      fix: 'Turn automatic recording back on.', command: 'seashell meeting setup --automation automatic' } as const
    : !login.enabled || !login.loaded ? { state: 'broken', summary: 'Not running',
      detail: 'Nothing watches for meetings while this window is closed.',
      fix: 'Start it and keep it on at login.', action: 'enable-recorder', command: 'seashell meeting autostart enable' } as const
    : !alive ? { state: 'attention', summary: 'Not responding',
      detail: watch?.warning ?? 'The login agent is installed but the recorder has not reported in.',
      fix: 'Restart it.', action: 'enable-recorder', command: 'seashell meeting autostart enable' } as const
    : { state: 'ok', summary: watch?.phase === 'recording' ? 'Recording now' : 'Running · starts at login',
      detail: 'Watches for meetings in the background and records them automatically, even with this window closed.' } as const),
  });

  // Meeting detection: Meet's page state through Accessibility, for both the window and the background host.
  statuses.push({
    id: 'detection', label: 'Meeting detection', optional: false,
    ...(browser === 'off' ? { state: 'attention', summary: 'Google Meet not connected',
      detail: 'Meetings are only noticed from microphone use, and browser calls ask before recording.',
      fix: 'Connect Google Meet; macOS asks for Accessibility once.', action: 'connect-meet', command: 'seashell meeting speakers setup' } as const
    : meet?.state === 'permission' ? { state: 'broken', summary: 'Needs Accessibility access',
      detail: meet.detail, fix: 'Allow the Seashell entries macOS shows under Accessibility.', action: 'connect-meet', command: 'seashell meeting speakers setup' } as const
    // Trusted but momentarily unreadable (another desktop, a busy page) is set up correctly.
    : meet?.state === 'connected' || meet?.state === 'idle' || meet?.accessibilityTrusted === true ? { state: 'ok', summary: 'Google Meet · Chrome & Safari',
      detail: 'Starts recording when you join a Meet call and stops when you leave. Switching tabs or desktops keeps the recording going.' +
        (meet?.state === 'unavailable' ? ` Right now: ${meet.detail}` : '') } as const
    : { state: 'attention', summary: 'Could not confirm',
      detail: meet?.detail ?? 'Meeting detection could not be checked.', fix: 'Reconnect Google Meet.', action: 'connect-meet', command: 'seashell meeting speakers setup' } as const),
  });

  // Microphone: the helper's own permission, then what the last meeting heard.
  const recorderSince = (deps.microphoneRecorderSince ?? (() => {
    try { return statSync(microphoneRuntimeHelperPath()).mtimeMs; } catch { return undefined; }
  }))();
  const predatesRecorder = Boolean(evidence && recorderSince !== undefined && Date.parse(evidence.createdAt) < recorderSince);
  const micSilent = evidence && evidence.microphoneChunks > 0 && evidence.audibleMicrophoneChunks === 0 && !predatesRecorder;
  statuses.push({
    id: 'microphone', label: 'Your microphone', optional: false,
    ...(microphone.authorization === 'authorized'
      ? micSilent
        ? { state: 'attention', summary: 'Allowed · last meeting silent',
          detail: `Access is allowed, but nothing was heard from your microphone in "${evidence.title}" (${when(evidence)}).`,
          fix: 'Check System Settings → Sound → Input, and that your Mac is not muted for Meet.' } as const
        : { state: 'ok', summary: evidence?.audibleMicrophoneChunks ? 'Heard in last meeting'
            : predatesRecorder ? 'Allowed · your next meeting confirms it' : 'Allowed',
          detail: 'Records your side of the conversation as its own track, so your words are labelled as you.' +
            (predatesRecorder && !evidence?.audibleMicrophoneChunks
              ? ' Meetings recorded before this update could not hear you; that is fixed now.' : '') } as const
      : microphone.authorization === 'notDetermined'
        ? { state: 'broken', summary: 'Not allowed yet',
          detail: 'Until you allow it, background meetings record other people but not you.',
          fix: 'Choose Allow when macOS asks.', action: 'allow-microphone', command: 'seashell meeting microphone setup' } as const
        : microphone.authorization === 'denied'
          ? { state: 'broken', summary: 'Blocked in System Settings', detail: microphone.detail,
            fix: 'Turn on Seashell Microphone in Privacy & Security → Microphone.', action: 'allow-microphone', command: 'seashell meeting microphone setup' } as const
          : { state: 'broken', summary: microphone.authorization === 'unavailable' ? 'Recorder missing' : 'Could not check',
            detail: microphone.detail, fix: 'Update Seashell.', command: 'brew upgrade stupart/tap/seashell' } as const),
  });

  // Computer audio: no prompt-free permission check exists, so rely on evidence.
  const helperReady = (deps.systemAudioHelperReady ?? (() => existsSync(join(PROJECT_ROOT, 'native', 'bin', 'seashell-system-audio'))))();
  statuses.push({
    id: 'computer-audio', label: 'Other people (computer audio)', optional: false,
    ...(!helperReady ? { state: 'broken', summary: 'Recorder missing', detail: 'The computer-audio recorder is not installed.',
      fix: 'Update Seashell.', command: 'brew upgrade stupart/tap/seashell' } as const
    : evidence?.audibleComputerChunks ? { state: 'ok', summary: 'Heard in last meeting',
      detail: `Records everyone else from your Mac's audio output. Last meeting: "${evidence.title}" (${when(evidence)}).` } as const
    : evidence ? { state: 'attention', summary: 'Silent in last meeting',
      detail: `Nothing was heard from your computer in "${evidence.title}" (${when(evidence)}). macOS may need Screen & System Audio Recording access for Seashell Background.`,
      fix: 'Allow Seashell Background in Privacy & Security → Screen & System Audio Recording.' } as const
    : { state: 'attention', summary: 'Not confirmed yet',
      detail: 'Records everyone else from your Mac\'s audio output. It is confirmed after your first recorded meeting.' } as const),
  });

  const transcriptionReady = (deps.transcriptionReady ?? (() =>
    existsSync(join(PROJECT_ROOT, 'whisper.cpp', 'build', 'bin', 'whisper-cli')) &&
    existsSync(join(PROJECT_ROOT, 'models', DEFAULT_WHISPER_MODEL_FILENAME))))();
  statuses.push({
    id: 'transcription', label: 'Transcription', optional: false,
    ...(transcriptionReady ? { state: 'ok', summary: 'On this Mac',
      detail: 'Live text while you talk, then a more accurate final transcript after the meeting. Nothing is uploaded.' } as const
    : { state: 'broken', summary: 'Model missing', detail: 'The local speech model is not installed.',
      fix: 'Update Seashell.', command: 'brew upgrade stupart/tap/seashell' } as const),
  });

  const safariLast = evidence?.meetingKey?.startsWith('meet:safari:');
  statuses.push({
    id: 'meet-names', label: 'Speaker names from Meet', optional: true,
    ...(browser === 'off' ? { state: 'off', summary: 'Off', detail: 'Uses Google Meet\'s speaking indicators to suggest names.',
      fix: 'Connect Google Meet first.', action: 'connect-meet', command: 'seashell meeting speakers setup' } as const
    : { state: safariLast ? 'attention' : 'ok', summary: safariLast ? 'Chrome only · you used Safari' : 'Chrome only',
      detail: 'Suggests who is talking from Google Meet\'s speaking indicators. Works in Chrome; Safari is not supported yet. Keep Meet\'s People panel open while unmuted.',
      action: 'open-speakers' } as const),
  });

  const separation = (deps.speakerSeparationReady ?? (() => diarizationStatus().ready))();
  statuses.push({
    id: 'speaker-separation', label: 'Who said what', optional: true,
    ...(separation ? { state: 'ok', summary: 'Ready', action: 'open-speakers',
      detail: 'Separates the other voices in a meeting into Speaker 1, Speaker 2… on this Mac. You can rename them.' } as const
    : { state: 'off', summary: 'Not set up', action: 'open-speakers',
      detail: 'Separates the other voices in a meeting into Speaker 1, Speaker 2… on this Mac. Needs a free Hugging Face account to download the voice model once.',
      fix: 'Set up the voice model once.', command: 'seashell setup --speakers --login' } as const),
  });

  const engine = (deps.aiEngineInstalled ?? aiEngineInstalled)();
  const routes = currentMeetingRoutes(meeting);
  const mode = meeting?.mode ?? 'post-session';
  const aiConfigured = Boolean(routes.chat && (mode === 'streaming' || routes.reconciliation) &&
    (mode === 'post-session' || routes.observer));
  const backends = [...new Set(Object.values(routes).flatMap(route => route ? [route.backend] : []))];
  statuses.push({
    id: 'ai-notes', label: 'AI notes, summary & chat', optional: true,
    ...(!engine ? { state: 'off', summary: 'Not installed', action: 'open-ai',
      detail: 'Writes notes, decisions and action items after each meeting and answers questions about it.',
      fix: 'Install the AI engine.', command: 'seashell ai install <package.tgz>' } as const
    : aiConfigured ? { state: 'ok', summary: `Using ${backends.join(' + ')}`, action: 'open-ai',
      detail: 'Writes notes, decisions and action items after each meeting and answers questions about it.' } as const
    : { state: 'off', summary: 'No model chosen', action: 'open-ai',
      detail: 'Writes notes, decisions and action items after each meeting and answers questions about it. The engine is installed; choose which AI to use.',
      fix: 'Choose which AI writes your notes.', command: 'seashell ai setup' } as const),
  });

  const titlesDetail = 'Names each meeting after its calendar event (matched by its Meet link) and lists the attendees, which later helps name speakers.';
  statuses.push({
    id: 'calendar', label: 'Meeting titles from Calendar', optional: true,
    ...(!calendarOn ? { state: 'off', summary: 'Off · meetings are called "Google Meet"',
      detail: `${titlesDetail} macOS asks for Calendar access once.`,
      fix: 'Turn on calendar titles; macOS asks for Calendar access once.', action: 'allow-calendar',
      command: 'seashell meeting calendar setup' } as const
    : calendarAccess?.authorization !== 'authorized' ? { state: 'attention', summary: 'On · needs Calendar access',
      detail: calendarAccess?.detail ?? titlesDetail,
      fix: 'Allow Seashell Calendar when macOS asks.', action: 'allow-calendar', command: 'seashell meeting calendar setup' } as const
    : calendarAccess.calendars === 0 ? { state: 'attention', summary: 'On · no calendars on this Mac',
      detail: `${titlesDetail} This Mac has no calendars to read.`,
      fix: 'Add your work account in System Settings → Internet Accounts, with Calendars on.' } as const
    : { state: 'ok', summary: 'On', detail: titlesDetail } as const),
  });
  return statuses;
}

export const FEATURE_STATE_SYMBOL: Record<FeatureState, string> = { ok: '✓', attention: '!', off: '–', broken: '✗' };
export const FEATURE_STATE_COLOR: Record<FeatureState, 'green' | 'yellow' | 'gray' | 'red'> = {
  ok: 'green', attention: 'yellow', off: 'gray', broken: 'red',
};

/** Plain-text table for `seashell status`. */
export function renderFeatureStatusTable(statuses: readonly FeatureStatus[]): string {
  const width = Math.max(...statuses.map(status => status.label.length));
  const row = (status: FeatureStatus) => {
    const step = status.command ?? (status.action ? 'open Seashell and press ,' : undefined);
    const fix = status.state !== 'ok' && status.fix ? `\n    ${' '.repeat(width)}  → ${status.fix}${step ? ` (${step})` : ''}` : '';
    return `  ${FEATURE_STATE_SYMBOL[status.state]} ${status.label.padEnd(width)}  ${status.summary}${fix}`;
  };
  return [
    'Seashell status',
    ...statuses.filter(status => !status.optional).map(row),
    '',
    'Optional',
    ...statuses.filter(status => status.optional).map(row),
  ].join('\n');
}
