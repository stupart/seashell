import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, measureElement, useApp, useInput, useStdin, useStdout, type DOMElement } from 'ink';
import { execFileSync, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  readMacCalendarEventsAsync,
  suggestCalendarMeeting,
} from './calendar.ts';
import {
  defaultConfigPath,
  loadConfig,
  updateMeetingConfig,
  resolveLibraryDir,
  resolveMeetingRoute,
  resolveSaveByDefault,
} from './config.ts';
import {
  findTranscriptRecord,
  listTranscriptRecords,
  renameTranscriptSpeaker,
  saveTranscriptRecord,
  searchTranscriptRecords,
  trashTranscriptRecord,
  writeTranscriptExport,
  type TranscriptLibraryEntry,
} from './transcript-library.ts';
import { createTranscriptRecord } from './transcript-record.ts';
import { loadMeetingTemplates, meetingInstructions, NO_TEMPLATE } from './meeting-templates.ts';
import {
  createChatMessage,
  createMeetingArtifact,
  loadMeetingArtifact,
  saveMeetingArtifact,
  type MeetingArtifact,
  type MeetingCalendarEvent,
} from './meeting-artifact.ts';
import { chatWithMeeting, enrichMeeting } from './meeting-enrichment.ts';
import { Chalk } from 'chalk';
import { HEADING, meetingViewLines, plainMeetingLines, SUBHEADING, type MeetingView } from './meeting-tui.ts';
import { HELP_ROWS, HelpRow, KeyBar, Paragraph, Prompt, ScreenTitle, Sheet, Toast, withFix, type Hint, type TitleStatus } from './tui-chrome.tsx';
import { lastTranscriptScroll, timedTranscriptRows, transcriptWindow, wrappedMeetingRows, MouseScrollDecoder } from './transcript-viewport.ts';
import {
  renderText,
} from './transcript-renderer.ts';
import type { TranscriptFormat, TranscriptRecord } from './transcript-types.ts';
import { transcribeMedia } from './transcription-service.ts';
import {
  startSystemAudioCapture,
  type SystemAudioCaptureHandle,
  type LiveCaptureClock,
} from './live-system-audio.ts';
import {
  startMicrophoneCapture,
  type MicrophoneCaptureHandle,
} from './live-microphone.ts';
import { CaptureSessionStore, listRecoverableCaptureSessions } from './capture-session.ts';
import { finalizeCaptureTranscript, saveFinalizedCapture } from './capture-finalizer.ts';
import { reconcileLiveEcho } from './live-echo.ts';
import {
  LiveAsrScheduler,
  OwnedWhisperServer,
  type LocalAsrProfile,
} from './local-asr-scheduler.ts';
import { loadLocalAsrProfile } from './local-asr-profile.ts';
import {
  DEFAULT_TRANSCRIPTION_ROUTING,
  selectDraftTranscriptionRoute,
  selectCanonicalTranscriptionRoute,
  type TranscriptionRoute,
} from './transcription-routing.ts';
import AIProviderPicker from './AISettings.tsx';
import { providerName } from './ai-provider.ts';
import SpeakerSettings from './SpeakerSettings.tsx';
import SettingsScreen, { MENU_LABEL, type SettingsActions } from './SettingsScreen.tsx';
import Onboarding, { DEFAULT_LEVEL_SOURCES, switchedOff, type GuideProgress, type LevelSources, type SystemSettingsPane } from './Onboarding.tsx';
import { FEATURE_STATE_COLOR, FEATURE_STATE_SYMBOL, readFeatureStatuses, type FeatureId, type FeatureStatus } from './feature-status.ts';
import { stripVTControlCharacters } from 'util';
import { startMeetSpeakerReader, meetBrowserMatchesApp, probeMeetSpeakers, type MeetSpeakerReader, type MeetProbe } from './meet-speakers.ts';
import { backgroundMeetingMessage } from './background-meeting-status.ts';
import { readBackgroundWatchStatus, type BackgroundWatchStatus } from './background-watch-status.ts';
import { writeMeetingConsent } from './meeting-consent.ts';
import { writeMeetingCommand } from './meeting-command.ts';
import { CaptureHealthTracker, readMeetingCoverage, yourSideNotice, type CaptureHealthSnapshot } from './capture-health.ts';
import { captureRecordingMode, recordingSummary, sourceFinding, type RecordingMode } from './RecordingStatus.tsx';
import { diarizationStatus } from './diarization-environment.ts';
import { identifySavedSpeakers } from './speaker-reprocessing.ts';
import { runHumainTranscription } from './humain-client.ts';
import {
  DEFAULT_WHISPER_MODEL_FILENAME,
} from './model-config.ts';
import {
  meetingEntryRow,
  listWhen,
  meetingWhen,
  snippetAround,
  VIDEO_MARK,
  moveSelection,
  moveTranscriptScroll,
  formatTuiClock,
  speakerDisplayName,
  tuiLayout,
} from './tui-state.ts';
import {
  DEFAULT_MEETING_AUTOMATION,
  hasConfirmedMeetingEnd,
  preserveMeetingCandidateDuringObservationGap,
  MeetingAutomationController,
  MeetingSignalMonitor,
  resolveMeetingCandidate,
  type MeetingAutomationPhase,
  type MeetingCandidate,
  type MeetingSignalSnapshot,
} from './meeting-automation.ts';
import { acquireMeetingWatchLock, type MeetingWatchLock } from './watch-lock.ts';
import { applySpeakerLabels, EvidenceSpeakerLabeler } from './speaker-labeling.ts';
import { buildMeetingContext } from './meeting-context.ts';
import { afterMeetingReady, askAutomationApprovalWithDialog } from './automations.ts';
import { runAutomaticExtractors } from './extractors.ts';
import { meetingVideo, openMeetingVideo, videoMapIn } from './video-meeting.ts';
import { clearVideoRequest, startRecordingWithVideo } from './video-recording.ts';
import { speakerEngine, speakerModelSize } from './speaker-engine.ts';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(__filename), '..');
const WHISPER_SERVER = join(PROJECT_ROOT, 'whisper.cpp/build/bin/whisper-server');
const MODEL_PATH = join(PROJECT_ROOT, 'models', DEFAULT_WHISPER_MODEL_FILENAME);
const HIGHLIGHT = new Chalk({ level: 1 }).black.bgYellow;
/** Another match than the one n is on: in the same yellow, underlined rather than filled. */
const SOFT_HIGHLIGHT = new Chalk({ level: 1 }).yellow.underline;

type ListenerState = 'listening' | 'recording';
type View = 'live' | 'record';
type WatchOwnership = 'disabled' | 'checking' | 'owned' | 'external';

interface ProcessingState {
  label: string;
  progress?: number;
}

interface RenameState {
  speakerId: string;
  label: string;
  input: string;
}

interface ChatInputState {
  input: string;
}

type NavigationItem =
  | { kind: 'live'; label: string }
  | { kind: 'record'; label: string; entry: TranscriptLibraryEntry };

function cleanDroppedPath(raw: string): string | null {
  let value = raw.replace(/\x1b\[20[01]~/gu, '').trim();
  if (!value) return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\\(.)/gu, '$1');
  if (value.startsWith('~/') || value === '~') {
    value = (process.env.HOME ?? '') + value.slice(1);
  }
  return value.startsWith('/') ? value : null;
}

function liveTitle(now = new Date()): string {
  return `Live ${now.toLocaleDateString()} ${now.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function createLiveRecord(): TranscriptRecord {
  return createTranscriptRecord({
    transcript: [],
    speakers: [{ id: 'LOCAL', label: 'Microphone' }],
  }, {
    title: liveTitle(),
    source: { filename: 'Live capture session' },
  });
}

/** What each export is, in the words the key bar uses. */
const EXPORT_WORDS: Record<TranscriptFormat, string> = { srt: 'subtitles', vtt: 'subtitles', text: 'the text', json: 'the data' };

function truncate(value: string, width: number): string {
  if (width <= 1) return value.slice(0, Math.max(0, width));
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function useTerminalSize(): { columns: number; rows: number } {
  const read = () => ({
    columns: process.stdout.columns ?? 100,
    rows: process.stdout.rows ?? 30,
  });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  return size;
}

export default function App(props: {
  libraryDir?: string;
  /** Open on the guided setup, as `seashell setup` does. */
  guide?: boolean;
  /** Tests and journeys pass fakes: nothing here may open a real microphone, launch agent or System Settings. */
  levels?: LevelSources;
  setupActions?: SettingsActions;
  openSettings?: (pane: SystemSettingsPane) => void;
} = {}) {
  const { exit } = useApp();
  // No settings file yet: Seashell has never been set up on this Mac.
  const [firstRun] = useState(() => !existsSync(defaultConfigPath()));
  const [config, setConfig] = useState(() => loadConfig());
  const [speakerSetupOpen, setSpeakerSetupOpen] = useState(false);
  const [meetSpeakerStatus, setMeetSpeakerStatus] = useState<MeetProbe>();
  const [captureAppBundle, setCaptureAppBundle] = useState<string>();
  const [aiSetupOpen, setAiSetupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The row Settings opens on, when a fix in the title's status slot sent the person there. */
  const [settingsFocus, setSettingsFocus] = useState<FeatureId>();
  /** What the title's status slot showed last, for the key that fixes it. */
  const shownSlot = useRef<TitleStatus & { focus?: FeatureId }>(undefined);
  const [guideOpen, setGuideOpen] = useState(Boolean(props.guide));
  const [guideProgress, setGuideProgress] = useState<GuideProgress>();
  /** A test of one source from its Settings row, rather than the whole guide. */
  const [guideTest, setGuideTest] = useState<'microphone' | 'computer'>();
  // The guide offers itself once, on a first run that still needs it.
  const guideOffered = useRef(Boolean(props.guide));
  // Speakers and AI return to whatever opened them; the guide returns to Settings when started there.
  const [returnTo, setReturnTo] = useState<'settings' | 'guide'>();
  /** What just worked in speaker or AI setup, for Settings or the guide to say when it opens again. */
  const [subNotice, setSubNotice] = useState<string>();
  const [guideFromSettings, setGuideFromSettings] = useState(false);
  const [attention, setAttention] = useState<FeatureStatus[]>([]);
  /** Everything Settings checks, read once more whenever Settings or the guide closes. Speaker setup reads it too. */
  const [featureStatuses, setFeatureStatuses] = useState<FeatureStatus[]>();
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [aiSetupIntent, setAiSetupIntent] = useState<'notes' | 'chat' | null>(null);
  const libraryRoot = useMemo(
    () => resolveLibraryDir(props.libraryDir, process.env, config),
    [props.libraryDir, config],
  );
  const saveByDefault = useMemo(() => resolveSaveByDefault(config), [config]);
  const meetingAutomation = config.meeting?.automation ?? DEFAULT_MEETING_AUTOMATION;
  const automaticMeetingEnabled = meetingAutomation.enabled !== false &&
    (meetingAutomation.mode ?? DEFAULT_MEETING_AUTOMATION.mode) !== 'off';
  const initiallyPaused = automaticMeetingEnabled;
  const listenerDisabled = process.env.SEASHELL_DISABLE_LISTENER === '1';
  const systemAudioDisabled = listenerDisabled ||
    process.env.SEASHELL_DISABLE_SYSTEM_AUDIO === '1';
  const terminal = useTerminalSize();
  const layout = useMemo(
    () => tuiLayout(terminal.columns, terminal.rows),
    [terminal.columns, terminal.rows],
  );

  const [listenerState, setListenerState] = useState<ListenerState>('listening');
  const [transcribingCount, setTranscribingCount] = useState(0);
  const [paused, setPaused] = useState(initiallyPaused);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNoticeState] = useState<{ text: string; color: 'green' | 'yellow' } | null>(null);
  /** What just worked, in green in the key bar until the next key. */
  const setNotice = useCallback((text: string | null) => setNoticeState(text ? { text, color: 'green' } : null), []);
  /** Something to look at that is not a failure, in yellow. */
  const setCaution = useCallback((text: string) => setNoticeState({ text, color: 'yellow' }), []);
  const [backgroundWatch, setBackgroundWatch] = useState<BackgroundWatchStatus>();
  const [backgroundApproval, setBackgroundApproval] = useState<string>();
  const [audioHelpOpen, setAudioHelpOpen] = useState(false);
  const [statusNow, setStatusNow] = useState(Date.now());
  const [liveHealth, setLiveHealth] = useState<CaptureHealthSnapshot>();
  const liveHealthTracker = useRef<CaptureHealthTracker | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [processing, setProcessing] = useState<ProcessingState | null>(null);
  const [exitRequested, setExitRequested] = useState(false);
  const [libraryEntries, setLibraryEntries] = useState<TranscriptLibraryEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const [view, setView] = useState<View>('live');
  const [selectedRecord, setSelectedRecord] = useState<TranscriptRecord | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingArtifact | null>(null);
  const [liveMeeting, setLiveMeeting] = useState<MeetingArtifact | null>(null);
  const [meetingView, setMeetingView] = useState<MeetingView>('transcript');
  const [chatInputState, setChatInputState] = useState<ChatInputState | null>(null);
  /** [G] Notes setup for the open meeting: its template, its note, and whether AI may see it. Enter writes the notes.
   * `opened` is the meeting's AI choices when the sheet opened, so leaving says something only after a change. */
  const [notesSetup, setNotesSetup] = useState<{ row: 0 | 1 | 2; options: string[]; editing?: string; opened: string } | null>(null);
  const [calendarSuggestion, setCalendarSuggestion] = useState<MeetingCalendarEvent | null>(null);
  const [automaticCandidate, setAutomaticCandidate] = useState<MeetingCandidate | null>(null);
  const [automationPhase, setAutomationPhase] = useState<MeetingAutomationPhase>('watching');
  const [automaticFinishRequested, setAutomaticFinishRequested] = useState(false);
  const automaticTransition = useRef(false);
  const [watchOwnership, setWatchOwnership] = useState<WatchOwnership>(
    automaticMeetingEnabled ? 'checking' : 'disabled',
  );
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [transcriptScroll, setTranscriptScroll] = useState(0);
  const [followLiveTranscript, setFollowLiveTranscript] = useState(true);
  const transcriptPaneRef = useRef<DOMElement>(null);
  const [transcriptContentRows, setTranscriptContentRows] = useState<number>();
  const [transcriptContentColumns, setTranscriptContentColumns] = useState<number>();
  useEffect(() => {
    if (!transcriptPaneRef.current) return;
    const measured = measureElement(transcriptPaneRef.current);
    const rows = Math.max(1, Math.floor(measured.height));
    const columns = Math.max(1, Math.floor(measured.width));
    setTranscriptContentColumns((previous) => previous === columns ? previous : columns);
    setTranscriptContentRows((previous) => previous === rows ? previous : rows);
  });
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [showSpeakers, setShowSpeakers] = useState(true);
  const [speakerSelection, setSpeakerSelection] = useState(0);
  const [renameState, setRenameState] = useState<RenameState | null>(null);
  const [speakerPickerOpen, setSpeakerPickerOpen] = useState(false);
  const [confirmRewrite, setConfirmRewrite] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  /** Opened from a search: which match is at the top of the transcript; n moves to the next. */
  const [searchHit, setSearchHit] = useState<number | null>(null);
  const [exportMode, setExportMode] = useState(false);
  const [helpMode, setHelpMode] = useState(false);
  const [confirmTrashId, setConfirmTrashId] = useState<string | null>(null);
  const [liveRecord, setLiveRecord] = useState<TranscriptRecord>(() => createLiveRecord());

  const microphoneCapture = useRef<MicrophoneCaptureHandle | null>(null);
  const systemAudioCapture = useRef<SystemAudioCaptureHandle | null>(null);
  const captureSessionStore = useRef<CaptureSessionStore | null>(null);
  const meetSpeakerReader = useRef<MeetSpeakerReader | null>(null);
  const localAsrServer = useRef<OwnedWhisperServer | null>(null);
  const localAsrScheduler = useRef<LiveAsrScheduler | null>(null);
  const cloudAsrScheduler = useRef<LiveAsrScheduler | null>(null);
  const liveSessionGeneration = useRef(0);
  const isExiting = useRef(false);
  const exitInProgress = useRef(false);
  const pausedRef = useRef(initiallyPaused);
  const liveRecordRef = useRef(liveRecord);
  const liveMeetingRef = useRef<MeetingArtifact | null>(null);
  const observerActiveRef = useRef(false);
  const liveSessionStartedAt = useRef<number | null>(null);
  const calendarSuggestionRef = useRef<MeetingCalendarEvent | null>(null);
  const meetingAutomationController = useRef(new MeetingAutomationController(meetingAutomation));
  const meetingSignalFailure = useRef<string | null>(null);
  const meetingWatchLock = useRef<MeetingWatchLock | null>(null);
  /** The app a call this window recorded ran in, for automations that filter by app. */
  const liveAppName = useRef<string | undefined>(undefined);

  const refreshLibrary = useCallback(() => {
    setLibraryEntries(listTranscriptRecords(libraryRoot));
    setBackgroundWatch(readBackgroundWatchStatus(libraryRoot));
  }, [libraryRoot]);

  useEffect(() => {
    const interval = setInterval(() => setStatusNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    refreshLibrary();
    const recoverable = listRecoverableCaptureSessions(libraryRoot);
    if (recoverable.length > 0) {
      setCaution(`${recoverable.length} recoverable live capture${recoverable.length === 1 ? '' : 's'} found · run seashell capture list`);
    }
  }, [refreshLibrary]);

  useEffect(() => {
    if (!automaticMeetingEnabled || listenerDisabled) {
      setWatchOwnership('disabled');
      return;
    }
    const lock = acquireMeetingWatchLock();
    if (!lock) {
      setWatchOwnership('external');
      if (!layout.compact) setHistoryOpen(true);
      const interval = setInterval(refreshLibrary, 1_000);
      return () => clearInterval(interval);
    }
    meetingWatchLock.current = lock;
    setWatchOwnership('owned');
    return () => {
      lock.release();
      meetingWatchLock.current = null;
    };
  }, [automaticMeetingEnabled, listenerDisabled, refreshLibrary]);

  const visibleEntries = useMemo(
    () => searchQuery.trim()
      ? searchTranscriptRecords(libraryRoot, searchQuery)
      : libraryEntries,
    [libraryEntries, libraryRoot, searchQuery],
  );
  const navigationItems: NavigationItem[] = useMemo(() => [
    // With a background recorder there is nothing live here: its meeting is a row like any other.
    ...(watchOwnership === 'external' ? [] : [{
      kind: 'live' as const,
      label: paused ? 'Live transcription' : '● Live transcription',
    }]),
    ...visibleEntries.map((entry) => ({
      kind: 'record' as const,
      label: entry.title,
      entry,
    })),
  ], [paused, visibleEntries, watchOwnership]);

  // Reload an open background transcript when the watcher publishes it.
  useEffect(() => {
    if (watchOwnership !== 'external' || view !== 'record' || !selectedRecord || processing) return;
    try {
      setSelectedRecord(findTranscriptRecord(libraryRoot, selectedRecord.id).record);
      setSelectedMeeting(loadMeetingArtifact(libraryRoot, selectedRecord.id) ?? null);
    } catch { /* The user may have just removed this entry. */ }
  }, [libraryEntries, libraryRoot, watchOwnership, view, selectedRecord?.id, processing]);

  // The cursor stays on its meeting when a new one arrives above it.
  useEffect(() => {
    const open = navigationItems.findIndex((item) => item.kind === 'record' && item.entry.id === selectedRecord?.id);
    setSelectionIndex((current) => (open >= 0 ? open : moveSelection(current, 0, navigationItems.length)));
  }, [navigationItems, selectedRecord?.id]);

  const cleanupFile = useCallback((path: string) => {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {}
  }, []);

  const appendLiveSegment = useCallback((segment: TranscriptRecord['transcript'][number]) => {
    if (!/[\p{L}\p{N}]/u.test(segment.text)) return;
    const meetSpeaker = meetSpeakerReader.current?.speakerFor(segment);
    if (meetSpeaker) segment = { ...segment, speaker: meetSpeaker.id, speakerSource: meetSpeaker.source ?? 'google-meet-dom' };
    const current = liveRecordRef.current;
    const nextSpeakers = segment.speaker && !current.speakers.some(
      (speaker) => speaker.id === segment.speaker,
    )
      ? [
          ...current.speakers,
          {
            id: segment.speaker,
            label: meetSpeaker?.label ?? (segment.speaker === 'LOCAL'
              ? 'Microphone'
              : segment.speaker === 'SYSTEM'
                ? 'System audio'
                : segment.speaker),
          },
        ]
      : current.speakers;
    const next: TranscriptRecord = {
      ...current,
      updatedAt: new Date().toISOString(),
      speakers: nextSpeakers,
      ...(meetSpeaker ? { speakerAnalysis: { status: 'platform-hints' as const,
        detail: 'Names suggested by Google Meet speaking indicators; review speaker changes and overlap.' } } : {}),
      transcript: [...reconcileLiveEcho(current.transcript, segment)],
    };
    liveRecordRef.current = next;
    setLiveRecord(next);
    if (saveByDefault || liveMeetingRef.current) {
      try {
        const saved = saveTranscriptRecord(libraryRoot, next);
        if (saved.meetingWarning) setCaution(saved.meetingWarning);
        if (liveMeetingRef.current) {
          const meeting = loadMeetingArtifact(libraryRoot, next.id) ?? null;
          liveMeetingRef.current = meeting;
          setLiveMeeting(meeting);
        }
        refreshLibrary();
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      }
    }
  }, [libraryRoot, refreshLibrary, saveByDefault]);

  const transcribeLiveChunk = useCallback((
    audioFile: string,
    start: number,
    end: number,
    speaker: 'LOCAL' | 'SYSTEM',
    sessionGeneration = liveSessionGeneration.current,
    cleanupAfter = true,
  ) => {
    if (!existsSync(audioFile)) return;
    try {
      if (statSync(audioFile).size < 1000) {
        if (cleanupAfter) cleanupFile(audioFile);
        return;
      }
    } catch {
      return;
    }

    const updateDepth = () => setTranscribingCount(
      (localAsrScheduler.current?.depth ?? 0) + (cloudAsrScheduler.current?.depth ?? 0),
    );
    const routing = config.transcription ?? DEFAULT_TRANSCRIPTION_ROUTING;
    let selectedRoute: TranscriptionRoute;
    try {
      selectedRoute = selectDraftTranscriptionRoute(
        routing,
        localAsrScheduler.current?.depth ?? 0,
      );
    } catch (routeError) {
      setError(routeError instanceof Error ? routeError.message : String(routeError));
      selectedRoute = 'local';
    }
    if (selectedRoute === 'local' && !localAsrServer.current) {
      const selected = loadLocalAsrProfile(MODEL_PATH);
      const profile: LocalAsrProfile = {
        id: selected.id,
        modelPath: selected.modelPath,
        threads: selected.threads,
        requestTimeoutMs: 120_000,
        idleTimeoutMs: 60_000,
        disableGpu: process.env.SEASHELL_DISABLE_GPU === '1',
      };
      localAsrServer.current = new OwnedWhisperServer(WHISPER_SERVER, profile);
    }
    if (selectedRoute === 'local' && !localAsrScheduler.current) {
      localAsrScheduler.current = new LiveAsrScheduler({
        maxPending: 4,
        transcribe: async (path, signal) => await localAsrServer.current!.transcribe(path, signal),
        onDepth: updateDepth,
      });
    }
    if (selectedRoute === 'cloud' && !cloudAsrScheduler.current) {
      const cloud = routing.cloud;
      if (!cloud?.uploadConsent) {
        setError('Cloud draft routing requires explicit upload consent.');
        return;
      }
      cloudAsrScheduler.current = new LiveAsrScheduler({
        maxPending: 8,
        maxConcurrent: 2,
        transcribe: async (path, signal) => {
          const result = await runHumainTranscription(path, {
            model: cloud.model,
            ...(cloud.upstreamProvider === undefined ? {} : { upstreamProvider: cloud.upstreamProvider }),
            ...(cloud.maxCostMicrousd === undefined ? {} : { maxCostMicrousd: cloud.maxCostMicrousd }),
            uploadConsent: true,
          }, {
            storeDir: join(libraryRoot, '_Humain'),
            runId: `live-${liveRecordRef.current.id}-${randomUUID()}`,
            signal,
          });
          return result.output.segments.map((segment) => segment.text).join(' ').trim();
        },
        onDepth: updateDepth,
      });
    }
    const scheduler = selectedRoute === 'cloud'
      ? cloudAsrScheduler.current
      : localAsrScheduler.current;
    if (!scheduler) return;
    void scheduler.enqueue({
      id: `${sessionGeneration}:${speaker}:${start.toFixed(3)}:${end.toFixed(3)}`,
      audioFile,
      start,
      end,
      speaker,
      sessionGeneration,
    }).then((result) => {
      if (result.status === 'completed' && result.text &&
          sessionGeneration === liveSessionGeneration.current && !isExiting.current) {
        appendLiveSegment({ start, end: Math.max(start, end), text: result.text, speaker });
      }
    }).catch((transcriptionError: unknown) => {
      setError(`Live transcription failed: ${
        transcriptionError instanceof Error ? transcriptionError.message : String(transcriptionError)
      }`);
    }).finally(() => {
      if (cleanupAfter) cleanupFile(audioFile);
    });
  }, [appendLiveSegment, cleanupFile, config.transcription, libraryRoot]);

  const ensureLiveSessionStartedAt = useCallback(() => {
    if (liveSessionStartedAt.current === null) {
      const startedAt = Date.now();
      const now = new Date(startedAt);
      liveSessionStartedAt.current = startedAt;
      const record = {
        ...liveRecordRef.current,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        title: liveMeetingRef.current ? liveRecordRef.current.title : liveTitle(now),
      };
      liveRecordRef.current = record;
      setLiveRecord(record);
    }
    return liveSessionStartedAt.current;
  }, []);

  const ensureCaptureStore = useCallback((generation: number) => {
    if (generation !== liveSessionGeneration.current) return null;
    if (
      !captureSessionStore.current ||
      captureSessionStore.current.manifest.sessionId !== liveRecordRef.current.id
    ) {
      captureSessionStore.current = new CaptureSessionStore({
        libraryDir: libraryRoot,
        sessionId: liveRecordRef.current.id,
        startedAtUnixMs: ensureLiveSessionStartedAt(),
        createdAt: liveRecordRef.current.createdAt,
      });
    }
    return captureSessionStore.current;
  }, [ensureLiveSessionStartedAt, libraryRoot]);

  const persistLiveChunk = useCallback((options: {
    path: string;
    source: 'microphone' | 'system-audio';
    startSeconds: number;
    endSeconds: number;
    audible: boolean;
    clock: LiveCaptureClock;
    generation: number;
  }): Promise<Awaited<ReturnType<CaptureSessionStore['commitChunkAsync']>> | null> => {
    const store = ensureCaptureStore(options.generation);
    if (!store) {
      cleanupFile(options.path);
      return Promise.resolve(null);
    }
    return store.commitChunkAsync({
        sourcePath: options.path,
        trackId: options.source,
        startSeconds: options.startSeconds,
        endSeconds: options.endSeconds,
        audible: options.audible,
        clock: options.clock,
      }).catch((captureError: unknown) => {
      cleanupFile(options.path);
      setError(`Could not preserve live audio: ${
        captureError instanceof Error ? captureError.message : String(captureError)
      }`);
      return null;
    });
  }, [cleanupFile, ensureCaptureStore]);

  const startSystemListener = useCallback(() => {
    if (systemAudioDisabled || isExiting.current || pausedRef.current) return;
    systemAudioCapture.current?.stop();
    const generation = liveSessionGeneration.current;
    const healthTracker = liveHealthTracker.current;
    const capture = startSystemAudioCapture({
      startAfter: microphoneCapture.current?.startup,
      sessionStartedAtUnixMs: ensureLiveSessionStartedAt(),
      onChunk: (chunk) => {
        void persistLiveChunk({ ...chunk, generation }).then((committed) => {
          if (!committed || !chunk.audible) return;
          transcribeLiveChunk(
            committed.path,
            chunk.startSeconds,
            chunk.endSeconds,
            'SYSTEM',
            generation,
            false,
          );
        });
      },
      onDiscontinuity: (event) => {
        const store = ensureCaptureStore(generation);
        if (!store) return;
        void store.recordDiscontinuityAsync({
          trackId: 'system-audio',
          atSeconds: event.atFrame / 16_000,
          durationSeconds: event.durationFrames / 16_000,
          reason: event.reason,
        }).catch((gapError: unknown) => {
          setError(`Could not preserve a capture gap: ${
            gapError instanceof Error ? gapError.message : String(gapError)
          }`);
        });
      },
      onLevel: (level) => {
        if (generation !== liveSessionGeneration.current || healthTracker !== liveHealthTracker.current) return;
        if (healthTracker) setLiveHealth(healthTracker.pcm('systemAudio', level));
      },
      onWarning: (message) => setCaution(message),
      onState: (update) => {
        if (generation !== liveSessionGeneration.current || healthTracker !== liveHealthTracker.current) return;
        if (healthTracker) setLiveHealth(healthTracker.state('systemAudio', update));
        if (update.state === 'unavailable' && update.message) {
          setCaution(`System audio unavailable; continuing with microphone only. ${update.message}`);
        }
      },
    });
    systemAudioCapture.current = capture;
  }, [ensureCaptureStore, ensureLiveSessionStartedAt, persistLiveChunk, systemAudioDisabled, transcribeLiveChunk]);

  const startListener = useCallback(() => {
    if (listenerDisabled || isExiting.current || pausedRef.current) return;
    microphoneCapture.current?.stop();
    const sessionGeneration = liveSessionGeneration.current;
    const healthTracker = new CaptureHealthTracker({ systemAudio: !systemAudioDisabled });
    liveHealthTracker.current = healthTracker;
    setLiveHealth(healthTracker.snapshot);
    const capture = startMicrophoneCapture({
      sessionStartedAtUnixMs: ensureLiveSessionStartedAt(),
      onChunk: (chunk) => {
        void persistLiveChunk({ ...chunk, generation: sessionGeneration }).then((committed) => {
          if (!committed || !chunk.audible) return;
          transcribeLiveChunk(
            committed.path,
            chunk.startSeconds,
            chunk.endSeconds,
            'LOCAL',
            sessionGeneration,
            false,
          );
        });
      },
      onLevel: (level) => {
        if (sessionGeneration !== liveSessionGeneration.current || healthTracker !== liveHealthTracker.current) return;
        setLiveHealth(healthTracker.pcm('microphone', level));
        setListenerState(level.rmsDbfs >= -55 ? 'recording' : 'listening');
      },
      onState: (update) => {
        if (sessionGeneration !== liveSessionGeneration.current || healthTracker !== liveHealthTracker.current) return;
        setLiveHealth(healthTracker.state('microphone', update));
      },
    });
    microphoneCapture.current = capture;
  }, [ensureLiveSessionStartedAt, listenerDisabled, persistLiveChunk, systemAudioDisabled, transcribeLiveChunk]);

  useEffect(() => {
    if (listenerDisabled) return;
    startListener();
    return () => {
      isExiting.current = true;
      microphoneCapture.current?.stop();
      void localAsrScheduler.current?.stop();
      void cloudAsrScheduler.current?.stop();
      void localAsrServer.current?.stop();
    };
  }, [listenerDisabled, startListener]);

  useEffect(() => {
    if (systemAudioDisabled) return;
    startSystemListener();
    return () => {
      systemAudioCapture.current?.stop();
      systemAudioCapture.current = null;
    };
  }, [startSystemListener, systemAudioDisabled]);

  useEffect(() => {
    const browser = config.meeting?.speakerBrowser;
    if (paused || systemAudioDisabled || !browser || browser === 'off' || !meetBrowserMatchesApp(browser, captureAppBundle)) return;
    const store = ensureCaptureStore(liveSessionGeneration.current);
    if (!store) return;
    setMeetSpeakerStatus(undefined);
    const reader = startMeetSpeakerReader({ browser, store, onStatus: setMeetSpeakerStatus });
    meetSpeakerReader.current = reader;
    return () => { reader.stop(); if (meetSpeakerReader.current === reader) meetSpeakerReader.current = null; };
  }, [paused, systemAudioDisabled, config.meeting?.speakerBrowser, captureAppBundle, liveRecord.id, ensureCaptureStore]);

  const setListeningPaused = useCallback((nextPaused: boolean) => {
    pausedRef.current = nextPaused;
    setPaused(nextPaused);
    if (nextPaused) {
      meetSpeakerReader.current?.stop();
      const captureHandles = [microphoneCapture.current, systemAudioCapture.current]
        .filter((handle): handle is MicrophoneCaptureHandle | SystemAudioCaptureHandle => Boolean(handle));
      microphoneCapture.current?.stop();
      microphoneCapture.current = null;
      setListenerState('listening');
      systemAudioCapture.current?.stop();
      systemAudioCapture.current = null;
      void Promise.all(captureHandles.map((handle) => handle.done)).then(async () => {
        await captureSessionStore.current?.drainCommits();
        if (pausedRef.current) captureSessionStore.current?.setStatus('paused');
      });
    } else if (!microphoneCapture.current) {
      captureSessionStore.current?.setStatus('recording');
      startListener();
      startSystemListener();
    } else if (!systemAudioCapture.current) {
      startSystemListener();
    }
  }, [startListener, startSystemListener, systemAudioDisabled]);

  const importMedia = useCallback((filePath: string, withSpeakers: boolean) => {
    if (processing) return;
    const wasListening = !pausedRef.current;
    setListeningPaused(true);
    setError(null);
    setNotice(null);
    setProcessing({ label: 'Inspecting media…' });

    void (async () => {
      try {
        const record = await transcribeMedia(filePath, {
          speakers: withSpeakers,
          routing: config.transcription,
          humainStoreDir: join(libraryRoot, '_Humain'),
          onStatus: (label) => setProcessing((current) => ({ ...current, label })),
          onWhisperProgress: (progress) => setProcessing({
            label: 'Transcribing…',
            progress,
          }),
          onWhisperFallback: (label) => setProcessing({ label }),
          onDiarizationMessage: () => setProcessing({ label: 'Identifying speakers…' }),
        });
        setProcessing({ label: 'Saving transcript…' });
        saveTranscriptRecord(libraryRoot, record);
        setSelectedRecord(record);
        setSelectedMeeting(null);
        setView('record');
        setHistoryOpen(false);
        setTranscriptScroll(0);
        setSpeakerSelection(0);
        refreshLibrary();
        setNotice('Saved transcript.');
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : String(importError));
      } finally {
        setProcessing(null);
        if (wasListening) setListeningPaused(false);
      }
    })();
  }, [config.transcription, libraryRoot, processing, refreshLibrary, setListeningPaused]);

  const pickMedia = useCallback((withSpeakers: boolean) => {
    if (withSpeakers && !diarizationStatus().ready) {
      setSpeakerSetupOpen(true);
      return;
    }
    const script = `
      set theFile to choose file with prompt "Select audio or video to transcribe" of type {"public.audio", "public.movie", "public.mpeg-4"}
      return POSIX path of theFile
    `;
    try {
      const filePath = execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
      if (filePath) importMedia(filePath, withSpeakers);
    } catch {
      setNotice('Import cancelled.');
    }
  }, [importMedia]);

  const openRecord = useCallback((entry: TranscriptLibraryEntry) => {
    try {
      const meeting = loadMeetingArtifact(libraryRoot, entry.id) ?? null;
      setSelectedRecord(findTranscriptRecord(libraryRoot, entry.id).record);
      setSelectedMeeting(meeting);
      setView('record');
      // Notes are what people come back for, and where they are asked for.
      // While a call is running there are no notes yet, only its words.
      setMeetingView(meeting && entry.captureState !== 'recording' && entry.captureState !== 'processing' ? 'notes' : 'transcript');
      setTranscriptScroll(0);
      setFollowLiveTranscript(true);
      setSpeakerSelection(0);
      setError(null);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  }, [libraryRoot]);

  const showNavigationItem = useCallback((item: NavigationItem | undefined) => {
    if (!item) return;
    if (item.kind === 'live') {
      setView('live');
      setFollowLiveTranscript(true);
      setTranscriptScroll(0);
      setError(null);
      return;
    }
    openRecord(item.entry);
  }, [openRecord]);

  const toggleHistory = useCallback(() => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    const freshEntries = listTranscriptRecords(libraryRoot);
    setLibraryEntries(freshEntries);
    const entries = searchQuery.trim() ? searchTranscriptRecords(libraryRoot, searchQuery) : freshEntries;
    const offset = watchOwnership === 'external' ? 0 : 1;
    const currentIndex = view === 'record' && selectedRecord
      ? entries.findIndex((entry) => entry.id === selectedRecord.id) + offset
      : 0;
    setSelectionIndex(currentIndex >= 0 ? currentIndex : 0);
    setHistoryOpen(true);
  }, [historyOpen, libraryRoot, searchQuery, selectedRecord, view, watchOwnership]);

  const currentRecord = view === 'live' ? liveRecord : selectedRecord;
  const currentMeeting = view === 'live' ? liveMeeting : selectedMeeting;
  const currentEntry = view === 'record' ? libraryEntries.find(entry => entry.id === selectedRecord?.id) : undefined;
  const activeBackgroundEntry = watchOwnership === 'external'
    ? libraryEntries.find(entry => entry.id === backgroundWatch?.sessionId && entry.captureState === 'recording') ??
      libraryEntries.find(entry => entry.captureState === 'recording') : undefined;
  const followedBackgroundId = useRef<string | undefined>(undefined);
  const backgroundEntry = view === 'record' ? currentEntry : activeBackgroundEntry;
  const currentRecordBusy = currentEntry?.captureState === 'recording' || currentEntry?.captureState === 'processing';
  const backgroundRecording = backgroundEntry?.captureState === 'recording';
  const showBackgroundStatus = (watchOwnership === 'external' && view === 'live') || Boolean(currentEntry?.captureState);
  // The newest meeting opens by itself, and giving way to a call that starts is part of that.
  const openedOnLaunch = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (watchOwnership !== 'external' || openedOnLaunch.current || view !== 'live' || activeBackgroundEntry) return;
    const newest = libraryEntries[0];
    if (!newest) return;
    openedOnLaunch.current = newest.id;
    openRecord(newest);
    setSelectionIndex(0);
  }, [watchOwnership, view, activeBackgroundEntry, libraryEntries, openRecord]);
  useEffect(() => {
    if (watchOwnership !== 'external' || !activeBackgroundEntry || followedBackgroundId.current === activeBackgroundEntry.id) return;
    // Never swap the meeting out from under someone who is typing about it.
    if (chatInputState || renameState || searchMode) return;
    if (view === 'live' || selectedRecord?.id === followedBackgroundId.current || selectedRecord?.id === openedOnLaunch.current) {
      openRecord(activeBackgroundEntry);
      setSelectionIndex(Math.max(0, navigationItems.findIndex(item => item.kind === 'record' && item.entry.id === activeBackgroundEntry.id)));
      setFollowLiveTranscript(true);
      // A list open beside a call only gets in the way of reading it.
      setHistoryOpen(false);
    }
    followedBackgroundId.current = activeBackgroundEntry.id;
  }, [watchOwnership, view, activeBackgroundEntry?.id, selectedRecord?.id, openRecord, navigationItems]);
  const backgroundMessage = view === 'record'
    ? backgroundMeetingMessage(currentEntry?.captureState)
    : undefined;
  const drawerOnly = historyOpen && layout.compact;
  const mainPanelColumns = historyOpen && !drawerOnly
    ? terminal.columns - layout.sidebarWidth - 4
    : terminal.columns - 2;
  const contentColumns = transcriptContentColumns ?? Math.max(1, mainPanelColumns);
  const timedRows = useMemo(() => currentRecord
    ? timedTranscriptRows(currentRecord, contentColumns, { timestamps: showTimestamps, speakers: showSpeakers })
    : [], [currentRecord, contentColumns, showTimestamps, showSpeakers]);
  const displayRows = useMemo(() => timedRows.map((row) => row.text), [timedRows]);
  const visibleRows = Math.max(1, transcriptContentRows ?? layout.visibleTranscriptRows);
  // A search shows the line that matched under each meeting, so the list holds half as many.
  const listCapacity = Math.max(1, Math.floor(layout.visibleLibraryItems / (searchQuery.trim() ? 2 : 1)));
  const sidebarStart = Math.max(0, selectionIndex - listCapacity + 1);
  // Meetings kept with their video show ▶ in the list; each is looked up once per change.
  const videoLookups = useRef(new Map<string, boolean>());
  const videoEntries = useMemo(() => new Set(libraryEntries.filter((entry) => {
    if (entry.captureState === 'recording' || entry.captureState === 'processing') return false;
    const key = `${entry.directory}:${entry.updatedAt}`;
    if (!videoLookups.current.has(key)) {
      try { videoLookups.current.set(key, Boolean(videoMapIn(entry.directory))); } catch { videoLookups.current.set(key, false); }
    }
    return videoLookups.current.get(key);
  }).map((entry) => entry.id)), [libraryEntries]);
  const showingLiveTranscript = meetingView === 'transcript' && (view === 'live' || currentEntry?.captureState === 'recording');
  const latestTranscriptScroll = lastTranscriptScroll(timedRows, visibleRows);
  // The first row of every line that says what was searched for, so a match opens with its whole line at the top.
  const matchRows = useMemo(() => {
    const needle = searchQuery.trim().toLocaleLowerCase();
    if (!needle || meetingView !== 'transcript') return [];
    const lines = new Map<number | undefined, { first: number; text: string }>();
    timedRows.forEach((row, index) => {
      const line = lines.get(row.start);
      if (line) line.text += ` ${stripVTControlCharacters(row.text).trim()}`;
      else lines.set(row.start, { first: index, text: stripVTControlCharacters(row.text) });
    });
    // A phrase can wrap across rows, so the line is read whole.
    return [...lines.values()].filter((line) => line.text.replace(/\s+/gu, ' ').toLocaleLowerCase().includes(needle)).map((line) => line.first);
  }, [timedRows, searchQuery, meetingView]);
  // Choosing among search results, the reader shows the chosen meeting's lines that say it, whole.
  const searchPane = historyOpen && !drawerOnly && Boolean(searchQuery.trim()) && view === 'record'
    && visibleEntries.some((entry) => entry.id === selectedRecord?.id);
  const searchLines = useMemo(() => {
    const needle = searchQuery.trim().toLocaleLowerCase();
    if (!searchPane || !needle) return [];
    const lines = new Map<number | undefined, { rows: string[]; text: string }>();
    timedRows.forEach((row) => {
      const line = lines.get(row.start);
      if (line) { line.rows.push(row.text); line.text += ` ${stripVTControlCharacters(row.text).trim()}`; }
      else lines.set(row.start, { rows: [row.text], text: stripVTControlCharacters(row.text) });
    });
    return [...lines.values()].filter((line) => line.text.replace(/\s+/gu, ' ').toLocaleLowerCase().includes(needle));
  }, [timedRows, searchQuery, searchPane]);
  // The match n is on: its line starts at the top of the view, even near the end, where the view runs past the last row.
  const currentMatch = searchHit !== null && matchRows.length ? matchRows[searchHit % matchRows.length]! : undefined;
  const visibleTranscriptScroll = showingLiveTranscript && followLiveTranscript
    ? latestTranscriptScroll
    : Math.min(transcriptScroll, Math.max(latestTranscriptScroll, currentMatch ?? 0));
  // A line cut at the top keeps its time and speaker in view.
  const visibleTranscriptRows = transcriptWindow(timedRows, visibleTranscriptScroll, visibleRows);
  // The rows rewrap once the list closes, so the match is found again whenever they do.
  useEffect(() => {
    if (currentMatch !== undefined) setTranscriptScroll(currentMatch);
  }, [searchHit, matchRows]);
  // Finished notes arrive by themselves; say so, and show them unless someone is reading.
  const notesStatus = useRef<{ id?: string; status?: string }>({});
  useEffect(() => {
    const previous = notesStatus.current;
    notesStatus.current = { id: selectedMeeting?.meetingId, status: selectedMeeting?.status };
    if (previous.id !== selectedMeeting?.meetingId || previous.status === 'ready' || selectedMeeting?.status !== 'ready' || !previous.status) return;
    setNotice('Notes ready.');
    if (followLiveTranscript) setMeetingView('notes');
  }, [selectedMeeting?.meetingId, selectedMeeting?.status, followLiveTranscript]);
  const configuredMeetingRoutes = useMemo(() => ({
    observer: resolveMeetingRoute(config.meeting, 'observer'),
    reconciliation: resolveMeetingRoute(config.meeting, 'reconciliation'),
    chat: resolveMeetingRoute(config.meeting, 'chat'),
  }), [config.meeting]);

  const commitMeetingState = useCallback((artifact: MeetingArtifact) => {
    if (view === 'live') {
      liveMeetingRef.current = artifact;
      setLiveMeeting(artifact);
    } else {
      setSelectedMeeting(artifact);
    }
  }, [view]);

  const markCurrentAsMeeting = useCallback((calendar?: MeetingCalendarEvent) => {
    if (!currentRecord) return;
    try {
      saveTranscriptRecord(libraryRoot, currentRecord);
      const existing = loadMeetingArtifact(libraryRoot, currentRecord.id);
      const artifact = existing ?? createMeetingArtifact(currentRecord, {
        mode: config.meeting?.mode ?? 'hybrid',
        ...(calendar ? { calendar } : {}),
        maxObserverRuns: config.meeting?.maxObserverRuns,
      });
      saveMeetingArtifact(libraryRoot, artifact);
      commitMeetingState(artifact);
      setMeetingView('transcript');
      setCalendarSuggestion(null);
      refreshLibrary();
      setNotice(calendar ? `Meeting attached: ${calendar.title}.` : null);
    } catch (meetingError) {
      setError(meetingError instanceof Error ? meetingError.message : String(meetingError));
    }
  }, [commitMeetingState, config.meeting, currentRecord, libraryRoot, refreshLibrary]);

  const stopDraftTranscription = useCallback(async () => {
    await Promise.all([localAsrScheduler.current?.stop(), cloudAsrScheduler.current?.stop()]);
    await localAsrServer.current?.stop();
    localAsrScheduler.current = null;
    cloudAsrScheduler.current = null;
    localAsrServer.current = null;
    setTranscribingCount(0);
  }, []);

  const completeCaptureSession = useCallback(async (reason: string, alreadyFinalized = false) => {
    meetSpeakerReader.current?.stop();
    const store = captureSessionStore.current;
    if (!store) return;
    try {
      await store.drainCommits();
      const current = liveRecordRef.current;
      if (saveByDefault || liveMeetingRef.current || current.transcript.length > 0) {
        const routing = config.transcription ?? DEFAULT_TRANSCRIPTION_ROUTING;
        const canonicalRoute = selectCanonicalTranscriptionRoute(routing);
        const cloud = routing.cloud;
        const attendees = liveMeetingRef.current?.calendar?.attendees;
        const record = await saveFinalizedCapture(store, libraryRoot, reason, {
          title: current.title,
          // A recording started from a calendar event: its invitees cap how many voices there are.
          ...(attendees?.length ? { attendees } : {}),
          onStatus: (label) => setProcessing({ label }),
          ...(alreadyFinalized ? { finalizedRecord: current } : {}),
          ...(canonicalRoute === 'cloud' && cloud?.uploadConsent ? {
            remoteRoute: { model: cloud.model, uploadConsent: true as const,
              ...(cloud.upstreamProvider === undefined ? {} : { upstreamProvider: cloud.upstreamProvider }),
              ...(cloud.maxCostMicrousd === undefined ? {} : { maxCostMicrousd: cloud.maxCostMicrousd }) },
          } : {}),
        });
        liveRecordRef.current = record;
        setLiveRecord(record);
        if (liveMeetingRef.current) {
          const meeting = loadMeetingArtifact(libraryRoot, record.id) ?? null;
          liveMeetingRef.current = meeting;
          setLiveMeeting(meeting);
        }
        refreshLibrary();
      } else {
        store.setStatus('interrupted', 'capture-retained-without-published-transcript');
      }
    } catch (captureError) {
      try { store.setStatus('interrupted', 'finalization-failed'); } catch {}
      setError(`Capture remains recoverable: ${
        captureError instanceof Error ? captureError.message : String(captureError)
      }`);
      throw captureError;
    } finally {
      captureSessionStore.current = null;
    }
  }, [config.transcription, libraryRoot, refreshLibrary, saveByDefault]);

  const runCurrentMeetingEnrichment = useCallback((finishLive = false) => {
    const targetRecord = finishLive ? liveRecordRef.current : currentRecord;
    const targetMeeting = finishLive ? liveMeetingRef.current : currentMeeting;
    if (!targetRecord || !targetMeeting || processing) return;
    if (observerActiveRef.current) {
      setCaution('The live meeting observer is finishing its current window. Try again in a moment.');
      return;
    }
    const mode = config.meeting?.mode ?? targetMeeting.mode;
    const missingObserver = mode !== 'post-session' && !configuredMeetingRoutes.observer;
    const missingReconciliation = mode !== 'streaming' && !configuredMeetingRoutes.reconciliation;
    if ((missingObserver || missingReconciliation) && !finishLive) {
      setAiSetupIntent('notes');
      setAiSetupOpen(true);
      return;
    }
    const wasListening = (finishLive || view === 'live') && !pausedRef.current;
    const captureHandles = [microphoneCapture.current, systemAudioCapture.current]
      .filter((handle): handle is MicrophoneCaptureHandle | SystemAudioCaptureHandle => Boolean(handle));
    if (wasListening) setListeningPaused(true);
    setError(null);
    setProcessing({ label: finishLive ? 'Finishing capture…' : 'Writing the notes…' });
    const onStatus = (label: string) => setProcessing({ label });
    // A meeting this window finished is ready, as one the background recorder finishes is:
    // extractors that fit it, then automations. Whatever fails is said; the notes stay.
    let readyId: string | undefined;
    const followUpReadyMeeting = async (id: string): Promise<string | undefined> => {
      const result = await afterMeetingReady(libraryRoot, id, {
        ...(configuredMeetingRoutes.reconciliation ? { route: configuredMeetingRoutes.reconciliation } : {}),
        ...(liveAppName.current ? { app: liveAppName.current } : {}),
        ask: askAutomationApprovalWithDialog,
        onStatus,
      });
      const failed = [...result.extractorFailures.map((failure) => failure.extractor),
        ...result.automations.filter((run) => run.status === 'failed').map((run) => run.automation)];
      return failed.length ? `${failed.join(', ')} failed. Settings (,) shows why.` : undefined;
    };
    const reload = (id: string, fallback?: MeetingArtifact) => {
      const artifact = loadMeetingArtifact(libraryRoot, id) ?? fallback;
      if (!artifact) return;
      if (finishLive) { liveMeetingRef.current = artifact; setLiveMeeting(artifact); }
      else commitMeetingState(artifact);
    };
    void (async () => {
      try {
        if (finishLive) {
          await Promise.all(captureHandles.map((handle) => handle.done));
          const store = captureSessionStore.current;
          await store?.drainCommits();
          await stopDraftTranscription();
          if (store?.manifest.chunks.length) {
            const routing = config.transcription ?? DEFAULT_TRANSCRIPTION_ROUTING;
            const canonicalRoute = selectCanonicalTranscriptionRoute(routing);
            const cloud = routing.cloud;
            const finalized = await finalizeCaptureTranscript(store.manifestPath, {
              title: liveRecordRef.current.title,
              // A recording started from a calendar event: its invitees cap how many voices there are.
              ...(targetMeeting.calendar?.attendees.length ? { attendees: targetMeeting.calendar.attendees } : {}),
              onStatus: (label) => setProcessing({ label }),
              ...(canonicalRoute === 'cloud' && cloud?.uploadConsent ? {
                remoteRoute: {
                  model: cloud.model,
                  ...(cloud.upstreamProvider === undefined
                    ? {}
                    : { upstreamProvider: cloud.upstreamProvider }),
                  ...(cloud.maxCostMicrousd === undefined
                    ? {}
                    : { maxCostMicrousd: cloud.maxCostMicrousd }),
                  uploadConsent: true as const,
                },
              } : {}),
            });
            const attendeeEvidence = targetMeeting.attendees.length > 0
              ? {
                  attendees: targetMeeting.attendees.map((attendee) => ({
                    name: attendee.name,
                    ...(attendee.email === undefined ? {} : { email: attendee.email }),
                  })),
                  screenshots: [],
                  activeSpeakers: [],
                }
              : undefined;
            const labeled = attendeeEvidence
              ? await applySpeakerLabels(finalized, new EvidenceSpeakerLabeler(), attendeeEvidence) as TranscriptRecord
              : finalized;
            liveRecordRef.current = labeled;
            setLiveRecord(labeled);
          }
          await completeCaptureSession('meeting-finished', true);
        }
        const record = finishLive ? liveRecordRef.current : targetRecord;
        saveTranscriptRecord(libraryRoot, record);
        if (finishLive) readyId = record.id;
        if (missingObserver || missingReconciliation) {
          readyId = undefined;
          const failed = finishLive ? await followUpReadyMeeting(record.id) : undefined;
          if (finishLive) reload(record.id);
          refreshLibrary();
          if (failed) setError(`Meeting saved, but ${failed}`);
          else setNotice('Meeting saved. Connect AI for notes, or return to your transcript.');
          return;
        }
        const artifact = await enrichMeeting(libraryRoot, record.id, {
          routes: {
            ...(configuredMeetingRoutes.observer === undefined
              ? {}
              : { observer: configuredMeetingRoutes.observer }),
            ...(configuredMeetingRoutes.reconciliation === undefined
              ? {}
              : { reconciliation: configuredMeetingRoutes.reconciliation }),
          },
          mode,
          minimumNewSegments: config.meeting?.observerMinSegments,
          maximumNewSegments: config.meeting?.observerMaxSegments,
          maxObserverRuns: config.meeting?.maxObserverRuns,
          context: buildMeetingContext(config.meeting?.contextFiles, targetMeeting.calendar),
          onStatus,
        });
        // The notes show at once; what runs after them updates the view when it is done.
        reload(record.id, artifact);
        setMeetingView('notes');
        let failed: string | undefined;
        if (finishLive) {
          readyId = undefined;
          failed = await followUpReadyMeeting(record.id);
        } else if (configuredMeetingRoutes.reconciliation && artifact.analysis?.final) {
          // Notes written again: the extractors that fit run again over them.
          const extracted = await runAutomaticExtractors(libraryRoot, record.id, { route: configuredMeetingRoutes.reconciliation, onStatus });
          if (extracted.failed.length) failed = `${extracted.failed.map((failure) => failure.extractor).join(', ')} failed: ${extracted.failed[0]!.message}`;
        }
        reload(record.id, artifact);
        refreshLibrary();
        if (failed) setError(`Notes are ready, but ${failed}`);
        else setNotice(finishLive
          ? 'Meeting capture, final transcript, notes, and analysis are ready.'
          : 'Meeting notes and analysis are ready.');
      } catch (meetingError) {
        setError(meetingError instanceof Error ? meetingError.message : String(meetingError));
        // Saved, even without notes: the meeting is still ready for its automations.
        if (readyId) await followUpReadyMeeting(readyId).catch(() => undefined);
        const failed = loadMeetingArtifact(libraryRoot, targetRecord.id);
        if (failed) {
          if (finishLive) {
            liveMeetingRef.current = failed;
            setLiveMeeting(failed);
          } else {
            commitMeetingState(failed);
          }
        }
      } finally {
        if (finishLive) automaticTransition.current = false;
        setProcessing(null);
        if (wasListening && !finishLive) setListeningPaused(false);
      }
    })();
  }, [
    commitMeetingState,
    config.meeting,
    configuredMeetingRoutes,
    completeCaptureSession,
    stopDraftTranscription,
    currentMeeting,
    currentRecord,
    libraryRoot,
    processing,
    refreshLibrary,
    setListeningPaused,
    view,
  ]);

  useEffect(() => {
    if (aiSetupOpen || !aiSetupIntent || processing) return;
    if (aiSetupIntent === 'chat' && configuredMeetingRoutes.chat) {
      setAiSetupIntent(null);
      setMeetingView('chat');
      setChatInputState({ input: '' });
    } else if (aiSetupIntent === 'notes' && (config.meeting?.mode === 'streaming'
      ? configuredMeetingRoutes.observer : configuredMeetingRoutes.reconciliation)) {
      setAiSetupIntent(null);
      runCurrentMeetingEnrichment();
    }
  }, [aiSetupOpen, aiSetupIntent, processing, config.meeting?.mode, configuredMeetingRoutes, runCurrentMeetingEnrichment]);

  const submitMeetingQuestion = useCallback((question: string) => {
    if (!currentRecord || !currentMeeting || !configuredMeetingRoutes.chat || processing) return;
    setProcessing({ label: 'Reading the meeting…' });
    setError(null);
    void chatWithMeeting(
      libraryRoot,
      currentRecord.id,
      question,
      configuredMeetingRoutes.chat,
      (label) => setProcessing({ label }),
    ).then((artifact) => {
      commitMeetingState(artifact);
      setMeetingView('chat');
    }).catch((chatError) => {
      setError(chatError instanceof Error ? chatError.message : String(chatError));
    }).finally(() => setProcessing(null));
  }, [
    commitMeetingState,
    configuredMeetingRoutes,
    currentMeeting,
    currentRecord,
    libraryRoot,
    processing,
  ]);

  useEffect(() => {
    const calendar = config.meeting?.calendar;
    if (!calendar?.enabled || (calendar.policy ?? 'ask') === 'off') return;
    // The background recorder reads the calendar itself; a second reader here only adds a way to fail.
    if (watchOwnership === 'external' || watchOwnership === 'checking') return;
    let cancelled = false;
    let polling = false;
    let retryAtUnixMs = 0;
    const calendarAbort = new AbortController();
    const poll = async () => {
      if (polling || Date.now() < retryAtUnixMs) return;
      polling = true;
      try {
        const events = await readMacCalendarEventsAsync({
          leadMinutes: calendar.leadMinutes,
          signal: calendarAbort.signal,
        });
        const suggestion = suggestCalendarMeeting(events, {
          policy: calendar.policy ?? 'ask',
          selectedCalendars: calendar.selectedCalendars,
          leadMinutes: calendar.leadMinutes,
        });
        if (!cancelled) {
          retryAtUnixMs = 0;
          calendarSuggestionRef.current = suggestion ?? null;
          setCalendarSuggestion(suggestion ?? null);
        }
      } catch (calendarError) {
        if (!cancelled) {
          retryAtUnixMs = Date.now() + 5 * 60_000;
          setError(calendarError instanceof Error ? calendarError.message : String(calendarError));
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const interval = setInterval(() => { void poll(); }, 60_000);
    return () => {
      cancelled = true;
      calendarAbort.abort();
      clearInterval(interval);
    };
  }, [config.meeting?.calendar, watchOwnership]);

  useEffect(() => {
    if (!calendarSuggestion || liveMeeting || view !== 'live') return;
    const policy = config.meeting?.calendar?.policy ?? 'ask';
    if (pausedRef.current) {
      setCaution(`Upcoming: ${calendarSuggestion.title} · waiting for meeting audio.`);
    } else if (policy === 'all' || policy === 'selected-calendars') {
      markCurrentAsMeeting(calendarSuggestion);
    } else if (policy === 'ask') {
      setCaution(`Meeting starting: ${calendarSuggestion.title}. Press M to attach it.`);
    }
  }, [
    calendarSuggestion,
    config.meeting?.calendar?.policy,
    liveMeeting,
    markCurrentAsMeeting,
    view,
  ]);

  useEffect(() => {
    if (
      view !== 'live' ||
      !liveMeeting ||
      !configuredMeetingRoutes.observer ||
      observerActiveRef.current ||
      liveMeeting.ai?.off ||
      liveMeeting.status === 'failed' ||
      liveMeeting.session.observerRunIds.length >= liveMeeting.session.maxObserverRuns ||
      (config.meeting?.mode ?? liveMeeting.mode) === 'post-session'
    ) return;
    const minimum = config.meeting?.observerMinSegments ?? 3;
    if (liveRecord.transcript.length - liveMeeting.session.cursor < minimum) return;
    observerActiveRef.current = true;
    saveTranscriptRecord(libraryRoot, liveRecord);
    void enrichMeeting(libraryRoot, liveRecord.id, {
      routes: {
        observer: configuredMeetingRoutes.observer,
      },
      mode: 'streaming',
      minimumNewSegments: minimum,
      maximumNewSegments: config.meeting?.observerMaxSegments,
      maxObserverRuns: config.meeting?.maxObserverRuns,
      context: buildMeetingContext(config.meeting?.contextFiles, liveMeeting.calendar),
    }).then((artifact) => {
      const configuredMode = config.meeting?.mode ?? liveMeeting.mode;
      const updated = configuredMode === artifact.mode
        ? artifact
        : { ...artifact, mode: configuredMode };
      saveMeetingArtifact(libraryRoot, updated);
      liveMeetingRef.current = updated;
      setLiveMeeting(updated);
      refreshLibrary();
    }).catch((observerError) => {
      const failed = loadMeetingArtifact(libraryRoot, liveRecord.id);
      if (failed) {
        liveMeetingRef.current = failed;
        setLiveMeeting(failed);
      }
      setCaution(`Meeting observer paused: ${
        observerError instanceof Error ? observerError.message : String(observerError)
      }`);
    }).finally(() => {
      observerActiveRef.current = false;
    });
  }, [
    config.meeting,
    configuredMeetingRoutes,
    libraryRoot,
    liveMeeting,
    liveRecord,
    refreshLibrary,
    view,
  ]);

  // Your side of a finished call was barely heard: said once, as the first line of
  // the meeting's notes, never in the list.
  const yourSide = useMemo(() => {
    if (!currentEntry || currentEntry.captureState === 'recording' || currentEntry.captureState === 'processing') return undefined;
    return yourSideNotice(readMeetingCoverage(currentEntry.directory, currentEntry.captureHealth));
  }, [currentEntry?.directory, currentEntry?.captureState, currentEntry?.captureHealth?.coverage?.yourSideMissing]);
  const cautionRows = useMemo(() => yourSide && view === 'record' && meetingView === 'notes'
    ? wrappedMeetingRows([yourSide], contentColumns) : [], [yourSide, view, meetingView, contentColumns]);
  const auxiliaryMeetingLines = useMemo(() => (
    currentMeeting && meetingView !== 'transcript'
      ? [...cautionRows, ...(cautionRows.length ? [''] : []),
        ...wrappedMeetingRows(meetingViewLines(currentMeeting, meetingView, currentRecord ?? undefined), contentColumns)]
      : []
  ), [currentMeeting, meetingView, currentRecord, contentColumns, cautionRows]);
  const visibleAuxiliaryMeetingLines = auxiliaryMeetingLines.slice(
    transcriptScroll,
    transcriptScroll + visibleRows,
  );
  const scrollItemCount = currentMeeting && meetingView !== 'transcript'
    ? auxiliaryMeetingLines.length
    : displayRows.length;
  const scrollVisibleRows = visibleRows;
  const scrollTranscriptBy = (delta: number) => {
    const next = currentMeeting && meetingView !== 'transcript'
      ? moveTranscriptScroll(transcriptScroll, delta, scrollItemCount, scrollVisibleRows)
      : Math.min(Math.max(latestTranscriptScroll, visibleTranscriptScroll), Math.max(0, visibleTranscriptScroll + delta));
    setTranscriptScroll(next);
    if (showingLiveTranscript) setFollowLiveTranscript(next >= latestTranscriptScroll);
  };

  const copyCurrentView = useCallback(() => {
    if (!currentRecord) return;
    const text = currentMeeting && meetingView !== 'transcript'
      ? plainMeetingLines(meetingViewLines(currentMeeting, meetingView, currentRecord)).join('\n')
      : renderText(currentRecord, { timestamps: showTimestamps, speakers: showSpeakers });
    if (!text) return;
    const result = spawnSync('pbcopy', [], { input: text, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      setError('Copy failed');
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [currentMeeting, currentRecord, meetingView, showSpeakers, showTimestamps]);

  const performExport = useCallback((format: TranscriptFormat) => {
    if (!currentRecord) return;
    try {
      writeTranscriptExport(libraryRoot, currentRecord.id, format);
      setNotice(`Saved ${EXPORT_WORDS[format]} in the meeting's folder. o opens it.`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
    setExportMode(false);
  }, [currentRecord, libraryRoot]);

  const openCurrentFolder = useCallback(() => {
    try {
      const path = currentRecord
        ? dirname(findTranscriptRecord(libraryRoot, currentRecord.id).path)
        : libraryRoot;
      const result = spawnSync('open', [path], { stdio: 'ignore' });
      if (result.error || result.status !== 0) throw new Error(`Could not open ${path}`);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  }, [currentRecord, libraryRoot]);

  const resetLiveSession = useCallback(async () => {
    const resumeCapture = !pausedRef.current;
    setProcessing({ label: 'Finishing previous transcript…' });
    const captureHandles = [microphoneCapture.current, systemAudioCapture.current]
      .filter((handle): handle is MicrophoneCaptureHandle | SystemAudioCaptureHandle => Boolean(handle));
    microphoneCapture.current?.stop();
    microphoneCapture.current = null;
    systemAudioCapture.current?.stop();
    systemAudioCapture.current = null;
    meetSpeakerReader.current?.stop();
    try {
      await Promise.all(captureHandles.map((handle) => handle.done));
      await captureSessionStore.current?.drainCommits();
      await stopDraftTranscription();
      await completeCaptureSession('new-live-session');
      liveSessionGeneration.current += 1;
      const next = createLiveRecord();
      liveRecordRef.current = next;
      liveSessionStartedAt.current = null;
      setLiveRecord(next);
      liveMeetingRef.current = null;
      setLiveMeeting(null);
      setCaptureAppBundle(undefined);
      liveAppName.current = undefined;
      setMeetingView('transcript');
      setTranscriptScroll(0);
      setNotice('Started a fresh live transcript.');
      setFollowLiveTranscript(true);
      if (resumeCapture) {
        startListener();
        startSystemListener();
      }
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError));
    } finally {
      setProcessing(null);
    }
  }, [completeCaptureSession, startListener, startSystemListener, stopDraftTranscription]);

  const beginAutomaticMeeting = useCallback(async (candidate: MeetingCandidate) => {
    const needsFreshSession = pausedRef.current && (
      liveRecordRef.current.transcript.length > 0 ||
      liveMeetingRef.current !== null ||
      captureSessionStore.current !== null
    );
    if (needsFreshSession) await resetLiveSession();
    setCaptureAppBundle(candidate.bundleId);
    liveAppName.current = candidate.appName;
    ensureLiveSessionStartedAt();
    const base = liveRecordRef.current;
    const record: TranscriptRecord = {
      ...base,
      title: candidate.title,
      updatedAt: new Date().toISOString(),
    };
    liveRecordRef.current = record;
    setLiveRecord(record);
    saveTranscriptRecord(libraryRoot, record);
    const existing = loadMeetingArtifact(libraryRoot, record.id);
    const artifact = existing ?? createMeetingArtifact(record, {
      mode: config.meeting?.mode ?? 'hybrid',
      ...(candidate.calendar === undefined ? {} : { calendar: candidate.calendar }),
      maxObserverRuns: config.meeting?.maxObserverRuns,
    });
    saveMeetingArtifact(libraryRoot, artifact);
    liveMeetingRef.current = artifact;
    setLiveMeeting(artifact);
    setView('live');
    setMeetingView('transcript');
    setHistoryOpen(false);
    setAutomaticCandidate(null);
    setFollowLiveTranscript(true);
    setError(null);
    setNotice(null);
    refreshLibrary();
    if (pausedRef.current) setListeningPaused(false);
  }, [
    config.meeting,
    ensureLiveSessionStartedAt,
    libraryRoot,
    refreshLibrary,
    resetLiveSession,
    setListeningPaused,
  ]);

  useEffect(() => {
    if (!automaticMeetingEnabled || listenerDisabled || watchOwnership !== 'owned') return;
    let cancelled = false;
    let polling = false;
    const abort = new AbortController();
    const detectorFailed = (signalError: unknown) => {
      if (cancelled || isExiting.current || automaticTransition.current) return;
      const action = meetingAutomationController.current.step(undefined, Date.now());
      setAutomationPhase(meetingAutomationController.current.state.phase);
      const message = signalError instanceof Error ? signalError.message : String(signalError);
      if (action.kind === 'finish') {
        automaticTransition.current = true;
        setAutomaticFinishRequested(true);
        setNotice(`Meeting signals unavailable · finishing ${action.candidate.title}.`);
      } else if (meetingSignalFailure.current !== message) {
        setCaution(`${message} Manual recording is still available.`);
      }
      meetingSignalFailure.current = message;
    };
    const poll = async (snapshot: MeetingSignalSnapshot) => {
      if (polling || cancelled || isExiting.current || automaticTransition.current) return;
      polling = true;
      try {
        const browser = config.meeting?.speakerBrowser;
        const meet = browser && browser !== 'off' ? await probeMeetSpeakers(browser, abort.signal) : undefined;
        if (cancelled || isExiting.current) return;
        const candidate = preserveMeetingCandidateDuringObservationGap(
          resolveMeetingCandidate(snapshot, calendarSuggestionRef.current ?? undefined, meetingAutomation, meet),
          meetingAutomationController.current.state, snapshot, meet,
        );
        const action = meetingAutomationController.current.step(candidate, Date.now(),
          hasConfirmedMeetingEnd(meetingAutomationController.current.state.candidate, meet));
        setAutomationPhase(meetingAutomationController.current.state.phase);
        meetingSignalFailure.current = null;
        if (action.kind === 'suggest') {
          setAutomaticCandidate(action.candidate);
        } else if (action.kind === 'start') {
          automaticTransition.current = true;
          void beginAutomaticMeeting(action.candidate).catch((automationError: unknown) => {
            meetingAutomationController.current.reset();
            setAutomationPhase(meetingAutomationController.current.state.phase);
            setError(automationError instanceof Error ? automationError.message : String(automationError));
          }).finally(() => { automaticTransition.current = false; });
        } else if (action.kind === 'finish') {
          automaticTransition.current = true;
          setAutomaticFinishRequested(true);
          setNotice(`Meeting audio ended · finishing ${action.candidate.title}.`);
        }
      } catch (signalError) {
        detectorFailed(signalError);
      } finally { polling = false; }
    };
    const monitor = new MeetingSignalMonitor(
      undefined,
      (meetingAutomation.pollSeconds ?? DEFAULT_MEETING_AUTOMATION.pollSeconds) * 1_000,
    );
    const unsubscribe = monitor.subscribe(poll);
    const unsubscribeError = monitor.onError(detectorFailed);
    monitor.start();
    return () => {
      cancelled = true;
      abort.abort();
      unsubscribe();
      unsubscribeError();
      monitor.stop();
    };
  }, [
    automaticMeetingEnabled,
    beginAutomaticMeeting,
    listenerDisabled,
    meetingAutomation,
    watchOwnership,
    config.meeting?.speakerBrowser,
  ]);

  useEffect(() => {
    if (!automaticFinishRequested || processing || observerActiveRef.current) return;
    setAutomaticFinishRequested(false);
    if (!liveMeetingRef.current) { automaticTransition.current = false; return; }
    runCurrentMeetingEnrichment(true);
  }, [automaticFinishRequested, processing, runCurrentMeetingEnrichment]);

  const gracefulExit = useCallback(() => {
    if (exitInProgress.current) return;
    if (processing) {
      setExitRequested(true);
      setCaution('Finishing the current operation before quitting…');
      return;
    }
    exitInProgress.current = true;
    pausedRef.current = true;
    setPaused(true);
    setProcessing({ label: 'Finishing live transcript…' });
    const captureHandles = [microphoneCapture.current, systemAudioCapture.current]
      .filter((handle): handle is MicrophoneCaptureHandle | SystemAudioCaptureHandle => Boolean(handle));
    microphoneCapture.current?.stop();
    systemAudioCapture.current?.stop();
    microphoneCapture.current = null;
    systemAudioCapture.current = null;
    void (async () => {
      try {
        await Promise.all(captureHandles.map((handle) => handle.done));
        await captureSessionStore.current?.drainCommits();
        await stopDraftTranscription();
        await completeCaptureSession('application-exit');
      } catch {
        try { captureSessionStore.current?.setStatus('interrupted', 'graceful-exit-failed'); } catch {}
      } finally {
        isExiting.current = true;
        exit();
      }
    })();
  }, [completeCaptureSession, exit, processing, stopDraftTranscription]);

  useEffect(() => {
    if (exitRequested && !processing) gracefulExit();
  }, [exitRequested, gracefulExit, processing]);

  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const mouseDecoder = useRef(new MouseScrollDecoder());
  const mouseEnabled = !speakerSetupOpen && !aiSetupOpen && !guideOpen && !chatInputState && !renameState && !speakerPickerOpen && !searchMode && !exportMode && !confirmTrashId && !notesSetup;

  const renameSpeaker = (speakerId: string, name: string, done: string) => {
    if (!currentRecord) return;
    try {
      const renamed = renameTranscriptSpeaker(libraryRoot, currentRecord.id, speakerId, name);
      if (view === 'live') {
        liveRecordRef.current = renamed;
        setLiveRecord(renamed);
      } else {
        setSelectedRecord(renamed);
      }
      const meeting = loadMeetingArtifact(libraryRoot, renamed.id);
      if (meeting) commitMeetingState(meeting);
      refreshLibrary();
      setNotice(done);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    }
  };

  // A meeting kept with its video plays it, from the line being read.
  const videoAvailable = useMemo(() => {
    if (view !== 'record' || !selectedRecord || currentRecordBusy) return false;
    try { return Boolean(meetingVideo(libraryRoot, selectedRecord.id)); } catch { return false; }
  }, [view, selectedRecord?.id, currentRecordBusy, libraryRoot]);
  const watchVideo = () => {
    if (!selectedRecord) return;
    // From the line at the top: a line cut there keeps its time pinned in view, so that is where it plays from.
    const at = meetingView === 'transcript' ? timedRows[visibleTranscriptScroll]?.start : undefined;
    try {
      openMeetingVideo(libraryRoot, selectedRecord.id, at === undefined ? {} : { atSeconds: at });
      setNotice(at === undefined ? 'Opened the video.' : `Opened the video at ${formatTuiClock(at)}.`);
    } catch (videoError) {
      setError(videoError instanceof Error ? videoError.message : String(videoError));
    }
  };


  const saveMeetingAi = useCallback((change: (ai: NonNullable<MeetingArtifact['ai']>) => void) => {
    if (!currentMeeting) return;
    const ai = { ...currentMeeting.ai };
    change(ai);
    const next: MeetingArtifact = { ...currentMeeting, ai };
    if (!Object.keys(ai).length) delete next.ai;
    try {
      saveMeetingArtifact(libraryRoot, next);
      commitMeetingState(next);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }, [commitMeetingState, currentMeeting, libraryRoot]);
  useEffect(() => {
    if (!mouseEnabled || !stdin.isTTY || !stdout.isTTY) return;
    stdout.write('\x1b[?1000h\x1b[?1006h');
    const restore = () => { stdout.write('\x1b[?1006l\x1b[?1000l'); };
    process.once('exit', restore);
    return () => { process.removeListener('exit', restore); restore(); };
  }, [mouseEnabled, stdin, stdout]);

  useInput((input, key) => {
    const mouse = mouseDecoder.current.read(input);
    if (mouse.consumed) {
      if (mouseEnabled && mouse.events.length) {
        const inHistory = historyOpen && (drawerOnly || mouse.events[0]!.column <= layout.sidebarWidth + 2);
        const delta = mouse.events.reduce((sum, event) => sum + event.delta, 0);
        if (inHistory) {
          const next = moveSelection(selectionIndex, delta, navigationItems.length);
          setSelectionIndex(next);
          showNavigationItem(navigationItems[next]);
        } else scrollTranscriptBy(delta);
      }
      return;
    }
    setError(null);
    setNotice(null);
    if (chatInputState) {
      if (key.escape) {
        setChatInputState(null);
        return;
      }
      if (key.return) {
        const question = chatInputState.input.trim();
        setChatInputState(null);
        if (question) submitMeetingQuestion(question);
        return;
      }
      if (key.backspace || key.delete) {
        setChatInputState((current) => current
          ? { input: current.input.slice(0, -1) }
          : null);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setChatInputState((current) => current ? { input: current.input + input } : null);
      }
      return;
    }

    if (renameState) {
      if (key.escape) {
        setRenameState(null);
        return;
      }
      if (key.return) {
        if (renameState.input.trim()) {
          renameSpeaker(renameState.speakerId, renameState.input, `${renameState.label} is now ${renameState.input.trim()}.`);
        }
        setRenameState(null);
        return;
      }
      if (key.backspace || key.delete) {
        setRenameState((current) => current ? { ...current, input: current.input.slice(0, -1) } : null);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setRenameState((current) => current ? { ...current, input: current.input + input } : null);
      }
      return;
    }

    if (speakerPickerOpen) {
      if (key.escape || input === 'r') { setSpeakerPickerOpen(false); return; }
      const speakers = currentRecord?.speakers ?? [];
      const suggested = speakers[speakerSelection]?.suggestion ? speakers[speakerSelection] : undefined;
      if (key.upArrow) setSpeakerSelection((index) => moveSelection(index, -1, speakers.length));
      else if (key.downArrow) setSpeakerSelection((index) => moveSelection(index, 1, speakers.length));
      // A name Seashell suggested from a known voice: keep it, which also teaches the voice, or say it is not them.
      else if (input === 'y' && suggested) renameSpeaker(suggested.id, suggested.label, `Kept ${suggested.label}.`);
      else if (input === 'n' && suggested) renameSpeaker(suggested.id, suggested.suggestion!.previous,
        `${suggested.label} is ${speakerDisplayName(suggested.id, suggested.suggestion!.previous)} again.`);
      else if (key.return) {
        const speaker = speakers[speakerSelection];
        setSpeakerPickerOpen(false);
        if (speaker) setRenameState({ speakerId: speaker.id, input: '', label: speakerDisplayName(speaker.id, speaker.label) });
      }
      return;
    }

    if (searchMode) {
      if (key.escape) {
        setSearchMode(false);
        setSearchQuery('');
        setSearchHit(null);
        return;
      }
      if (key.return) {
        setSearchMode(false);
        const first = navigationItems.findIndex((item) => item.kind === 'record');
        if (first >= 0) {
          setSelectionIndex(first);
          showNavigationItem(navigationItems[first]);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((query) => query.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setSearchQuery((query) => query + input);
      return;
    }

    if (exportMode) {
      if (key.escape) {
        setExportMode(false);
        return;
      }
      const formats: Record<string, TranscriptFormat> = {
        s: 'srt',
        v: 'vtt',
        t: 'text',
        j: 'json',
      };
      const format = formats[input.toLowerCase()];
      if (format) performExport(format);
      return;
    }

    if (confirmStop) {
      setConfirmStop(false);
      if (input.toLowerCase() === 'y') {
        try {
          writeMeetingCommand('stop');
          setNotice('Stopping. The transcript and notes are written next.');
        } catch (cause) { setError(`Could not stop recording: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
      return;
    }

    if (confirmRewrite) {
      setConfirmRewrite(false);
      if (input.toLowerCase() === 'y') runCurrentMeetingEnrichment(view === 'live');
      return;
    }

    if (confirmTrashId) {
      if (input.toLowerCase() === 'y') {
        try {
          trashTranscriptRecord(libraryRoot, confirmTrashId);
          setSelectedRecord(null);
          setSelectedMeeting(null);
          setView('live');
          setSelectionIndex(0);
          refreshLibrary();
          setNotice(`Moved "${selectedRecord?.title ?? 'the meeting'}" to the Trash folder.`);
        } catch (trashError) {
          setError(trashError instanceof Error ? trashError.message : String(trashError));
        }
        setConfirmTrashId(null);
      } else if (input.toLowerCase() === 'n' || key.escape) {
        setConfirmTrashId(null);
      }
      return;
    }

    if (notesSetup) {
      if (notesSetup.editing !== undefined) {
        if (key.escape) { setNotesSetup({ ...notesSetup, editing: undefined }); return; }
        if (key.return) {
          const note = notesSetup.editing.trim();
          saveMeetingAi((ai) => { if (note) ai.note = note; else delete ai.note; });
          setNotesSetup({ ...notesSetup, editing: undefined });
          return;
        }
        if (key.backspace || key.delete) { setNotesSetup({ ...notesSetup, editing: notesSetup.editing.slice(0, -1) }); return; }
        if (input && !key.ctrl && !key.meta) setNotesSetup({ ...notesSetup, editing: notesSetup.editing + input });
        return;
      }
      if (key.escape) {
        setNotesSetup(null);
        const changed = JSON.stringify(currentMeeting?.ai ?? {}) !== notesSetup.opened;
        if (changed && currentMeeting && !currentMeeting.ai?.off) {
          setNotice(`Saved for this meeting. Press g to ${currentMeeting.analysis ? 'rewrite' : 'write'} the notes with them.`);
        }
        return;
      }
      // Enter writes the notes with these choices; on the note, it edits the note.
      if (key.return && notesSetup.row !== 1) {
        if (!currentMeeting || currentMeeting.ai?.off) return;
        setNotesSetup(null);
        if (currentMeeting.analysis?.final) setConfirmRewrite(true);
        else runCurrentMeetingEnrichment(view === 'live');
        return;
      }
      if (key.upArrow) { setNotesSetup({ ...notesSetup, row: Math.max(0, notesSetup.row - 1) as 0 | 1 | 2 }); return; }
      if (key.downArrow) { setNotesSetup({ ...notesSetup, row: Math.min(2, notesSetup.row + 1) as 0 | 1 | 2 }); return; }
      if (notesSetup.row === 0 && (key.leftArrow || key.rightArrow)) {
        const current = currentMeeting?.ai?.template ?? 'auto';
        const index = Math.max(0, notesSetup.options.indexOf(current));
        const step = key.rightArrow ? 1 : -1;
        const chosen = notesSetup.options[(index + step + notesSetup.options.length) % notesSetup.options.length]!;
        saveMeetingAi((ai) => { if (chosen === 'auto') delete ai.template; else ai.template = chosen; });
        return;
      }
      if (notesSetup.row === 1 && key.return) {
        setNotesSetup({ ...notesSetup, editing: currentMeeting?.ai?.note ?? '' });
        return;
      }
      if (notesSetup.row === 2 && (key.leftArrow || key.rightArrow || input === ' ')) {
        saveMeetingAi((ai) => { if (ai.off) delete ai.off; else ai.off = true; });
        return;
      }
      return;
    }

    if (audioHelpOpen) {
      if (input === 'i' || key.escape) { setAudioHelpOpen(false); return; }
      // The same keys as the guided setup: o for Sound settings, p for Privacy.
      if (input === 'o' || input === 'p') {
        const target = input === 'o' ? 'x-apple.systempreferences:com.apple.preference.sound?input'
          : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
        const opened = spawnSync('/usr/bin/open', [target], { stdio: 'ignore' });
        if (opened.error || opened.status !== 0) setError('Open System Settings, then Sound → Input or Privacy & Security → Microphone.');
      }
      return;
    }

    if (helpMode) {
      if (input === '?' || key.escape) {
        setHelpMode(false);
      } else if (input === 'q') {
        gracefulExit();
      }
      return;
    }

    if (input.length > 1) {
      const path = cleanDroppedPath(input);
      if (path) importMedia(path, false);
      return;
    }

    if (input === '?') {
      setHelpMode(true);
      return;
    }
    // Esc goes back one level and never leaves the app; only Q does.
    if (key.escape) {
      if (searchQuery) { setSearchQuery(''); setSearchHit(null); }
      else if (!historyOpen) toggleHistory();
      else if (layout.compact && view === 'record') setHistoryOpen(false);
      return;
    }
    if (input === 'q') {
      gracefulExit();
      return;
    }
    if (processing) return;
    if (input === 'i') { setAudioHelpOpen(true); return; }
    // A noticed call is a question like any other: y records it, n ignores it.
    const answer = input.toLowerCase();
    if (watchOwnership === 'external' && (answer === 'y' || answer === 'n') && backgroundWatch?.phase === 'awaiting-consent'
        && backgroundApproval !== backgroundWatch.consentId) {
      const current = readBackgroundWatchStatus(libraryRoot);
      if (current?.phase !== 'awaiting-consent' || !current.consentId || current.consentId !== backgroundWatch.consentId) {
        refreshLibrary(); setCaution('The meeting request changed. Check its current status before recording.'); return;
      }
      try {
        writeMeetingConsent(answer === 'y' ? 'approve' : 'decline', undefined, Date.now(), current.consentId);
        setBackgroundApproval(current.consentId);
        setNotice(answer === 'y' ? 'Start requested. Waiting for the recorder to confirm.' : 'Ignore requested.');
      } catch (cause) { setError(`Could not send the meeting decision: ${cause instanceof Error ? cause.message : String(cause)}`); }
      return;
    }
    if (automaticCandidate && (answer === 'y' || answer === 'n')) {
      if (answer === 'y') {
        const approved = meetingAutomationController.current.approve();
        setAutomationPhase(meetingAutomationController.current.state.phase);
        setAutomaticCandidate(null);
        if (approved) {
          void beginAutomaticMeeting(approved).catch((automationError: unknown) => {
            setError(automationError instanceof Error ? automationError.message : String(automationError));
          });
        }
      } else {
        meetingAutomationController.current.decline();
        setAutomationPhase(meetingAutomationController.current.state.phase);
        setAutomaticCandidate(null);
        setNotice(`Ignored ${automaticCandidate.appName} for this detection window.`);
      }
      return;
    }
    if (currentRecordBusy && ['r', 'd', 'g', 'a', 'e', 'm'].includes(input)) {
      setCaution('Review and edit this when it finishes.');
      return;
    }
    // Speaker setup and AI are rows in Settings, so they have no keys of their own here.
    if (input === ',') {
      const fixing = shownSlot.current;
      setSettingsFocus(fixing?.fix?.[0] === ',' ? fixing.focus : undefined);
      setSettingsOpen(true);
      return;
    }
    if (key.tab || input === '\t' || input === 'h') {
      toggleHistory();
      return;
    }
    if (input === '/') {
      setSearchMode(true);
      setHistoryOpen(true);
      return;
    }
    if (input === 'l') {
      if (activeBackgroundEntry) {
        openRecord(activeBackgroundEntry);
        setHistoryOpen(false);
        setFollowLiveTranscript(true);
        return;
      }
      if (watchOwnership === 'external') {
        setFollowLiveTranscript(true);
        return;
      }
      setView('live');
      setMeetingView('transcript');
      setFollowLiveTranscript(true);
      setHistoryOpen(false);
      setSelectionIndex(0);
      setTranscriptScroll(0);
      return;
    }
    if (input === 'f' || input === 'F') {
      pickMedia(input === 'F');
      return;
    }
    if (input === 'm') {
      if (currentRecord?.transcript.length) markCurrentAsMeeting(view === 'live' ? calendarSuggestion ?? undefined : undefined);
      return;
    }
    // n only ever moves to the next match.
    if (input === 'n' && searchHit !== null && matchRows.length && meetingView === 'transcript') {
      setSearchHit((hit) => ((hit ?? 0) + 1) % matchRows.length);
      return;
    }
    // g opens the notes setup, where Enter writes the notes; with AI off it opens on the switch.
    if (input === 'g' && currentMeeting) {
      let names: string[] = [];
      try { names = loadMeetingTemplates(libraryRoot).map((template) => template.name); } catch {}
      setNotesSetup({ row: currentMeeting.ai?.off ? 2 : 0, options: ['auto', ...names, NO_TEMPLATE], opened: JSON.stringify(currentMeeting.ai ?? {}) });
      return;
    }
    if (input === 'a' && currentMeeting) {
      if (currentMeeting.ai?.off) {
        setCaution('AI is off for this meeting. Press g to turn it on.');
        return;
      }
      if (!configuredMeetingRoutes.chat) {
        setAiSetupIntent('chat');
        setAiSetupOpen(true);
      } else {
        setMeetingView('chat');
        setChatInputState({ input: '' });
      }
      return;
    }
    if (currentMeeting && input >= '1' && input <= '3') {
      const views: MeetingView[] = ['notes', 'transcript', 'chat'];
      setMeetingView(views[Number(input) - 1]!);
      if (input === '2') setFollowLiveTranscript(true);
      setTranscriptScroll(0);
      setError(null);
      setNotice(null);
      return;
    }
    if (input === 't') {
      setShowTimestamps((visible) => !visible);
      return;
    }
    if (input === 's') {
      setShowSpeakers((visible) => !visible);
      return;
    }
    if (input === 'c') {
      copyCurrentView();
      return;
    }
    if (input === 'o') {
      openCurrentFolder();
      return;
    }
    if (input === 'w' && videoAvailable) {
      watchVideo();
      return;
    }
    if (input === 'e' && currentRecord?.transcript.length) {
      setExportMode(true);
      return;
    }
    if (input === 'r' && currentRecord?.speakers.length) {
      // Start on the first name still to check: a suggestion, or a person without a real name.
      setSpeakerSelection(Math.max(0, currentRecord.speakers.findIndex((speaker) => speaker.suggestion || /^Remote speaker \d/u.test(speaker.label))));
      setSpeakerPickerOpen(true);
      return;
    }
    if (input === 'd' && view === 'record' && selectedRecord) {
      setConfirmTrashId(selectedRecord.id);
      return;
    }
    if ((key.delete || key.backspace) && view === 'live') {
      resetLiveSession();
      return;
    }
    // With the background recorder, Space records by hand and stops any recording.
    if (input === ' ' && watchOwnership === 'external') {
      if (activeBackgroundEntry) { setConfirmStop(true); return; }
      try {
        // Plain Space is audio only, even if an earlier request for video was never picked up.
        clearVideoRequest();
        writeMeetingCommand('start');
        setNotice('Starting a recording…');
      } catch (cause) { setError(`Could not start recording: ${cause instanceof Error ? cause.message : String(cause)}`); }
      return;
    }
    // V records by hand with video: the call's window if one is open, otherwise the screen.
    if (input === 'V') {
      if (watchOwnership !== 'external') { setCaution('Recording with video needs the background recorder. Press , to start it.'); return; }
      if (activeBackgroundEntry) { setCaution('Already recording. Video can only start with a new recording.'); return; }
      try {
        startRecordingWithVideo();
        setNotice('Starting a recording with video…');
      } catch (cause) { setError(`Could not start recording: ${cause instanceof Error ? cause.message : String(cause)}`); }
      return;
    }
    // Until recording works, Enter at home starts the guided setup; Space still records by hand.
    if (key.return && view === 'live' && !historyOpen && pausedRef.current && !currentMeeting && attention.length) {
      openGuide(false);
      return;
    }
    if ((input === ' ' || key.return) && view === 'live' && !historyOpen) {
      if (pausedRef.current && automaticCandidate) {
        meetingAutomationController.current.decline();
        setAutomationPhase(meetingAutomationController.current.state.phase);
        setAutomaticCandidate(null);
      }
      setListeningPaused(!pausedRef.current);
      return;
    }

    if (key.upArrow || input === 'k') {
      if (historyOpen) {
        const next = moveSelection(selectionIndex, -1, navigationItems.length);
        setSelectionIndex(next);
        showNavigationItem(navigationItems[next]);
      } else {
        scrollTranscriptBy(-1);
      }
      return;
    }
    if (key.downArrow || input === 'j') {
      if (historyOpen) {
        const next = moveSelection(selectionIndex, 1, navigationItems.length);
        setSelectionIndex(next);
        showNavigationItem(navigationItems[next]);
      } else {
        scrollTranscriptBy(1);
      }
      return;
    }
    if (key.pageUp) {
      if (historyOpen) {
        const next = moveSelection(
          selectionIndex,
          -listCapacity,
          navigationItems.length,
        );
        setSelectionIndex(next);
        showNavigationItem(navigationItems[next]);
        return;
      }
      scrollTranscriptBy(-scrollVisibleRows);
      return;
    }
    if (key.pageDown) {
      if (historyOpen) {
        const next = moveSelection(
          selectionIndex,
          listCapacity,
          navigationItems.length,
        );
        setSelectionIndex(next);
        showNavigationItem(navigationItems[next]);
        return;
      }
      scrollTranscriptBy(scrollVisibleRows);
      return;
    }
    if (key.return && historyOpen) {
      showNavigationItem(navigationItems[selectionIndex]);
      setHistoryOpen(false);
      if (searchQuery.trim()) {
        setMeetingView('transcript');
        setSearchHit(0);
      }
    }
  }, { isActive: !aiSetupOpen && !speakerSetupOpen && !settingsOpen && !guideOpen });

  // A quiet footer nudge when something needed for recording meetings is broken.
  // What the guided setup just heard outweighs a silent or unconfirmed meeting from before.
  const heard = guideProgress?.heard;
  useEffect(() => {
    if (settingsOpen || guideOpen) return;
    const controller = new AbortController();
    void readFeatureStatuses({ config, libraryDir: libraryRoot, signal: controller.signal })
      .then(statuses => {
        if (controller.signal.aborted) return;
        setFeatureStatuses(statuses);
        setAttention(statuses.filter(status => !status.optional && (status.state === 'broken' ||
          (status.state === 'attention' && (status.id === 'microphone' && !heard?.microphone || status.id === 'computer-audio' && !heard?.computer)))));
        setSetupNeeded(statuses.some(status => (status.id === 'recorder' || status.id === 'microphone') && status.state !== 'ok' && Boolean(status.action)));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [settingsOpen, guideOpen, libraryRoot, backgroundWatch?.phase, heard?.microphone, heard?.computer]);
  useEffect(() => {
    if (!firstRun || !setupNeeded || guideOffered.current) return;
    guideOffered.current = true;
    setGuideOpen(true);
  }, [firstRun, setupNeeded]);

  // A window started with listening off never opens a device for the guide either.
  const guideLevels = useMemo(() => props.levels ?? {
    microphone: listenerDisabled ? switchedOff('SEASHELL_DISABLE_LISTENER') : DEFAULT_LEVEL_SOURCES.microphone,
    computer: systemAudioDisabled ? switchedOff(listenerDisabled ? 'SEASHELL_DISABLE_LISTENER' : 'SEASHELL_DISABLE_SYSTEM_AUDIO')
      : DEFAULT_LEVEL_SOURCES.computer,
  }, [props.levels, listenerDisabled, systemAudioDisabled]);

  const openGuide = (fromSettings: boolean, test?: 'microphone' | 'computer') => {
    setGuideProgress(undefined);
    setGuideTest(test);
    setGuideFromSettings(fromSettings);
    setSettingsOpen(false);
    setGuideOpen(true);
  };
  const connectMeetReader = () => {
    updateMeetingConfig({ speakerBrowser: 'auto' });
    setConfig(current => ({ ...current, meeting: { ...current.meeting, speakerBrowser: 'auto' } }));
    setMeetSpeakerStatus(undefined);
  };
  const enableCalendarTitles = () => {
    const policy = config.meeting?.calendar?.policy ?? 'ask';
    updateMeetingConfig({ calendar: { enabled: true, policy: policy === 'off' ? 'ask' : policy } });
    setConfig(current => ({ ...current, meeting: { ...current.meeting,
      calendar: { ...current.meeting?.calendar, enabled: true, policy: policy === 'off' ? 'ask' : policy } } }));
  };
  const openSpeakers = (from: 'settings' | 'guide') => {
    setSettingsOpen(false); setGuideOpen(false); setReturnTo(from); setSpeakerSetupOpen(true);
  };
  const openAI = (from: 'settings' | 'guide') => {
    setSettingsOpen(false); setGuideOpen(false); setReturnTo(from); setAiSetupIntent(null); setAiSetupOpen(true);
  };
  // Choosing an AI from Settings or the guide says so there, once, when it opens again.
  useEffect(() => { if (subNotice && (settingsOpen || guideOpen)) setSubNotice(undefined); }, [subNotice, settingsOpen, guideOpen]);
  const closeSubSettings = () => {
    if (returnTo === 'settings') setSettingsOpen(true);
    if (returnTo === 'guide') setGuideOpen(true);
    setReturnTo(undefined);
  };
  const setupActionProps = {
    libraryDir: libraryRoot,
    ...(props.setupActions ? { actions: props.setupActions } : {}),
    onConnectMeet: connectMeetReader,
    onEnableCalendar: enableCalendarTitles,
    onConfigChange: setConfig,
    ...(subNotice ? { notice: subNotice } : {}),
  };

  if (settingsOpen) return <SettingsScreen {...setupActionProps} config={config} columns={terminal.columns} rows={terminal.rows}
    {...(settingsFocus ? { focus: settingsFocus } : {})}
    onOpenSpeakers={() => openSpeakers('settings')}
    onOpenAI={() => openAI('settings')}
    onOpenGuide={() => openGuide(true)}
    onTest={(source) => openGuide(true, source)}
    onClose={() => setSettingsOpen(false)} />;

  if (guideOpen) return <Onboarding {...setupActionProps} config={config} columns={terminal.columns} rows={terminal.rows}
    progress={guideProgress} onProgress={setGuideProgress}
    levels={guideLevels}
    {...(props.openSettings ? { openSettings: props.openSettings } : {})}
    onOpenSpeakers={() => openSpeakers('guide')}
    onOpenAI={() => openAI('guide')}
    fromSettings={guideFromSettings}
    {...(guideTest ? { test: guideTest } : {})}
    onClose={() => { setGuideOpen(false); if (guideFromSettings) setSettingsOpen(true); }} />;

  const separation = featureStatuses?.find((status) => status.id === 'speaker-separation');
  if (speakerSetupOpen) return <SpeakerSettings columns={terminal.columns} rows={terminal.rows}
    modelSize={speakerModelSize(speakerEngine())}
    {...(separation ? { ready: separation.state === 'ok' } : {})}
    recording={Boolean(activeBackgroundEntry) || (!paused && !listenerDisabled)}
    browser={config.meeting?.speakerBrowser ?? 'off'}
    meetStatus={meetSpeakerStatus}
    onBrowser={(browser) => {
      updateMeetingConfig({ speakerBrowser: browser });
      setConfig(current => ({ ...current, meeting: { ...current.meeting, speakerBrowser: browser } }));
      setMeetSpeakerStatus(undefined);
    }}
    canIdentify={view === 'record' && Boolean(selectedRecord) && !currentRecordBusy}
    onClose={() => { setSpeakerSetupOpen(false); closeSubSettings(); }}
    onIdentify={() => {
      if (view !== 'record' || !selectedRecord || currentRecordBusy) return;
      setSpeakerSetupOpen(false);
      setProcessing({ label: 'Separating speakers…' });
      setError(null);
      void identifySavedSpeakers(libraryRoot, selectedRecord.id, { onStatus: (label) => setProcessing({ label }) })
        .then((record) => {
          setSelectedRecord(record); setSelectedMeeting(null); setMeetingView('transcript');
          setTranscriptScroll(0); setSpeakerSelection(0); setHistoryOpen(false); refreshLibrary();
          setNotice('Saved a copy to review. The original and its notes are unchanged.');
        }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setProcessing(null));
    }} />;

  if (aiSetupOpen) return <AIProviderPicker current={config.meeting} recording={Boolean(activeBackgroundEntry) || (!paused && !listenerDisabled)}
    onClose={() => { setAiSetupIntent(null); setAiSetupOpen(false); closeSubSettings(); }}
    onSave={(patch) => {
      const saved = updateMeetingConfig(patch);
      // Keep capture settings and their object identities stable while changing AI routes.
      setConfig((current) => ({ ...current, meeting: { ...saved.meeting,
        calendar: current.meeting?.calendar, automation: current.meeting?.automation,
      } }));
      const names = [...new Set(Object.values(patch.routes ?? {}).flatMap((route) => route ? [providerName(route.backend)] : []))];
      const done = `Notes and chat use ${names.join(' and ')}.`;
      // Said wherever the person lands: Settings, the guide, or the meeting.
      if (returnTo) setSubNotice(done); else setNotice(done);
      setAiSetupOpen(false);
      closeSubSettings();
      setError(null);
    }} />;

  const consentPending = (watchOwnership === 'external' && backgroundWatch?.phase === 'awaiting-consent') || Boolean(automaticCandidate);
  const approvalPending = backgroundWatch?.consentId !== undefined && backgroundApproval === backgroundWatch.consentId;
  const consentTitle = automaticCandidate?.title ?? backgroundWatch?.candidate?.title;
  const reading = !historyOpen;
  const hasNotes = Boolean(currentMeeting?.analysis);
  const atHome = view === 'live' && paused && !currentMeeting;
  // Space records by hand, and stops whatever is recording.
  const byHand: Hint[] = watchOwnership === 'external' ? activeBackgroundEntry ? [['space', 'stop']] : [['space', 'record'], ['V', 'with video']]
    : view === 'live' && !historyOpen ? [['space', paused ? 'record' : 'stop']] : [];
  const watch: Hint[] = videoAvailable ? [['w', 'watch video']] : [];
  const latest: Hint[] = followLiveTranscript ? [] : [['l', 'latest']];
  const nextMatch: Hint[] = searchHit !== null && matchRows.length > 1 && meetingView === 'transcript'
    ? [['n', `next match · ${(searchHit % matchRows.length) + 1} of ${matchRows.length}`]] : [];
  // One order everywhere: what can be done here, then moving, then Esc. The way back to
  // the meetings comes early, so a narrow window keeps it.
  const hints: Hint[] = atHome && attention.length ? [['Enter', 'guided setup'], ...byHand, ['f', 'import']]
    : historyOpen && searchQuery.trim() ? visibleEntries.length ? [['Enter', 'read'], ['/', 'search again'], ['Esc', 'clear search'], ['↑↓', 'choose']]
      : [['/', 'search again'], ['Esc', 'clear search']]
    : historyOpen && !navigationItems.some((item) => item.kind === 'record') ? [...byHand, ['f', 'import'], ['/', 'search']]
    : historyOpen ? [['Enter', 'read'], ...byHand, ['/', 'search'], ['f', 'import'], ['↑↓', 'choose']]
    : currentRecordBusy || showingLiveTranscript ? [
      ...(activeBackgroundEntry && currentRecordBusy || view === 'live' ? byHand.filter(([key]) => key === 'space') : []),
      ...latest, ['h', 'meetings'], ['i', 'audio help'], ['↑↓', 'scroll']]
    : !currentRecord?.transcript.length ? [...byHand, ['h', 'meetings'], ['f', 'import']]
    : !currentMeeting ? [...watch, ['h', 'meetings'], ['r', 'name speakers'], ['m', 'make it a meeting'], ['c', 'copy'], ['↑↓', 'scroll']]
    : meetingView === 'notes' ? [
      // A call where your side was missing says what to do next, first.
      ...(yourSide ? [['i', 'check your mic'] as Hint] : []),
      ...(hasNotes ? [['a', 'ask'], ['h', 'meetings'], ...watch, ['g', 'rewrite notes'], ['c', 'copy'], ['↑↓', 'scroll']] as Hint[]
        : [['g', 'write notes'], ['h', 'meetings'], ...watch] as Hint[])]
    : meetingView === 'chat' ? [['a', 'ask'], ['h', 'meetings'], ['c', 'copy'], ['↑↓', 'scroll']]
    : [...nextMatch, ...watch, ['h', 'meetings'], ['r', 'name speakers'], ['a', 'ask'], ['e', 'export'], ['c', 'copy'], ['↑↓', 'scroll']];

  // Today's meetings show their time, older ones their day, in one column against the right edge.
  const listRowWidth = (layout.compact ? terminal.columns - 2 : layout.sidebarWidth - 2) - 2;
  const dateColumn = Math.max(0, ...navigationItems.slice(sidebarStart, sidebarStart + listCapacity)
    .map((item) => item.kind === 'record' ? listWhen(item.entry.createdAt, new Date(statusNow)).length : 0));
  const list = (
    <Box width={layout.compact ? undefined : layout.sidebarWidth} flexGrow={layout.compact ? 1 : 0} flexShrink={0}
      flexDirection="column" overflow="hidden" paddingRight={layout.compact ? 0 : 1}
      {...(layout.compact ? {} : { borderStyle: 'single' as const, borderTop: false, borderBottom: false, borderLeft: false, borderDimColor: true })}
      aria-role="listbox" aria-label="Meetings">
      <Text bold color="cyan" wrap="truncate-end">{searchQuery.trim() ? searchHeading(visibleEntries.length, searchQuery.trim()) : 'Meetings'}</Text>
      {navigationItems.slice(sidebarStart, sidebarStart + listCapacity).map((item, windowIndex) => {
        const index = sidebarStart + windowIndex;
        const selected = selectionIndex === index;
        const label = item.kind === 'record' ? meetingEntryRow(item.entry, listRowWidth, new Date(statusNow), dateColumn,
          videoEntries.has(item.entry.id)) : item.label;
        const [title, date] = truncate(label, listRowWidth).split(VIDEO_MARK);
        const match = searchQuery.trim() && item.kind === 'record' ? item.entry.match : undefined;
        return <React.Fragment key={item.kind === 'record' ? item.entry.id : item.kind}>
          <Text inverse={selected} wrap="truncate-end" aria-role="option" aria-state={{ selected }}>{selected ? '› ' : '  '}{title}
            {date !== undefined && <><Text dimColor={!selected}>{VIDEO_MARK}</Text>{date}</>}</Text>
          {match && <Text wrap="truncate-end">{'  '}<Text dimColor>{formatTuiClock(match.start)}  </Text>
            <Highlighted text={snippetAround(match.text, searchQuery.trim(), listRowWidth - 7)} query={searchQuery} /></Text>}
        </React.Fragment>;
      })}
      {!searchQuery && libraryEntries.length === 0 && <Text dimColor>Your meetings will appear here.</Text>}
    </Box>
  );

  const readerTotal = currentMeeting && meetingView !== 'transcript' ? auxiliaryMeetingLines.length : displayRows.length;
  const readerScroll = currentMeeting && meetingView !== 'transcript' ? transcriptScroll : visibleTranscriptScroll;
  // How much is out of view, as Settings says it: what is below, or once at the end, what is above.
  // A time and speaker pinned at the top take a row of the view.
  const readerShown = readerScroll + visibleRows - (currentMeeting && meetingView !== 'transcript' || timedRows[readerScroll]?.heading === undefined ? 0 : 1);
  const readerMore = readerTotal - readerShown > 0 ? `↓ ${readerTotal - readerShown} more` : readerScroll > 0 ? `↑ ${readerScroll} more` : undefined;
  const searchHighlight = meetingView === 'transcript' ? searchQuery : '';
  // The title says whether Seashell can record; the body says what is missing, or what happens next.
  const homeMessage = attention.length ? <>
    {attention.map((status) => <Text key={status.id} wrap="truncate-end">
      <Text color={FEATURE_STATE_COLOR[status.state]}>{FEATURE_STATE_SYMBOL[status.state]}</Text> {MENU_LABEL[status.id].padEnd(16)}<Text dimColor>{status.summary}</Text>
    </Text>)}
  </> : <>
    <Text>Join a call and recording starts by itself. Words appear here as people speak.</Text>
    <Text dimColor>Notes are written when the call ends.</Text>
  </>;

  const reader = searchPane ? (
    <Box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1} overflow="hidden" aria-label="Matching lines">
      <Box flexShrink={0} marginBottom={1}>
        <Text dimColor wrap="truncate-end">{searchLines.length
          ? `${searchLines.length} ${searchLines.length === 1 ? 'line mentions' : 'lines mention'} "${searchQuery.trim()}"`
          : `Its title mentions "${searchQuery.trim()}"; no line does.`}</Text>
      </Box>
      {/* Measured as the reader is, so the lines wrap to the room beside the list. */}
      <Box ref={transcriptPaneRef} flexGrow={1} flexDirection="column" overflow="hidden">
        {searchLines.flatMap((line) => line.rows).slice(0, visibleRows).map((row, index) => <Box key={index} flexShrink={0} height={1}>
          <Text wrap="truncate-end">{highlighted(row, searchQuery) || ' '}</Text>
        </Box>)}
      </Box>
    </Box>
  ) : (
    <Box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={layout.compact ? 0 : 1} overflow="hidden">
      {currentMeeting && !drawerOnly && (
        <Box flexShrink={0} marginBottom={1} justifyContent="space-between">
          <Text>
            {([
              ['notes', '1 Notes'],
              ['transcript', '2 Transcript'],
              ['chat', '3 Chat'],
            ] as Array<[MeetingView, string]>).map(([candidate, label], index) => (
              <React.Fragment key={candidate}>
                {index > 0 && <Text> </Text>}
                <Text inverse={meetingView === candidate} bold={meetingView === candidate}>{` ${label} `}</Text>
              </React.Fragment>
            ))}
          </Text>
          {readerMore && <Text dimColor>{readerMore}</Text>}
        </Box>
      )}
      <Box ref={transcriptPaneRef} flexGrow={1} minHeight={2} flexDirection="column" overflow="hidden" aria-label="Transcript reader">
        {currentMeeting && meetingView !== 'transcript' ? visibleAuxiliaryMeetingLines.map((line, index) => (
          <Box key={`${meetingView}-${index}`} flexShrink={0} height={1}>
            {transcriptScroll + index < cautionRows.length ? <Text color="yellow" wrap="truncate-end">{line}</Text>
              : line.startsWith(HEADING) ? <Text bold color="cyan" wrap="truncate-end">{line.slice(HEADING.length)}</Text>
              : line.startsWith(SUBHEADING) ? <Text bold wrap="truncate-end">{line.slice(SUBHEADING.length)}</Text>
              : <Text wrap="truncate-end">{line || ' '}</Text>}
          </Box>
        )) : visibleTranscriptRows.length === 0 ? (
          view === 'live' && paused ? homeMessage : (
            <Text dimColor>{view === 'live'
              ? transcribingCount > 0 ? 'Preparing transcript…' : 'Speak to transcribe · the first words take a moment'
              : backgroundMessage ?? 'No transcript text'}</Text>
          )
        ) : visibleTranscriptRows.map((row, index) => <Box key={index} flexShrink={0} height={1}>
          {/* The line n is on is marked in full; the other matches are only underlined. */}
          <Text wrap="truncate-end">{highlighted(row.text, searchHighlight,
            currentMatch !== undefined && row.start !== timedRows[currentMatch]?.start) || ' '}</Text>
        </Box>)}
      </Box>
    </Box>
  );

  const notesSheet = notesSetup && currentMeeting ? (() => {
    const applied = currentMeeting.ai?.off ? undefined : (() => {
      try {
        return meetingInstructions(libraryRoot, {
          title: currentMeeting.title,
          ...(currentMeeting.calendar?.title ? { calendarTitle: currentMeeting.calendar.title } : {}),
          ...(currentMeeting.ai?.template ? { template: currentMeeting.ai.template } : {}),
        }).template?.name;
      } catch { return undefined; }
    })();
    const template = currentMeeting.ai?.template === NO_TEMPLATE ? 'None (summary and claims only)'
      : currentMeeting.ai?.template ?? `Auto · ${applied ?? 'General'} from the title`;
    const rows: Array<[string, string]> = [
      ['Template', `‹ ${template} ›`],
      ['Note', notesSetup.editing !== undefined ? `${notesSetup.editing}█` : currentMeeting.ai?.note ?? '— Enter to add, e.g. "Capture pricing"'],
      ['AI', currentMeeting.ai?.off ? '‹ Off › no notes or chat; agents are refused it' : '‹ On ›'],
    ];
    return <Sheet>
      {rows.map(([label, value], index) => (
        <Text key={label} inverse={index === notesSetup.row} wrap="truncate-end">{index === notesSetup.row ? '› ' : '  '}{label.padEnd(10)}{value}</Text>
      ))}
    </Sheet>;
  })() : null;
  const namedSpeakers = currentRecord?.speakers ?? [];
  const speakerName = (speaker: (typeof namedSpeakers)[number]) =>
    `${speakerDisplayName(speaker.id, speaker.label)}${speaker.suggestion ? ' · suggested' : ''}`;
  const speakerColumn = Math.min(32, Math.max(18, ...namedSpeakers.map((speaker) => speakerName(speaker).length))) + 2;
  const speakerSheet = speakerPickerOpen && currentRecord ? <Sheet>
    {namedSpeakers.map((speaker, index) => {
      const said = currentRecord.transcript.find((segment) => segment.speaker === speaker.id)?.text ?? '';
      return <Text key={speaker.id} inverse={index === speakerSelection} wrap="truncate-end">
        {index === speakerSelection ? '› ' : '  '}{truncate(speakerName(speaker), speakerColumn - 1).padEnd(speakerColumn)}
        <Text dimColor={index !== speakerSelection}>“{said}”</Text>
      </Text>;
    })}
    {namedSpeakers.some((speaker) => speaker.suggestion) && <Box marginTop={1}>
      <Text dimColor wrap="wrap">Suggested names come from voices you named before.</Text>
    </Box>}
  </Sheet> : null;
  const helpSheet = helpMode ? <Sheet>
    {HELP_ROWS.map(([group, keys]) => <HelpRow key={group} group={group} keys={keys} />)}
  </Sheet> : null;

  // Questions and typed answers take the key bar's row. Their keys are never cut.
  const suggested = speakerPickerOpen ? currentRecord?.speakers[speakerSelection]?.suggestion ? currentRecord.speakers[speakerSelection] : undefined : undefined;
  const prompt: Omit<React.ComponentProps<typeof Prompt>, 'columns'> | undefined = chatInputState
    ? { text: 'Ask:', input: chatInputState.input, hints: [['Enter', 'send'], ['Esc', 'cancel']] }
    : renameState ? { text: `Name for ${renameState.label}:`, short: 'Name:', input: renameState.input, hints: [['Enter', 'save'], ['Esc', 'cancel']] }
    : searchMode ? { text: 'Search:', input: searchQuery, hints: [['Enter', 'choose'], ['Esc', 'cancel']] }
    : exportMode ? { text: 'Export', hints: [['s', 'subtitles'], ['t', 'text'], ['j', 'data'], ['Esc', 'cancel']] }
    : confirmTrashId ? { text: `Move "${selectedRecord?.title ?? 'this meeting'}" to the Trash?`, short: 'Move it to the Trash?',
      hints: [['y', 'move'], ['n', 'keep']] }
    : confirmRewrite ? { text: 'Rewrite these notes? This replaces them.', short: 'Rewrite and replace these notes?', hints: [['y', 'rewrite'], ['n', 'keep']] }
    : confirmStop ? { text: 'Stop recording? Everything so far is kept.', short: 'Stop recording?', hints: [['y', 'stop'], ['n', 'keep recording']] }
    : consentPending && !approvalPending && consentTitle ? { text: `Record "${consentTitle}"?`, short: 'Record this call?',
      hints: [['y', 'record'], ['n', 'ignore']] }
    : undefined;
  const write: Hint[] = currentMeeting?.ai?.off ? [] : [['Enter', hasNotes ? 'rewrite notes' : 'write notes']];
  const sheetHints: Hint[] | undefined = notesSetup ? notesSetup.editing !== undefined ? [['Enter', 'save'], ['Esc', 'cancel']]
      : [...(notesSetup.row === 1 ? [['Enter', 'edit note'] as Hint] : [...write, ['←→', 'change'] as Hint]), ['↑↓', 'choose'], ['Esc', 'back']]
    : speakerPickerOpen ? suggested ? [['y', 'keep'], ['n', `not ${suggested.label}`], ['Enter', 'rename'], ['↑↓', 'choose'], ['Esc', 'back']]
      : [['Enter', 'name'], ['↑↓', 'choose'], ['Esc', 'back']]
    : helpMode ? [['Esc', 'back']]
    : audioHelpOpen ? [['o', 'Sound settings'], ['p', 'Privacy'], ['Esc', 'back']]
    : undefined;

  const statusProps = showBackgroundStatus ? {
    mode: backgroundRecording ? backgroundWatch?.phase === 'recording' && backgroundWatch.sessionId === backgroundEntry?.id ? captureRecordingMode(backgroundEntry?.captureHealth) : 'unavailable' as RecordingMode
      : view === 'live' && backgroundWatch?.phase === 'awaiting-consent' ? 'awaiting-consent' as RecordingMode
      : backgroundEntry?.captureState === 'processing' ? 'processing' as RecordingMode
      : backgroundEntry?.captureState === 'ready' ? 'ready' as RecordingMode
      : backgroundEntry?.captureState === 'failed' || backgroundEntry?.captureState === 'interrupted' ? 'unavailable' as RecordingMode
      : backgroundWatch?.phase === 'watching' ? 'watching' as RecordingMode : 'unavailable' as RecordingMode,
    title: view === 'live' && backgroundWatch?.phase === 'awaiting-consent' ? backgroundWatch.candidate?.title : backgroundEntry?.title,
    health: backgroundEntry?.captureHealth,
    elapsedSeconds: backgroundEntry ? (statusNow - new Date(backgroundEntry.createdAt).getTime()) / 1000 : undefined,
    savedThroughSeconds: backgroundEntry?.audioSavedThroughMs === undefined
      ? backgroundEntry?.captureState === 'ready' ? backgroundEntry.duration : undefined
      : backgroundEntry.audioSavedThroughMs / 1000,
    draftLabel: backgroundEntry?.captureState === 'recording'
      ? backgroundEntry.draftStatus?.stage === 'delayed' ? 'Live transcript delayed · final pass will retry'
        : backgroundEntry.draftStatus?.stage === 'transcribing' ? 'Live transcript updating…'
        : backgroundEntry.draftStatus?.stage === 'live' ? 'Live draft · updates as people speak'
        : 'Live transcript waiting for speech'
      : backgroundEntry?.captureState === 'processing' ? 'Final transcript in progress' : undefined,
    warning: (view === 'live' || backgroundRecording) && backgroundWatch?.warning ? backgroundWatch.warning
      : backgroundRecording && !backgroundWatch ? 'The recorder has not confirmed its status. Check seashell meeting watch status.' : undefined,
    approvalPending,
    nowUnixMs: statusNow,
  } : view === 'live' ? {
    mode: (paused ? automaticCandidate ? 'awaiting-consent' : automaticMeetingEnabled ? 'watching' : 'paused' : captureRecordingMode(liveHealth)) as RecordingMode,
    title: automaticCandidate?.title,
    health: liveHealth,
    elapsedSeconds: (statusNow - (liveSessionStartedAt.current ?? statusNow)) / 1000,
    savedThroughSeconds: Math.max(0, ...(captureSessionStore.current?.manifest.chunks.map(chunk => chunk.endMs / 1000) ?? [])),
    draftLabel: paused ? undefined : transcribingCount ? 'Live transcript updating…' : liveRecord.transcript.length ? 'Live draft' : 'Live transcript waiting for speech',
    nowUnixMs: statusNow,
  } : undefined;
  const summary = statusProps ? recordingSummary(statusProps) : undefined;
  const quietlyDone = statusProps?.mode === 'ready' && !summary?.alert && summary?.label === 'Saved · transcript ready';
  const recordingElsewhere = activeBackgroundEntry && backgroundEntry?.id !== activeBackgroundEntry.id ? activeBackgroundEntry : undefined;
  // Home, before Seashell can record: the title says so, the body says what is missing.
  const settingUp = attention.length > 0 && view === 'live' && statusProps?.mode === 'watching';
  const recordHeading = currentRecord && view === 'record' ? { text: [currentRecord.title, meetingWhen(currentRecord.createdAt),
    ...(currentEntry?.duration ? [`${Math.max(1, Math.round(currentEntry.duration / 60))} min`] : [])].join(' · ') } : undefined;
  // The title names what is on screen; a call waiting to be recorded is asked about in the key bar,
  // and another call recording is said in the status slot.
  const heading: { text: string; color?: 'yellow'; keep?: number } = settingUp ? { text: "Can't record yet", color: 'yellow' }
    // Narrow, the meeting's title gives way before what is happening to it. What is happening keeps the
    // title's colour whatever happens: only the alert beside it says something is wrong.
    : summary && !quietlyDone ? { text: summary.headline, keep: Bun.stringWidth(summary.label) }
    // A long meeting title is cut before a warning beside it.
    : recordHeading ? { ...recordHeading, keep: 24 } : { text: '' };
  // Says the recorder is on, so a quiet screen never reads as a stopped one.
  const standing = watchOwnership === 'external' && backgroundWatch?.phase === 'watching' && statusProps?.mode !== 'watching'
    && !(summary && !quietlyDone) ? { text: 'Watching for calls' }
    : currentMeeting?.status === 'reconciling' || currentMeeting?.status === 'observing' ? { text: 'Writing notes…' } : undefined;
  // Warnings take the title's status slot, most urgent first; nothing adds a row under the title.
  // The slot says only what is wrong; the key that fixes it leads the key bar, and a fix in
  // Settings opens Settings on the row that fixes it.
  const slot: (TitleStatus & { focus?: FeatureId }) | undefined = recordingElsewhere
    ? { text: '● Another call is recording', short: '● Another call', fix: ['l', 'go to the call'] }
    : summary?.alert && !quietlyDone ? summary.alert
    : currentMeeting?.status === 'failed' ? { text: 'Notes failed', color: 'red', fix: ['g', 'retry notes'] }
    : attention[0] && !settingUp ? attentionStatus(attention[0])
    : currentMeeting && meetingView === 'transcript' && reading && showSpeakers && currentRecord?.speakers.some((speaker) => speaker.id === 'SYSTEM')
      ? { text: 'Voices not separated', color: 'yellow', fix: [',', 'speaker setup'], focus: 'speaker-separation' }
    : standing;
  shownSlot.current = slot;
  const toast = error ? { text: error, color: 'red' as const } : copied ? { text: 'Copied.', color: 'green' as const } : notice ?? undefined;

  // Audio help leads with what Seashell found: during a call, what the source sent and since when;
  // after one, that your side was missing; at home, what the last meeting heard.
  const startedAt = showBackgroundStatus ? backgroundEntry ? Date.parse(backgroundEntry.createdAt) : undefined
    : liveSessionStartedAt.current ?? undefined;
  const silentSetup = attention.find((status) => (status.id === 'microphone' || status.id === 'computer-audio') && status.summary.includes('silent'));
  const live = summary?.alert && statusProps?.mode !== 'ready' && statusProps?.mode !== 'processing'
    ? sourceFinding(statusProps?.health, startedAt, statusNow) : undefined;
  const finding: { text: string; source: 'microphone' | 'computer'; color: 'red' | 'yellow' } | undefined = live
    ? { ...live, color: summary!.alert!.color }
    : yourSide && view === 'record' ? { text: yourSide, source: 'microphone', color: 'yellow' }
    : silentSetup ? { text: silentSetup.detail, source: silentSetup.id === 'microphone' ? 'microphone' : 'computer', color: 'yellow' }
    : undefined;
  const sheetWidth = terminal.columns - 2;
  // Each step's wrapped lines hang under its words, not its number.
  const step = (number: number, text: string) => <Box key={number} flexShrink={0}>
    <Box width={3} flexShrink={0}><Text>{number}.</Text></Box>
    <Paragraph text={text} width={sheetWidth - 3} />
  </Box>;
  const audioSheet = audioHelpOpen ? <Sheet>
    {finding && <Box flexShrink={0} marginBottom={1}><Paragraph text={finding.text} width={sheetWidth} color={finding.color} /></Box>}
    {step(1, 'Check the right microphone is chosen and its level moves.')}
    {step(2, 'Check Seashell Microphone is allowed in Privacy & Security.')}
  </Sheet> : null;
  const sheet = helpSheet ?? audioSheet ?? notesSheet ?? speakerSheet;
  // A sheet's name takes the title line, as a screen's does; what is wrong stays in the status slot.
  const sheetName = helpSheet ? 'Keys' : audioSheet ? finding?.source === 'microphone' ? 'Mic help' : 'Audio help'
    : notesSheet ? 'Notes setup' : speakerSheet ? 'Name a speaker' : undefined;

  return (
    <Box flexDirection="column" paddingX={1} height={terminal.rows} overflow="hidden">
      {sheetName ? <ScreenTitle name={sheetName} status={slot} />
        : <ScreenTitle name={heading.text} bold={Boolean(heading.color)} {...(heading.color ? { color: heading.color } : {})}
          {...(heading.keep ? { keep: heading.keep } : {})}
          {...(summary?.detail && !quietlyDone ? { detail: summary.detail } : {})} status={slot} />}
      {sheet ?? <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {historyOpen && list}
        {!drawerOnly && reader}
      </Box>}
      <Box flexShrink={0}>
        {prompt ? <Prompt {...prompt} color="yellow" columns={terminal.columns - 2} />
          : processing ? <Text dimColor wrap="truncate-end">◐ {processing.label}{processing.progress === undefined ? '' : ` ${processing.progress}%`}</Text>
          : toast ? <Toast text={toast.text} color={toast.color} columns={terminal.columns - 2} />
          : sheetHints ? <KeyBar hints={sheetHints} columns={terminal.columns - 2} help={false} />
          : <KeyBar hints={withFix(hints, slot)} columns={terminal.columns - 2} />}
      </Box>
    </Box>
  );
}

const searchPattern = (needle: string, flags: string) => new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), flags);

/** Every place a row says what was searched for, in the transcript's yellow: filled, or underlined when another match is current. */
function highlighted(row: string, query: string, soft = false): string {
  const needle = query.trim();
  return needle ? row.replace(searchPattern(needle, 'giu'), (match) => (soft ? SOFT_HIGHLIGHT : HIGHLIGHT)(match)) : row;
}

/** A dim line with what was searched for in the transcript's yellow, at full strength. */
function Highlighted(props: { text: string; query: string }) {
  const needle = props.query.trim();
  // Split around a captured match, the text and the matches alternate.
  const parts = needle ? props.text.split(new RegExp(`(${searchPattern(needle, 'u').source})`, 'giu')) : [props.text];
  return <>{parts.map((part, index) => index % 2
    ? <Text key={index} color="black" backgroundColor="yellow">{part}</Text>
    : <Text key={index} dimColor>{part}</Text>)}</>;
}

/** The list's heading during a search: how many meetings say it, and what was searched for. */
function searchHeading(count: number, query: string): string {
  return `${count === 0 ? 'No meeting mentions' : count === 1 ? '1 meeting mentions' : `${count} meetings mention`} "${query}"`;
}

/** A setup problem in the title's status slot: what is wrong in a word or two. The key that helps
 * leads the key bar: audio help for a silent source, otherwise Settings, opened on the row that fixes it. */
function attentionStatus(status: FeatureStatus): TitleStatus & { focus: FeatureId } {
  const silent = status.summary.includes('silent');
  const [what, fix] = status.id === 'recorder' ? [status.state === 'attention' ? 'Recorder not responding' : 'Recorder off', 'fix recorder']
    : status.id === 'microphone' ? silent ? ['Mic silent', 'mic help'] : ['Mic not allowed', 'allow mic']
    : status.id === 'computer-audio' ? silent ? ['Computer audio silent', 'audio help'] : ['Computer audio unconfirmed', 'check audio']
    : status.id === 'detection' ? ['Meet not connected', 'connect Meet']
    : [`${MENU_LABEL[status.id]} needs you`, 'settings'];
  return { text: what, color: 'yellow', fix: [silent ? 'i' : ',', fix], focus: status.id };
}
