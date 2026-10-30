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
import { HEADING, meetingViewLines, type MeetingView } from './meeting-tui.ts';
import { HELP_ROWS, HelpRow, KeyBar, Sheet, type Hint } from './tui-chrome.tsx';
import { transcriptRows, wrappedMeetingRows, MouseScrollDecoder } from './transcript-viewport.ts';
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
import SpeakerSettings from './SpeakerSettings.tsx';
import SettingsScreen from './SettingsScreen.tsx';
import { readFeatureStatuses, type FeatureStatus } from './feature-status.ts';
import { stripVTControlCharacters } from 'util';
import { startMeetSpeakerReader, meetBrowserMatchesApp, probeMeetSpeakers, type MeetSpeakerReader, type MeetProbe } from './meet-speakers.ts';
import { backgroundMeetingMessage } from './background-meeting-status.ts';
import { readBackgroundWatchStatus, type BackgroundWatchStatus } from './background-watch-status.ts';
import { writeMeetingConsent } from './meeting-consent.ts';
import { CaptureHealthTracker, type CaptureHealthSnapshot } from './capture-health.ts';
import { captureRecordingMode, recordingSummary, type RecordingMode } from './RecordingStatus.tsx';
import { diarizationStatus } from './diarization-environment.ts';
import { identifySavedSpeakers } from './speaker-reprocessing.ts';
import { runHumainTranscription } from './humain-client.ts';
import {
  DEFAULT_WHISPER_MODEL_FILENAME,
} from './model-config.ts';
import {
  meetingEntryRow,
  sameDay,
  meetingWhen,
  moveSelection,
  moveTranscriptScroll,
  formatTuiClock,
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

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(__filename), '..');
const WHISPER_SERVER = join(PROJECT_ROOT, 'whisper.cpp/build/bin/whisper-server');
const MODEL_PATH = join(PROJECT_ROOT, 'models', DEFAULT_WHISPER_MODEL_FILENAME);
const HIGHLIGHT = new Chalk({ level: 1 }).black.bgYellow;

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

export default function App(props: { libraryDir?: string } = {}) {
  const { exit } = useApp();
  const [config, setConfig] = useState(() => loadConfig());
  const [speakerSetupOpen, setSpeakerSetupOpen] = useState(false);
  const [meetSpeakerStatus, setMeetSpeakerStatus] = useState<MeetProbe>();
  const [captureAppBundle, setCaptureAppBundle] = useState<string>();
  const [aiSetupOpen, setAiSetupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Speakers and AI open from Settings return there when closed.
  const [returnToSettings, setReturnToSettings] = useState(false);
  const [attention, setAttention] = useState<FeatureStatus[]>([]);
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
  const [notice, setNotice] = useState<string | null>(null);
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
  /** [N] Notes setup for the open meeting: its template, its note, and whether AI may see it. */
  const [notesSetup, setNotesSetup] = useState<{ row: 0 | 1 | 2; options: string[]; editing?: string } | null>(null);
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
  const [jumpTo, setJumpTo] = useState<string | null>(null);
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
      setNotice(`${recoverable.length} recoverable live capture${recoverable.length === 1 ? '' : 's'} found · run seashell capture list`);
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
        if (saved.meetingWarning) setNotice(saved.meetingWarning);
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
      onState: (update) => {
        if (generation !== liveSessionGeneration.current || healthTracker !== liveHealthTracker.current) return;
        if (healthTracker) setLiveHealth(healthTracker.state('systemAudio', update));
        if (update.state === 'unavailable' && update.message) {
          setNotice(`System audio unavailable; continuing with microphone only. ${update.message}`);
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
  const displayRows = useMemo(() => currentRecord
    ? transcriptRows(currentRecord, contentColumns, { timestamps: showTimestamps, speakers: showSpeakers })
    : [], [currentRecord, contentColumns, showTimestamps, showSpeakers]);
  const visibleRows = Math.max(1, transcriptContentRows ?? layout.visibleTranscriptRows);
  const sidebarStart = Math.max(
    0,
    selectionIndex - layout.visibleLibraryItems + 1,
  );
  const showingLiveTranscript = meetingView === 'transcript' && (view === 'live' || currentEntry?.captureState === 'recording');
  const latestTranscriptScroll = Math.max(0, displayRows.length - visibleRows);
  const visibleTranscriptScroll = showingLiveTranscript && followLiveTranscript
    ? latestTranscriptScroll
    : Math.min(transcriptScroll, latestTranscriptScroll);
  const visibleTranscriptRows = displayRows.slice(
    visibleTranscriptScroll,
    visibleTranscriptScroll + visibleRows,
  );
  // Opened from a search: land on the words that were searched for.
  // The rows rewrap once the list closes, so this holds until the person moves.
  useEffect(() => {
    if (!jumpTo || !displayRows.length) return;
    const needle = jumpTo.toLocaleLowerCase();
    const rows = displayRows.map((text) => stripVTControlCharacters(text).toLocaleLowerCase());
    const within = rows.findIndex((text) => text.includes(needle));
    // A phrase can wrap across two rows.
    const row = within >= 0 ? within
      : rows.findIndex((text, index) => `${text.trimEnd()} ${(rows[index + 1] ?? '').trim()}`.includes(needle));
    if (row >= 0) setTranscriptScroll(Math.max(0, row - 1));
  }, [jumpTo, displayRows]);
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
        const record = await saveFinalizedCapture(store, libraryRoot, reason, {
          title: current.title,
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
      setNotice('The live meeting observer is finishing its current window. Try again in a moment.');
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
    setProcessing({ label: finishLive ? 'Finishing capture…' : 'Preparing meeting enrichment…' });
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
        if (missingObserver || missingReconciliation) {
          refreshLibrary();
          setNotice('Meeting saved. Connect AI for notes, or return to your transcript.');
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
          onStatus: (label) => setProcessing({ label }),
        });
        if (finishLive) {
          liveMeetingRef.current = artifact;
          setLiveMeeting(artifact);
        } else {
          commitMeetingState(artifact);
        }
        refreshLibrary();
        setMeetingView('notes');
        setNotice(finishLive
          ? 'Meeting capture, final transcript, notes, and analysis are ready.'
          : 'Meeting notes and analysis are ready.');
      } catch (meetingError) {
        setError(meetingError instanceof Error ? meetingError.message : String(meetingError));
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
      setNotice(`Upcoming: ${calendarSuggestion.title} · waiting for meeting audio.`);
    } else if (policy === 'all' || policy === 'selected-calendars') {
      markCurrentAsMeeting(calendarSuggestion);
    } else if (policy === 'ask') {
      setNotice(`Meeting starting: ${calendarSuggestion.title}. Press M to attach it.`);
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
      setNotice(`Meeting observer paused: ${
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

  const auxiliaryMeetingLines = useMemo(() => (
    currentMeeting && meetingView !== 'transcript'
      ? wrappedMeetingRows(meetingViewLines(currentMeeting, meetingView, currentRecord ?? undefined), contentColumns)
      : []
  ), [currentMeeting, meetingView, currentRecord, contentColumns]);
  const visibleAuxiliaryMeetingLines = auxiliaryMeetingLines.slice(
    transcriptScroll,
    transcriptScroll + visibleRows,
  );
  const scrollItemCount = currentMeeting && meetingView !== 'transcript'
    ? auxiliaryMeetingLines.length
    : displayRows.length;
  const scrollVisibleRows = visibleRows;
  const scrollTranscriptBy = (delta: number) => {
    const next = moveTranscriptScroll(
      meetingView === 'transcript' ? visibleTranscriptScroll : transcriptScroll,
      delta, scrollItemCount, scrollVisibleRows,
    );
    setTranscriptScroll(next);
    if (showingLiveTranscript) setFollowLiveTranscript(next >= latestTranscriptScroll);
  };

  const copyCurrentView = useCallback(() => {
    if (!currentRecord) return;
    const text = currentMeeting && meetingView !== 'transcript'
      ? meetingViewLines(currentMeeting, meetingView, currentRecord).join('\n').replaceAll(HEADING, '')
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
      setNotice(`Exported ${format.toUpperCase()}.`);
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
        setNotice(`${message} Manual recording is still available.`);
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
          setNotice(`Possible ${action.candidate.appName} meeting · press M to record or X to ignore.`);
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
      setNotice('Finishing the current operation before quitting…');
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
  const mouseEnabled = !speakerSetupOpen && !aiSetupOpen && !chatInputState && !renameState && !speakerPickerOpen && !searchMode && !exportMode && !confirmTrashId && !notesSetup;

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
    setJumpTo(null);
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
        if (currentRecord && renameState.input.trim()) {
          try {
            const renamed = renameTranscriptSpeaker(
              libraryRoot,
              currentRecord.id,
              renameState.speakerId,
              renameState.input,
            );
            if (view === 'live') {
              liveRecordRef.current = renamed;
              setLiveRecord(renamed);
            } else {
              setSelectedRecord(renamed);
            }
            const meeting = loadMeetingArtifact(libraryRoot, renamed.id);
            if (meeting) commitMeetingState(meeting);
            refreshLibrary();
            setNotice(`${renameState.label} is now ${renameState.input.trim()}. Notes kept.`);
          } catch (renameError) {
            setError(renameError instanceof Error ? renameError.message : String(renameError));
          }
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
      if (key.upArrow) setSpeakerSelection((index) => moveSelection(index, -1, speakers.length));
      else if (key.downArrow) setSpeakerSelection((index) => moveSelection(index, 1, speakers.length));
      else if (key.return) {
        const speaker = speakers[speakerSelection];
        setSpeakerPickerOpen(false);
        if (speaker) setRenameState({ speakerId: speaker.id, input: '',
          label: speaker.id === 'LOCAL' && speaker.label === 'Microphone' ? 'You' : speaker.label });
      }
      return;
    }

    if (searchMode) {
      if (key.escape) {
        setSearchMode(false);
        setSearchQuery('');
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
          setNotice('Transcript moved to the library Trash folder.');
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
      if (key.escape || input === 'n' || key.return && notesSetup.row !== 1) {
        setNotesSetup(null);
        if (currentMeeting && !currentMeeting.ai?.off) setNotice('Press g to rewrite the notes with these choices.');
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
      if (searchQuery) setSearchQuery('');
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
    if (watchOwnership === 'external' && (input === 'm' || input === 'x') && backgroundWatch?.phase === 'awaiting-consent') {
      const current = readBackgroundWatchStatus(libraryRoot);
      if (current?.phase !== 'awaiting-consent' || !current.consentId || current.consentId !== backgroundWatch.consentId) {
        refreshLibrary(); setNotice('The meeting request changed. Check its current status before recording.'); return;
      }
      try {
        writeMeetingConsent(input === 'm' ? 'approve' : 'decline', undefined, Date.now(), current.consentId);
        setBackgroundApproval(current.consentId);
        setNotice(input === 'm' ? 'Start requested. Waiting for the recorder to confirm.' : 'Ignore requested.');
      } catch (cause) { setError(`Could not send the meeting decision: ${cause instanceof Error ? cause.message : String(cause)}`); }
      return;
    }
    if (currentRecordBusy && ['r', 'd', 'g', 'a', 'e', 'm'].includes(input)) {
      setNotice('Review and edit this when it finishes.');
      return;
    }
    if (input === ',') { setSettingsOpen(true); return; }
    if (input === 'v') { setSpeakerSetupOpen(true); return; }
    if (input === 'p') { setAiSetupIntent(null); setAiSetupOpen(true); return; }
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
      if (automaticCandidate) {
        const approved = meetingAutomationController.current.approve();
        setAutomationPhase(meetingAutomationController.current.state.phase);
        setAutomaticCandidate(null);
        if (approved) {
          void beginAutomaticMeeting(approved).catch((automationError: unknown) => {
            setError(automationError instanceof Error ? automationError.message : String(automationError));
          });
        }
      } else if (currentRecord?.transcript.length) {
        markCurrentAsMeeting(view === 'live' ? calendarSuggestion ?? undefined : undefined);
      }
      return;
    }
    if (input === 'x' && automaticCandidate) {
      meetingAutomationController.current.decline();
      setAutomationPhase(meetingAutomationController.current.state.phase);
      setAutomaticCandidate(null);
      setNotice(`Ignored ${automaticCandidate.appName} for this detection window.`);
      return;
    }
    if (input === 'n' && currentMeeting) {
      let names: string[] = [];
      try { names = loadMeetingTemplates(libraryRoot).map((template) => template.name); } catch {}
      setNotesSetup({ row: 0, options: ['auto', ...names, NO_TEMPLATE] });
      return;
    }
    if (input === 'g' && currentMeeting) {
      if (currentMeeting.ai?.off) {
        setNotice('AI is off for this meeting. Press n to turn it on.');
        return;
      }
      if (currentMeeting.analysis?.final) { setConfirmRewrite(true); return; }
      runCurrentMeetingEnrichment(view === 'live');
      return;
    }
    if (input === 'a' && currentMeeting) {
      if (currentMeeting.ai?.off) {
        setNotice('AI is off for this meeting. Press n to turn it on.');
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
    if (input === 'e' && currentRecord?.transcript.length) {
      setExportMode(true);
      return;
    }
    if (input === 'r' && currentRecord?.speakers.length) {
      // Start on the first person still without a real name.
      setSpeakerSelection(Math.max(0, currentRecord.speakers.findIndex((speaker) => /^Remote speaker \d/u.test(speaker.label))));
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
    if (input === ' ' && activeBackgroundEntry) {
      setNotice('Recording stops by itself when the call ends.');
      return;
    }
    if (input === ' ' && watchOwnership === 'external' && !activeBackgroundEntry) {
      setNotice('Recording starts by itself when you join a call. Recording by hand is not available yet.');
      return;
    }
    if ((input === ' ' || key.return) && view === 'live' && !historyOpen) {
      if (pausedRef.current && watchOwnership === 'external') {
        setNotice('Recording starts by itself when you join a call. Recording by hand is not available yet.');
        return;
      }
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
          -layout.visibleLibraryItems,
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
          layout.visibleLibraryItems,
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
        setJumpTo(searchQuery.trim());
      }
    }
  }, { isActive: !aiSetupOpen && !speakerSetupOpen && !settingsOpen });

  // A quiet footer nudge when something needed for recording meetings is broken.
  useEffect(() => {
    if (settingsOpen) return;
    const controller = new AbortController();
    void readFeatureStatuses({ config, libraryDir: libraryRoot, signal: controller.signal })
      .then(statuses => { if (!controller.signal.aborted) setAttention(statuses.filter(status => !status.optional && (status.state === 'broken' ||
        (status.state === 'attention' && (status.id === 'microphone' || status.id === 'computer-audio'))))); })
      .catch(() => {});
    return () => controller.abort();
  }, [settingsOpen, libraryRoot, backgroundWatch?.phase]);

  const connectMeetReader = () => {
    updateMeetingConfig({ speakerBrowser: 'auto' });
    setConfig(current => ({ ...current, meeting: { ...current.meeting, speakerBrowser: 'auto' } }));
    setMeetSpeakerStatus(undefined);
  };
  const closeSubSettings = () => {
    if (!returnToSettings) return;
    setReturnToSettings(false);
    setSettingsOpen(true);
  };

  if (settingsOpen) return <SettingsScreen config={config} libraryDir={libraryRoot} columns={terminal.columns} rows={terminal.rows}
    onConnectMeet={connectMeetReader}
    onEnableCalendar={() => {
      const policy = config.meeting?.calendar?.policy ?? 'ask';
      updateMeetingConfig({ calendar: { enabled: true, policy: policy === 'off' ? 'ask' : policy } });
      setConfig(current => ({ ...current, meeting: { ...current.meeting,
        calendar: { ...current.meeting?.calendar, enabled: true, policy: policy === 'off' ? 'ask' : policy } } }));
    }}
    onOpenSpeakers={() => { setSettingsOpen(false); setReturnToSettings(true); setSpeakerSetupOpen(true); }}
    onOpenAI={() => { setSettingsOpen(false); setReturnToSettings(true); setAiSetupIntent(null); setAiSetupOpen(true); }}
    onClose={() => setSettingsOpen(false)} />;

  if (speakerSetupOpen) return <SpeakerSettings columns={terminal.columns} rows={terminal.rows}
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
          setNotice('Speaker review copy saved. Original transcript and notes unchanged. R names speakers.');
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
      setAiSetupOpen(false);
      closeSubSettings();
      setError(null);
      const names = [...new Set(Object.values(patch.routes ?? {}).flatMap((route) => route ? [route.backend] : []))];
      setNotice(`AI ready · ${names.join(' + ')}`);
    }} />;

  const consentPending = (watchOwnership === 'external' && backgroundWatch?.phase === 'awaiting-consent') || Boolean(automaticCandidate);
  const reading = !historyOpen;
  const hasNotes = Boolean(currentMeeting?.analysis);
  const atHome = view === 'live' && paused && !currentMeeting;
  const hints: Hint[] = consentPending ? [['m', 'record'], ['x', 'ignore']]
    : atHome && attention.length ? [[',', 'fix setup'], ['f', 'import']]
    : !navigationItems.some((item) => item.kind === 'record') && historyOpen ? [['f', 'import'], ['/', 'search']]
    : historyOpen ? [['↑↓', 'choose'], ['Enter', 'read'], ['/', 'search'], ['f', 'import']]
    : currentRecordBusy ? [['↑↓', 'scroll'], ...(followLiveTranscript ? [] : [['l', 'latest'] as Hint]), ['h', 'meetings'], ['i', 'audio']]
    : showingLiveTranscript ? [['↑↓', 'scroll'], ...(followLiveTranscript ? [] : [['l', 'latest'] as Hint]), ['h', 'meetings'], ['i', 'audio']]
    : !currentRecord?.transcript.length ? [['h', 'meetings'], ['f', 'import']]
    : !currentMeeting ? [['↑↓', 'scroll'], ['r', 'name speakers'], ['m', 'make it a meeting'], ['c', 'copy'], ['h', 'meetings']]
    : meetingView === 'notes' ? [
      ...(hasNotes ? [['↑↓', 'scroll'], ['h', 'meetings'], ['a', 'ask'], ['c', 'copy'], ['g', 'rewrite notes']] as Hint[] : [['g', 'write notes'], ['h', 'meetings']] as Hint[]),
      ['n', 'notes options'],
    ]
    : meetingView === 'chat' ? [['a', 'ask'], ['h', 'meetings'], ['↑↓', 'scroll'], ['c', 'copy']]
    : [['↑↓', 'scroll'], ['h', 'meetings'], ['r', 'name speakers'], ['a', 'ask'], ['e', 'export'], ['c', 'copy']];

  const list = (
    <Box width={layout.compact ? undefined : layout.sidebarWidth} flexGrow={layout.compact ? 1 : 0} flexShrink={0}
      flexDirection="column" overflow="hidden" paddingRight={layout.compact ? 0 : 1}
      {...(layout.compact ? {} : { borderStyle: 'single' as const, borderTop: false, borderBottom: false, borderLeft: false, borderDimColor: true })}
      aria-role="listbox" aria-label="Meetings">
      <Text bold color="cyan" wrap="truncate-end">
        {searchQuery ? `/ ${searchQuery} · ${visibleEntries.length} found` : searchMode ? '/ Type to search' : 'Meetings'}
      </Text>
      {navigationItems.slice(sidebarStart, sidebarStart + layout.visibleLibraryItems).map((item, windowIndex) => {
        const index = sidebarStart + windowIndex;
        const selected = selectionIndex === index;
        const rowWidth = (layout.compact ? terminal.columns - 2 : layout.sidebarWidth - 2) - 2;
        const label = item.kind === 'record' ? meetingEntryRow(item.entry, rowWidth, new Date(statusNow),
          visibleEntries.some((other) => other.id !== item.entry.id && sameDay(other.createdAt, item.entry.createdAt))) : item.label;
        return <Text key={item.kind === 'record' ? item.entry.id : item.kind} inverse={selected} wrap="truncate-end"
          aria-role="option" aria-state={{ selected }}>{selected ? '› ' : '  '}{truncate(label, rowWidth)}</Text>;
      })}
      {searchQuery && visibleEntries.length === 0 && <Text dimColor>Nothing found. Esc clears the search.</Text>}
      {!searchQuery && libraryEntries.length === 0 && <Text dimColor>Your meetings will appear here.</Text>}
    </Box>
  );

  const readerTotal = currentMeeting && meetingView !== 'transcript' ? auxiliaryMeetingLines.length : displayRows.length;
  const readerScroll = currentMeeting && meetingView !== 'transcript' ? transcriptScroll : visibleTranscriptScroll;
  const searchHighlight = searchQuery.trim() && meetingView === 'transcript'
    ? new RegExp(searchQuery.trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu') : undefined;
  const homeMessage = attention.length ? <>
    <Text bold>Seashell can't record meetings yet.</Text>
    <Text> </Text>
    {attention.map((status) => <Text key={status.id}>{status.label}: {status.summary}</Text>)}
    <Text> </Text>
    <Text>Press <Text bold>,</Text> to fix this.</Text>
  </> : <>
    <Text bold>Seashell is ready.</Text>
    <Text> </Text>
    <Text>Join a call and recording starts by itself. Words appear here as people speak.</Text>
    <Text dimColor>Notes are written when the call ends.</Text>
  </>;

  const reader = (
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
          {readerTotal > visibleRows && <Text dimColor>{Math.min(readerTotal, readerScroll + visibleRows)}/{readerTotal} lines</Text>}
        </Box>
      )}
      <Box ref={transcriptPaneRef} flexGrow={1} minHeight={2} flexDirection="column" overflow="hidden" aria-label="Transcript reader">
        {currentMeeting && meetingView !== 'transcript' ? visibleAuxiliaryMeetingLines.map((line, index) => (
          <Box key={`${meetingView}-${index}`} flexShrink={0} height={1}>
            {line.startsWith(HEADING)
              ? <Text bold color="cyan" wrap="truncate-end">{line.slice(HEADING.length)}</Text>
              : <Text wrap="truncate-end">{line || ' '}</Text>}
          </Box>
        )) : visibleTranscriptRows.length === 0 ? (
          view === 'live' && paused ? homeMessage : (
            <Text dimColor>{view === 'live'
              ? transcribingCount > 0 ? 'Preparing transcript…' : 'Speak to transcribe · the first words take a moment'
              : backgroundMessage ?? 'No transcript text'}</Text>
          )
        ) : visibleTranscriptRows.map((row, index) => <Box key={index} flexShrink={0} height={1}>
          <Text wrap="truncate-end">{(searchHighlight ? row.replace(searchHighlight, (match) => HIGHLIGHT(match)) : row) || ' '}</Text>
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
    return <Sheet title="Notes setup for this meeting">
      {rows.map(([label, value], index) => (
        <Text key={label} inverse={index === notesSetup.row} wrap="truncate-end">{index === notesSetup.row ? '› ' : '  '}{label.padEnd(10)}{value}</Text>
      ))}
    </Sheet>;
  })() : null;
  const namedSpeakers = currentRecord?.speakers ?? [];
  const speakerSheet = speakerPickerOpen && currentRecord ? <Sheet title="Name a speaker">
    {namedSpeakers.map((speaker, index) => {
      const said = currentRecord.transcript.find((segment) => segment.speaker === speaker.id)?.text ?? '';
      const label = speaker.id === 'LOCAL' && speaker.label === 'Microphone' ? 'You' : speaker.label;
      return <Text key={speaker.id} inverse={index === speakerSelection} wrap="truncate-end">
        {index === speakerSelection ? '› ' : '  '}{label.padEnd(20)}<Text dimColor={index !== speakerSelection}>“{said}”</Text>
      </Text>;
    })}
  </Sheet> : null;
  const helpSheet = helpMode ? <Sheet title="Keys">
    {HELP_ROWS.map(([group, keys]) => <HelpRow key={group} group={group} keys={keys} />)}
  </Sheet> : null;
  const audioSheet = audioHelpOpen ? <Sheet title="Audio help">
    <Text>1. Quiet can just mean you are muted or nobody is speaking.</Text>
    <Text>2. Check the right microphone is chosen and its level moves. <Text bold>o</Text> opens Sound.</Text>
    <Text>3. Check Seashell Microphone is allowed. <Text bold>p</Text> opens Privacy.</Text>
  </Sheet> : null;
  const sheet = helpSheet ?? audioSheet ?? notesSheet ?? speakerSheet;

  const prompt = chatInputState ? `Ask: ${chatInputState.input}█  Enter send · Esc cancel`
    : renameState ? `Name for ${renameState.label}: ${renameState.input}█  Enter save · Esc cancel`
    : searchMode ? `Search: ${searchQuery}█  Enter choose · Esc clear`
    : exportMode ? 'Export  s SRT  v WebVTT  t text  j JSON  Esc cancel'
    : confirmTrashId ? 'Move to the Trash folder?  y yes  n no'
    : confirmRewrite ? 'Rewrite these notes? This replaces them.  y yes  n no'
    : notesSetup ? notesSetup.editing !== undefined ? 'Enter save · Esc cancel' : '↑↓ choose · ←→ change · Enter edit note · Esc done'
    : speakerPickerOpen ? '↑↓ choose · Enter name · Esc back'
    : helpMode ? '? or Esc close'
    : audioHelpOpen ? 'o Sound · p Privacy · Esc back'
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
    approvalPending: backgroundWatch?.consentId !== undefined && backgroundApproval === backgroundWatch.consentId,
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
  const quietlyDone = statusProps?.mode === 'ready' && !summary?.problems.length && summary?.color === undefined;
  const recordingElsewhere = activeBackgroundEntry && backgroundEntry?.id !== activeBackgroundEntry.id ? activeBackgroundEntry : undefined;
  const consentOverRecord = view === 'record' && backgroundWatch?.phase === 'awaiting-consent';
  const heading = attention.length && view === 'live' && statusProps?.mode === 'watching'
    ? { text: 'Not recording · finish setup to record meetings', color: 'yellow' as const }
    : consentOverRecord ? { text: `Not recording · record this? · ${backgroundWatch?.candidate?.title}`, color: 'yellow' as const }
    : recordingElsewhere ? { text: `● Another meeting is recording · ${recordingElsewhere.title} · l to open`, color: 'red' as const }
    : summary && !quietlyDone ? { text: summary.headline, color: summary.color }
    : currentRecord && view === 'record' ? { text: [currentRecord.title, meetingWhen(currentRecord.createdAt),
      ...(currentEntry?.duration ? [`${Math.max(1, Math.round(currentEntry.duration / 60))} min`] : [])].join(' · ') }
    : { text: '' };
  const problems = [
    ...((consentOverRecord || recordingElsewhere) && summary && !quietlyDone ? [summary.headline] : []),
    ...(summary?.problems ?? []),
    ...(currentMeeting?.status === 'failed' ? ['The notes failed · g to try again'] : []),
    ...(currentMeeting && meetingView === 'transcript' && reading && showSpeakers &&
      currentRecord?.speakers.some((speaker) => speaker.id === 'SYSTEM')
      ? [currentRecord.speakerAnalysis?.detail ?? 'Source labels only · v to set up speaker names'] : []),
  ];
  const caution = attention.length && !(view === 'live' && statusProps?.mode === 'watching') && !summary?.problems.length
    ? attention[0]!.summary.includes('silent') ? `${attention[0]!.id === 'microphone' ? 'Microphone' : 'Computer audio'}: silent last meeting · i audio help`
    : `${attention[0]!.label}: ${attention[0]!.summary} · , to check` : undefined;
  const toast = error ?? (copied ? 'Copied.' : notice) ?? undefined;
  // Says the recorder is on, so a quiet screen never reads as a stopped one.
  const standing = watchOwnership === 'external' && backgroundWatch?.phase === 'watching' && !recordingElsewhere && !attention.length
    && !(summary && !quietlyDone && statusProps?.mode !== 'watching') ? layout.compact ? 'Watching' : 'Watching for calls'
    : currentMeeting?.status === 'reconciling' || currentMeeting?.status === 'observing' ? 'writing notes…' : undefined;

  return (
    <Box flexDirection="column" paddingX={1} height={terminal.rows} overflow="hidden">
      <Box flexShrink={0} justifyContent="space-between">
        <Text wrap="truncate-end">
          🐚{layout.compact ? '' : <Text> <Text bold color="cyan">Seashell</Text></Text>}
          {heading.text ? '  ' : ''}
          <Text bold={Boolean(heading.color)} {...(heading.color ? { color: heading.color } : {})}>{heading.text}</Text>
          {summary?.detail && !layout.compact && !quietlyDone ? <Text dimColor>  {summary.detail}</Text> : null}
        </Text>
        {standing && <Box flexShrink={0} marginLeft={2}><Text dimColor>{standing}</Text></Box>}
      </Box>
      {problems.map((problem) => <Box key={problem} flexShrink={0}><Text color="red" inverse wrap="truncate-end">{` ${problem} `}</Text></Box>)}
      {caution && <Box flexShrink={0}><Text color="yellow" wrap="truncate-end">{caution}</Text></Box>}
      <Box flexShrink={0}><Text dimColor wrap="truncate-end">{'─'.repeat(Math.max(1, terminal.columns - 2))}</Text></Box>
      {sheet ?? <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {historyOpen && list}
        {!drawerOnly && reader}
      </Box>}
      <Box flexShrink={0}>
        {prompt ? <Text color={confirmTrashId ? 'red' : 'yellow'}
          wrap={chatInputState || renameState || searchMode ? 'truncate-start' : 'truncate-end'}>{prompt}</Text>
          : processing ? <Text color="magenta" wrap="truncate-end">◐ {processing.label}{processing.progress === undefined ? '' : ` ${processing.progress}%`}</Text>
          : toast ? <Text color={error ? 'red' : 'green'}>{toast}</Text>
          : <KeyBar hints={hints} columns={terminal.columns - 2} />}
      </Box>
    </Box>
  );
}
