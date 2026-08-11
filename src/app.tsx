import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  readMacCalendarEvents,
  suggestCalendarMeeting,
} from './calendar.ts';
import {
  loadConfig,
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
import {
  createChatMessage,
  createMeetingArtifact,
  loadMeetingArtifact,
  saveMeetingArtifact,
  type MeetingArtifact,
  type MeetingCalendarEvent,
} from './meeting-artifact.ts';
import { chatWithMeeting, enrichMeeting } from './meeting-enrichment.ts';
import { meetingViewLines, type MeetingView } from './meeting-tui.ts';
import {
  coalesceTranscriptSegments,
  renderText,
  speakerLabel,
} from './transcript-renderer.ts';
import type { TranscriptFormat, TranscriptRecord } from './transcript-types.ts';
import { transcribeMedia } from './transcription-service.ts';
import {
  startSystemAudioCapture,
  type PcmSignalLevel,
  type SystemAudioCaptureHandle,
  type SystemAudioCaptureState,
} from './live-system-audio.ts';
import {
  startMicrophoneCapture,
  type MicrophoneCaptureHandle,
} from './live-microphone.ts';
import { CaptureSessionStore, listRecoverableCaptureSessions } from './capture-session.ts';
import { finalizeCaptureTranscript } from './capture-finalizer.ts';
import { reconcileLiveEcho } from './live-echo.ts';
import {
  DEFAULT_VAD_MODEL_FILENAME,
  DEFAULT_WHISPER_MODEL_FILENAME,
} from './model-config.ts';
import {
  moveSelection,
  moveTranscriptScroll,
  formatTuiClock,
  SPEAKER_COLORS,
  speakerColorIndex,
  tuiLayout,
} from './tui-state.ts';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(__filename), '..');
const WHISPER_CLI = join(PROJECT_ROOT, 'whisper.cpp/build/bin/whisper-cli');
const MODEL_PATH = join(PROJECT_ROOT, 'models', DEFAULT_WHISPER_MODEL_FILENAME);
const VAD_MODEL_PATH = join(PROJECT_ROOT, 'whisper.cpp/models', DEFAULT_VAD_MODEL_FILENAME);
type ListenerState = 'listening' | 'recording';
type View = 'live' | 'record';

interface ProcessingState {
  label: string;
  progress?: number;
}

interface RenameState {
  speakerId: string;
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

function levelMeter(level: PcmSignalLevel | null, width = 8): string {
  const dbfs = level?.rmsDbfs ?? Number.NEGATIVE_INFINITY;
  const ratio = Number.isFinite(dbfs) ? Math.max(0, Math.min(1, (dbfs + 60) / 54)) : 0;
  const active = Math.round(ratio * width);
  return `${'▮'.repeat(active)}${'·'.repeat(width - active)}`;
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
  const config = useMemo(() => loadConfig(), []);
  const libraryRoot = useMemo(
    () => resolveLibraryDir(props.libraryDir, process.env, config),
    [props.libraryDir, config],
  );
  const saveByDefault = useMemo(() => resolveSaveByDefault(config), [config]);
  const listenerDisabled = process.env.SEASHELL_DISABLE_LISTENER === '1';
  const systemAudioDisabled = listenerDisabled ||
    process.env.SEASHELL_DISABLE_SYSTEM_AUDIO === '1';
  const terminal = useTerminalSize();
  const layout = useMemo(
    () => tuiLayout(terminal.columns, terminal.rows),
    [terminal.columns, terminal.rows],
  );

  const [listenerState, setListenerState] = useState<ListenerState>('listening');
  const [systemAudioState, setSystemAudioState] = useState<SystemAudioCaptureState>(
    systemAudioDisabled ? 'unavailable' : 'starting',
  );
  const [microphoneState, setMicrophoneState] = useState<SystemAudioCaptureState>(
    listenerDisabled ? 'unavailable' : 'starting',
  );
  const [microphoneLevel, setMicrophoneLevel] = useState<PcmSignalLevel | null>(null);
  const [systemAudioLevel, setSystemAudioLevel] = useState<PcmSignalLevel | null>(null);
  const [captureChunkCount, setCaptureChunkCount] = useState(0);
  const [transcribingCount, setTranscribingCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [processing, setProcessing] = useState<ProcessingState | null>(null);
  const [libraryEntries, setLibraryEntries] = useState<TranscriptLibraryEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const [view, setView] = useState<View>('live');
  const [selectedRecord, setSelectedRecord] = useState<TranscriptRecord | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingArtifact | null>(null);
  const [liveMeeting, setLiveMeeting] = useState<MeetingArtifact | null>(null);
  const [meetingView, setMeetingView] = useState<MeetingView>('transcript');
  const [chatInputState, setChatInputState] = useState<ChatInputState | null>(null);
  const [calendarSuggestion, setCalendarSuggestion] = useState<MeetingCalendarEvent | null>(null);
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [transcriptScroll, setTranscriptScroll] = useState(0);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [showSpeakers, setShowSpeakers] = useState(true);
  const [speakerSelection, setSpeakerSelection] = useState(0);
  const [renameState, setRenameState] = useState<RenameState | null>(null);
  const [exportMode, setExportMode] = useState(false);
  const [helpMode, setHelpMode] = useState(false);
  const [confirmTrashId, setConfirmTrashId] = useState<string | null>(null);
  const [liveRecord, setLiveRecord] = useState<TranscriptRecord>(() => createLiveRecord());

  const microphoneCapture = useRef<MicrophoneCaptureHandle | null>(null);
  const systemAudioCapture = useRef<SystemAudioCaptureHandle | null>(null);
  const captureSessionStore = useRef<CaptureSessionStore | null>(null);
  const liveTranscriptionProcesses = useRef<Set<ChildProcess>>(new Set());
  const liveSessionGeneration = useRef(0);
  const isExiting = useRef(false);
  const exitInProgress = useRef(false);
  const pausedRef = useRef(false);
  const liveRecordRef = useRef(liveRecord);
  const liveMeetingRef = useRef<MeetingArtifact | null>(null);
  const observerActiveRef = useRef(false);
  const liveSessionStartedAt = useRef(Date.now());

  const refreshLibrary = useCallback(() => {
    setLibraryEntries(listTranscriptRecords(libraryRoot));
  }, [libraryRoot]);

  useEffect(() => {
    refreshLibrary();
    const recoverable = listRecoverableCaptureSessions(libraryRoot);
    if (recoverable.length > 0) {
      setNotice(`${recoverable.length} recoverable live capture${recoverable.length === 1 ? '' : 's'} found · run seashell capture list`);
    }
  }, [refreshLibrary]);

  const visibleEntries = useMemo(
    () => searchQuery.trim()
      ? searchTranscriptRecords(libraryRoot, searchQuery)
      : libraryEntries,
    [libraryEntries, libraryRoot, searchQuery],
  );
  const liveCaptureLabel = systemAudioState === 'active'
    ? 'mic + system'
    : systemAudioState === 'starting'
      ? 'mic + system starting'
      : 'mic only';
  const navigationItems: NavigationItem[] = useMemo(() => [
    { kind: 'live', label: `● Live transcription · ${liveCaptureLabel}` },
    ...visibleEntries.map((entry) => ({
      kind: 'record' as const,
      label: entry.kind === 'meeting' ? `M · ${entry.title}` : entry.title,
      entry,
    })),
  ], [liveCaptureLabel, visibleEntries]);

  useEffect(() => {
    setSelectionIndex((current) => moveSelection(current, 0, navigationItems.length));
  }, [navigationItems.length]);

  const cleanupFile = useCallback((path: string) => {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {}
  }, []);

  const appendLiveSegment = useCallback((segment: TranscriptRecord['transcript'][number]) => {
    const current = liveRecordRef.current;
    const nextSpeakers = segment.speaker && !current.speakers.some(
      (speaker) => speaker.id === segment.speaker,
    )
      ? [
          ...current.speakers,
          {
            id: segment.speaker,
            label: segment.speaker === 'LOCAL'
              ? 'Microphone'
              : segment.speaker === 'SYSTEM'
                ? 'System audio'
                : segment.speaker,
          },
        ]
      : current.speakers;
    const next: TranscriptRecord = {
      ...current,
      updatedAt: new Date().toISOString(),
      speakers: nextSpeakers,
      transcript: [...reconcileLiveEcho(current.transcript, segment)],
    };
    liveRecordRef.current = next;
    setLiveRecord(next);
    if (saveByDefault || liveMeetingRef.current) {
      try {
        saveTranscriptRecord(libraryRoot, next);
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

    setTranscribingCount((count) => count + 1);
    let finished = false;
    const finish = (text: string, failure?: string) => {
      if (finished) return;
      finished = true;
      if (cleanupAfter) cleanupFile(audioFile);
      setTranscribingCount((count) => Math.max(0, count - 1));
      if (text && sessionGeneration === liveSessionGeneration.current) {
        appendLiveSegment({ start, end: Math.max(start, end), text, speaker });
      } else if (failure) {
        setError(`Live transcription failed: ${failure}`);
      }
    };

    const runAttempt = (disableGpu: boolean) => {
      const process = spawn(WHISPER_CLI, [
        ...(disableGpu ? ['-ng'] : []),
        '-m', MODEL_PATH,
        '-vm', VAD_MODEL_PATH,
        '--vad',
        '-f', audioFile,
        '-l', 'en',
        '-t', '6',
        '-nt',
        '-np',
        '-mc', '0',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      liveTranscriptionProcesses.current.add(process);

      let output = '';
      let stderr = '';
      process.stdout?.on('data', (data) => { output += data.toString(); });
      process.stderr?.on('data', (data) => { stderr = (stderr + data.toString()).slice(-2000); });
      process.on('close', (code, signal) => {
        liveTranscriptionProcesses.current.delete(process);
        if (isExiting.current) {
          finish('');
          return;
        }
        if (!disableGpu && (Boolean(signal) || code === 139)) {
          setNotice('Metal unavailable; using CPU transcription fallback.');
          runAttempt(true);
          return;
        }
        const text = output.replace(/\[.*?\]/gu, '').replace(/\s+/gu, ' ').trim();
        const reason = signal ? `signal ${signal}` : stderr.trim().slice(-120) || `exit ${code}`;
        finish(text, code === 0 ? undefined : reason);
      });
      process.on('error', (processError) => {
        liveTranscriptionProcesses.current.delete(process);
        finish('', processError.message);
      });
    };

    runAttempt(process.env.SEASHELL_DISABLE_GPU === '1');
  }, [appendLiveSegment, cleanupFile]);

  const ensureCaptureStore = useCallback((generation: number) => {
    if (generation !== liveSessionGeneration.current) return null;
    if (
      !captureSessionStore.current ||
      captureSessionStore.current.manifest.sessionId !== liveRecordRef.current.id
    ) {
      captureSessionStore.current = new CaptureSessionStore({
        libraryDir: libraryRoot,
        sessionId: liveRecordRef.current.id,
        startedAtUnixMs: liveSessionStartedAt.current,
        createdAt: liveRecordRef.current.createdAt,
      });
      setCaptureChunkCount(captureSessionStore.current.manifest.chunks.length);
    }
    return captureSessionStore.current;
  }, [libraryRoot]);

  const persistLiveChunk = useCallback((options: {
    path: string;
    source: 'microphone' | 'system-audio';
    startSeconds: number;
    endSeconds: number;
    audible: boolean;
    generation: number;
  }) => {
    const store = ensureCaptureStore(options.generation);
    if (!store) {
      cleanupFile(options.path);
      return null;
    }
    try {
      const chunk = store.commitChunk({
        sourcePath: options.path,
        trackId: options.source,
        startSeconds: options.startSeconds,
        endSeconds: options.endSeconds,
        audible: options.audible,
      });
      setCaptureChunkCount(store.manifest.chunks.length);
      return chunk;
    } catch (captureError) {
      cleanupFile(options.path);
      setError(`Could not preserve live audio: ${
        captureError instanceof Error ? captureError.message : String(captureError)
      }`);
      return null;
    }
  }, [cleanupFile, ensureCaptureStore]);

  const startSystemListener = useCallback(() => {
    if (systemAudioDisabled || isExiting.current || pausedRef.current) return;
    systemAudioCapture.current?.stop();
    const generation = liveSessionGeneration.current;
    const capture = startSystemAudioCapture({
      sessionStartedAtUnixMs: liveSessionStartedAt.current,
      onChunk: (chunk) => {
        const committed = persistLiveChunk({ ...chunk, generation });
        if (committed && chunk.audible) {
          transcribeLiveChunk(
            committed.path,
            chunk.startSeconds,
            chunk.endSeconds,
            'SYSTEM',
            generation,
            false,
          );
        }
      },
      onLevel: setSystemAudioLevel,
      onState: (update) => {
        if (generation !== liveSessionGeneration.current) return;
        setSystemAudioState(update.state);
        if (update.state === 'unavailable' && update.message) {
          setNotice(`System audio unavailable; continuing with microphone only. ${update.message}`);
        }
      },
    });
    systemAudioCapture.current = capture;
  }, [persistLiveChunk, systemAudioDisabled, transcribeLiveChunk]);

  const startListener = useCallback(() => {
    if (listenerDisabled || isExiting.current || pausedRef.current) return;
    microphoneCapture.current?.stop();
    const sessionGeneration = liveSessionGeneration.current;
    const capture = startMicrophoneCapture({
      sessionStartedAtUnixMs: liveSessionStartedAt.current,
      onChunk: (chunk) => {
        const committed = persistLiveChunk({ ...chunk, generation: sessionGeneration });
        if (committed && chunk.audible) {
          transcribeLiveChunk(
            committed.path,
            chunk.startSeconds,
            chunk.endSeconds,
            'LOCAL',
            sessionGeneration,
            false,
          );
        }
      },
      onLevel: (level) => {
        setMicrophoneLevel(level);
        setListenerState(level.rmsDbfs >= -55 ? 'recording' : 'listening');
      },
      onState: (update) => {
        if (sessionGeneration !== liveSessionGeneration.current) return;
        setMicrophoneState(update.state);
        if (update.state === 'unavailable' && update.message) {
          setError(`Microphone unavailable: ${update.message}`);
        }
      },
    });
    microphoneCapture.current = capture;
  }, [listenerDisabled, persistLiveChunk, transcribeLiveChunk]);

  useEffect(() => {
    if (listenerDisabled) return;
    startListener();
    return () => {
      isExiting.current = true;
      microphoneCapture.current?.stop();
      for (const process of liveTranscriptionProcesses.current) process.kill('SIGTERM');
      liveTranscriptionProcesses.current.clear();
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

  const setListeningPaused = useCallback((nextPaused: boolean) => {
    pausedRef.current = nextPaused;
    setPaused(nextPaused);
    if (nextPaused) {
      const captureHandles = [microphoneCapture.current, systemAudioCapture.current]
        .filter((handle): handle is MicrophoneCaptureHandle | SystemAudioCaptureHandle => Boolean(handle));
      microphoneCapture.current?.stop();
      microphoneCapture.current = null;
      setListenerState('listening');
      systemAudioCapture.current?.stop();
      systemAudioCapture.current = null;
      setMicrophoneState('stopped');
      if (!systemAudioDisabled) setSystemAudioState('stopped');
      void Promise.all(captureHandles.map((handle) => handle.done)).then(() => {
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
  }, [libraryRoot, processing, refreshLibrary, setListeningPaused]);

  const pickMedia = useCallback((withSpeakers: boolean) => {
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
      setSelectedRecord(findTranscriptRecord(libraryRoot, entry.id).record);
      setSelectedMeeting(loadMeetingArtifact(libraryRoot, entry.id) ?? null);
      setView('record');
      setMeetingView('transcript');
      setTranscriptScroll(0);
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
    const currentIndex = view === 'record' && selectedRecord
      ? navigationItems.findIndex((item) => (
        item.kind === 'record' && item.entry.id === selectedRecord.id
      ))
      : 0;
    setSelectionIndex(currentIndex >= 0 ? currentIndex : 0);
    setHistoryOpen(true);
  }, [historyOpen, navigationItems, selectedRecord, view]);

  const currentRecord = view === 'live' ? liveRecord : selectedRecord;
  const currentMeeting = view === 'live' ? liveMeeting : selectedMeeting;
  const displaySegments = useMemo(
    () => currentRecord ? coalesceTranscriptSegments(currentRecord) : [],
    [currentRecord],
  );
  const drawerOnly = historyOpen && layout.compact;
  const mainPanelColumns = historyOpen && !drawerOnly
    ? terminal.columns - layout.sidebarWidth - 7
    : terminal.columns - 4;
  const segmentRowEstimate = mainPanelColumns < 60
    ? 4
    : mainPanelColumns < 90
      ? 3
      : 2;
  const visibleRows = Math.max(
    2,
    Math.floor(layout.visibleTranscriptRows / segmentRowEstimate),
  );
  const sidebarStart = Math.max(
    0,
    selectionIndex - layout.visibleLibraryItems + 1,
  );
  const visibleSegments = displaySegments.slice(
    transcriptScroll,
    transcriptScroll + visibleRows,
  );
  const selectedSpeaker = currentRecord?.speakers[speakerSelection];
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
      setNotice(calendar
        ? `Meeting attached: ${calendar.title}.`
        : 'Marked as a meeting. The base transcript remains independent.');
    } catch (meetingError) {
      setError(meetingError instanceof Error ? meetingError.message : String(meetingError));
    }
  }, [commitMeetingState, config.meeting, currentRecord, libraryRoot, refreshLibrary]);

  const completeCaptureSession = useCallback((reason: string) => {
    const store = captureSessionStore.current;
    if (!store) return;
    try {
      const current = liveRecordRef.current;
      const duration = Math.max(0, ...store.manifest.chunks.map((chunk) => chunk.endMs)) / 1_000;
      const record: TranscriptRecord = {
        ...current,
        updatedAt: new Date().toISOString(),
        source: {
          ...current.source,
          duration,
          format: 'capture-session/0.1',
        },
      };
      liveRecordRef.current = record;
      setLiveRecord(record);
      if (saveByDefault || liveMeetingRef.current || record.transcript.length > 0) {
        const saved = saveTranscriptRecord(libraryRoot, record);
        store.setStatus('completed', reason);
        store.attachTo(saved.directory);
        refreshLibrary();
      } else {
        store.setStatus('interrupted', 'capture-retained-without-published-transcript');
      }
    } catch (captureError) {
      try { store.setStatus('interrupted', 'finalization-failed'); } catch {}
      setError(`Capture remains recoverable: ${
        captureError instanceof Error ? captureError.message : String(captureError)
      }`);
    } finally {
      captureSessionStore.current = null;
      setCaptureChunkCount(0);
    }
  }, [libraryRoot, refreshLibrary, saveByDefault]);

  const runCurrentMeetingEnrichment = useCallback((finishLive = false) => {
    if (!currentRecord || !currentMeeting || processing) return;
    if (observerActiveRef.current) {
      setNotice('The live meeting observer is finishing its current window. Try again in a moment.');
      return;
    }
    const mode = config.meeting?.mode ?? currentMeeting.mode;
    const missingObserver = mode !== 'post-session' && !configuredMeetingRoutes.observer;
    const missingReconciliation = mode !== 'streaming' && !configuredMeetingRoutes.reconciliation;
    if ((missingObserver || missingReconciliation) && !finishLive) {
      setError(`Configure the ${missingObserver ? 'observer' : 'reconciliation'} route before running ${mode} meeting intelligence.`);
      return;
    }
    const wasListening = view === 'live' && !pausedRef.current;
    const captureHandles = [microphoneCapture.current, systemAudioCapture.current]
      .filter((handle): handle is MicrophoneCaptureHandle | SystemAudioCaptureHandle => Boolean(handle));
    if (wasListening) setListeningPaused(true);
    setError(null);
    setProcessing({ label: finishLive ? 'Finishing capture…' : 'Preparing meeting enrichment…' });
    void (async () => {
      try {
        if (finishLive) {
          await Promise.all(captureHandles.map((handle) => handle.done));
          const deadline = Date.now() + 10 * 60_000;
          while (liveTranscriptionProcesses.current.size > 0) {
            if (Date.now() > deadline) throw new Error('Timed out waiting for live transcription');
            setProcessing({
              label: `Finishing ${liveTranscriptionProcesses.current.size} live transcription job${
                liveTranscriptionProcesses.current.size === 1 ? '' : 's'
              }…`,
            });
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          const store = captureSessionStore.current;
          if (store?.manifest.chunks.length) {
            const finalized = await finalizeCaptureTranscript(store.manifestPath, {
              title: liveRecordRef.current.title,
              onStatus: (label) => setProcessing({ label }),
            });
            liveRecordRef.current = finalized;
            setLiveRecord(finalized);
          }
          completeCaptureSession('meeting-finished');
        }
        const record = view === 'live' ? liveRecordRef.current : currentRecord;
        saveTranscriptRecord(libraryRoot, record);
        if (missingObserver || missingReconciliation) {
          refreshLibrary();
          setNotice('Meeting capture and final transcript are saved. Configure Humain later for notes and analysis.');
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
          onStatus: (label) => setProcessing({ label }),
        });
        commitMeetingState(artifact);
        refreshLibrary();
        setMeetingView('notes');
        setNotice(finishLive
          ? 'Meeting capture, final transcript, notes, and analysis are ready.'
          : 'Meeting notes and analysis are ready.');
      } catch (meetingError) {
        setError(meetingError instanceof Error ? meetingError.message : String(meetingError));
        const failed = loadMeetingArtifact(libraryRoot, currentRecord.id);
        if (failed) commitMeetingState(failed);
      } finally {
        setProcessing(null);
        if (wasListening && !finishLive) setListeningPaused(false);
      }
    })();
  }, [
    commitMeetingState,
    config.meeting,
    configuredMeetingRoutes,
    completeCaptureSession,
    currentMeeting,
    currentRecord,
    libraryRoot,
    processing,
    refreshLibrary,
    setListeningPaused,
    view,
  ]);

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
    let cancelled = false;
    const poll = () => {
      try {
        const events = readMacCalendarEvents({ leadMinutes: calendar.leadMinutes });
        const suggestion = suggestCalendarMeeting(events, {
          policy: calendar.policy ?? 'ask',
          selectedCalendars: calendar.selectedCalendars,
          leadMinutes: calendar.leadMinutes,
        });
        if (!cancelled) setCalendarSuggestion(suggestion ?? null);
      } catch (calendarError) {
        if (!cancelled) {
          setNotice(calendarError instanceof Error ? calendarError.message : String(calendarError));
        }
      }
    };
    poll();
    const interval = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [config.meeting?.calendar]);

  useEffect(() => {
    if (!calendarSuggestion || liveMeeting || view !== 'live') return;
    const policy = config.meeting?.calendar?.policy ?? 'ask';
    if (policy === 'all' || policy === 'selected-calendars') {
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
      ? meetingViewLines(currentMeeting, meetingView)
      : []
  ), [currentMeeting, meetingView]);
  const visibleAuxiliaryMeetingLines = auxiliaryMeetingLines.slice(
    transcriptScroll,
    transcriptScroll + layout.visibleTranscriptRows,
  );
  const scrollItemCount = currentMeeting && meetingView !== 'transcript'
    ? auxiliaryMeetingLines.length
    : displaySegments.length;
  const scrollVisibleRows = currentMeeting && meetingView !== 'transcript'
    ? layout.visibleTranscriptRows
    : visibleRows;

  const copyCurrentTranscript = useCallback(() => {
    if (!currentRecord) return;
    const text = renderText(currentRecord, {
      timestamps: showTimestamps,
      speakers: showSpeakers,
    });
    if (!text) return;
    const result = spawnSync('pbcopy', [], { input: text, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      setError('Copy failed');
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [currentRecord, showSpeakers, showTimestamps]);

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

  const resetLiveSession = useCallback(() => {
    const resumeCapture = !pausedRef.current;
    microphoneCapture.current?.stop();
    microphoneCapture.current = null;
    systemAudioCapture.current?.stop();
    systemAudioCapture.current = null;
    completeCaptureSession('new-live-session');
    liveSessionGeneration.current += 1;
    const next = createLiveRecord();
    liveRecordRef.current = next;
    liveSessionStartedAt.current = Date.now();
    setLiveRecord(next);
    liveMeetingRef.current = null;
    setLiveMeeting(null);
    setMeetingView('transcript');
    setTranscriptScroll(0);
    setNotice('Started a fresh live transcript.');
    setMicrophoneLevel(null);
    setSystemAudioLevel(null);
    if (resumeCapture) {
      setTimeout(startListener, 0);
      setTimeout(startSystemListener, 0);
    }
  }, [completeCaptureSession, startListener, startSystemListener]);

  const gracefulExit = useCallback(() => {
    if (exitInProgress.current) return;
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
        const deadline = Date.now() + 10 * 60_000;
        while (liveTranscriptionProcesses.current.size > 0) {
          if (Date.now() > deadline) throw new Error('Timed out waiting for live transcription');
          setProcessing({
            label: `Finishing ${liveTranscriptionProcesses.current.size} transcription job${
              liveTranscriptionProcesses.current.size === 1 ? '' : 's'
            }…`,
          });
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        completeCaptureSession('application-exit');
      } catch {
        try { captureSessionStore.current?.setStatus('interrupted', 'graceful-exit-failed'); } catch {}
      } finally {
        isExiting.current = true;
        for (const process of liveTranscriptionProcesses.current) process.kill('SIGTERM');
        liveTranscriptionProcesses.current.clear();
        exit();
      }
    })();
  }, [completeCaptureSession, exit]);

  useInput((input, key) => {
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
            refreshLibrary();
            setNotice(`${renameState.speakerId} renamed to ${renameState.input.trim()}.`);
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

    if (searchMode) {
      if (key.escape || key.return) {
        setSearchMode(false);
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
    if (key.escape && historyOpen) {
      setHistoryOpen(false);
      return;
    }
    if (key.escape || input === 'q') {
      gracefulExit();
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
      setView('live');
      setMeetingView('transcript');
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
      markCurrentAsMeeting(view === 'live' ? calendarSuggestion ?? undefined : undefined);
      return;
    }
    if (input === 'g' && currentMeeting) {
      runCurrentMeetingEnrichment(view === 'live');
      return;
    }
    if (input === 'a' && currentMeeting) {
      if (!configuredMeetingRoutes.chat) {
        setError('Configure the meeting chat route before using meeting chat.');
      } else {
        setMeetingView('chat');
        setChatInputState({ input: '' });
      }
      return;
    }
    if (currentMeeting && input >= '1' && input <= '4') {
      const views: MeetingView[] = ['notes', 'transcript', 'analysis', 'chat'];
      setMeetingView(views[Number(input) - 1]!);
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
      copyCurrentTranscript();
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
    if (input === 'r' && selectedSpeaker) {
      setRenameState({ speakerId: selectedSpeaker.id, input: selectedSpeaker.label });
      return;
    }
    if (input === '[' && currentRecord?.speakers.length) {
      setSpeakerSelection((index) => moveSelection(index, -1, currentRecord.speakers.length));
      return;
    }
    if (input === ']' && currentRecord?.speakers.length) {
      setSpeakerSelection((index) => moveSelection(index, 1, currentRecord.speakers.length));
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
    if ((input === ' ' || key.return) && view === 'live' && !historyOpen) {
      setListeningPaused(!pausedRef.current);
      return;
    }

    if (key.upArrow || input === 'k') {
      if (historyOpen) {
        const next = moveSelection(selectionIndex, -1, navigationItems.length);
        setSelectionIndex(next);
        showNavigationItem(navigationItems[next]);
      } else {
        setTranscriptScroll((scroll) => moveTranscriptScroll(
          scroll,
          -1,
          scrollItemCount,
          scrollVisibleRows,
        ));
      }
      return;
    }
    if (key.downArrow || input === 'j') {
      if (historyOpen) {
        const next = moveSelection(selectionIndex, 1, navigationItems.length);
        setSelectionIndex(next);
        showNavigationItem(navigationItems[next]);
      } else {
        setTranscriptScroll((scroll) => moveTranscriptScroll(
          scroll,
          1,
          scrollItemCount,
          scrollVisibleRows,
        ));
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
      setTranscriptScroll((scroll) => moveTranscriptScroll(
        scroll,
        -scrollVisibleRows,
        scrollItemCount,
        scrollVisibleRows,
      ));
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
      setTranscriptScroll((scroll) => moveTranscriptScroll(
        scroll,
        scrollVisibleRows,
        scrollItemCount,
        scrollVisibleRows,
      ));
      return;
    }
    if (key.return && historyOpen) {
      showNavigationItem(navigationItems[selectionIndex]);
      setHistoryOpen(false);
    }
  });

  const title = view === 'live' ? liveRecord.title : selectedRecord?.title ?? 'Transcript';
  const transcriptBorderColor = processing
    ? 'magenta'
    : view === 'record'
      ? 'cyan'
      : paused
        ? 'gray'
        : listenerState === 'recording'
          ? 'red'
          : transcribingCount > 0
            ? 'yellow'
            : 'green';
  const primaryCommands = historyOpen
    ? terminal.columns < 56
      ? '[↑↓] Browse  [↵] Open  [ESC] Close'
      : '[↑↓] Browse  [ENTER] Open  [/] Search  [H/ESC] Close'
    : currentMeeting
      ? view === 'live'
        ? `[SPACE] ${paused ? 'Resume' : 'Pause'}  [A] Ask  [G] Finish  [H] History  [?] Help  [Q] Quit`
        : '[A] Ask  [G] Enrich  [H] History  [T/S] Display  [?] Help  [Q] Quit'
    : view === 'live'
      ? terminal.columns < 56
        ? `[SPC] ${paused ? 'Resume' : 'Pause'}  [H] History  [Q] Quit`
        : terminal.columns < 80
          ? `[SPC] ${paused ? 'Resume' : 'Pause'}  [F] File  [H] History  [?] Help  [Q] Quit`
          : `[SPACE] ${paused ? 'Resume' : 'Pause'}  [F] File  [H] History  [T/S] Display  [?] Help  [Q] Quit`
      : terminal.columns < 56
        ? '[L] Live  [H] History  [Q] Quit'
        : terminal.columns < 72
          ? '[L] Live  [H] History  [T/S] View  [?] Help  [Q] Quit'
          : '[L] Live  [H] History  [T/S] Display  [?] Help  [Q] Quit';
  const plainTranscript = currentRecord && meetingView === 'transcript' && !showTimestamps && !showSpeakers
    ? renderText({ ...currentRecord, transcript: visibleSegments })
    : '';

  const historyDrawer = (
    <Box
      width={layout.compact ? undefined : layout.sidebarWidth}
      flexGrow={layout.compact ? 1 : 0}
      flexShrink={0}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      overflow="hidden"
      aria-role="listbox"
      aria-label="Transcript history"
    >
      <Text bold>History</Text>
      {(searchMode || searchQuery) && (
        <Text dimColor wrap="truncate-end">/ {searchQuery || 'Type to search'}</Text>
      )}
      <Box height={1} />
      {navigationItems
        .slice(sidebarStart, sidebarStart + layout.visibleLibraryItems)
        .map((item, windowIndex) => {
          const index = sidebarStart + windowIndex;
          const selected = selectionIndex === index;
          const rowWidth = layout.compact
            ? Math.max(12, terminal.columns - 8)
            : Math.max(12, layout.sidebarWidth - 4);
          return (
            <Text
              key={item.kind === 'record' ? item.entry.id : item.kind}
              color={!selected && item.kind === 'live' ? 'green' : undefined}
              inverse={selected}
              wrap="truncate-end"
              aria-role="option"
              aria-state={{ selected }}
            >
              {selected ? '› ' : '  '}{truncate(item.label, rowWidth)}
            </Text>
          );
        })}
      {searchQuery && visibleEntries.length === 0 && (
        <Text dimColor>No saved transcripts found.</Text>
      )}
      {!searchQuery && libraryEntries.length === 0 && (
        <Text dimColor>No saved transcripts yet.</Text>
      )}
    </Box>
  );

  const transcriptPane = (
    <Box
      flexGrow={1}
      minWidth={0}
      flexDirection="column"
      borderStyle="round"
      borderColor={transcriptBorderColor}
      paddingX={2}
      paddingY={1}
      minHeight={8}
      marginLeft={historyOpen ? 1 : 0}
      overflow="hidden"
      aria-label="Transcript reader"
    >
      {currentMeeting && meetingView !== 'transcript' ? (
        <Box flexDirection="column">
          {visibleAuxiliaryMeetingLines.map((line, index) => (
            <Box key={`${meetingView}-${index}`} flexShrink={0}>
              <Text
                bold={line.length > 0 && !line.startsWith('-') && !line.includes(':') && line.length < 28}
                dimColor={line === ''}
                wrap="wrap"
              >
                {line || ' '}
              </Text>
            </Box>
          ))}
        </Box>
      ) : visibleSegments.length === 0 ? (
        <Text dimColor>{view === 'live'
          ? `Play or speak to transcribe locally · ${liveCaptureLabel}`
          : 'No transcript text'}</Text>
      ) : plainTranscript ? (
        <Text wrap="wrap">{plainTranscript}</Text>
      ) : (
        <Box flexDirection="column">
          {visibleSegments.map((segment, index) => {
            const label = showSpeakers
              ? speakerLabel(currentRecord!, segment.speaker)
              : undefined;
            const speakerColor = segment.speaker
              ? SPEAKER_COLORS[speakerColorIndex(segment.speaker)]
              : undefined;
            return (
              <Text key={`${segment.start}-${segment.end}-${index}`} wrap="wrap">
                {showTimestamps && <Text dimColor>[{formatTuiClock(segment.start)}] </Text>}
                {label && (
                  <Text
                    color={speakerColor}
                  >
                    {label}:{' '}
                  </Text>
                )}
                {segment.text}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );

  return (
    <Box flexDirection="column" padding={1} height={terminal.rows} overflow="hidden">
      <Box marginBottom={1} flexShrink={0}>
        <Text>🐚 </Text>
        <Text bold color="cyan">Sea Shell</Text>
      </Box>

      <Box marginBottom={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {truncate(primaryCommands, Math.max(20, terminal.columns - 4))}
        </Text>
      </Box>

      {(error || copied || notice) && (
        <Box marginBottom={1} flexShrink={0}>
          <Text color={error ? 'red' : 'green'} wrap="truncate-end">
            {error ?? (copied ? 'Copied!' : notice)}
          </Text>
        </Box>
      )}

      <Box marginBottom={1} flexShrink={0}>
        {processing ? (
          <Text color="magenta">
            ◐ {processing.label}{processing.progress === undefined ? '' : ` ${processing.progress}%`}
          </Text>
        ) : view === 'record' ? (
          <Text color="cyan" wrap="truncate-end">
            {currentMeeting ? 'Meeting · ' : ''}{truncate(title, Math.max(12, terminal.columns - 6))}
          </Text>
        ) : paused ? (
          <Text dimColor>⏸ Paused</Text>
        ) : (
          <Text>
            <Text color={listenerState === 'recording' ? 'red' : 'green'}>
              {systemAudioState === 'active'
                ? '◉ Capturing · mic + system'
                : systemAudioState === 'starting'
                  ? '◌ Listening · system audio starting'
                  : listenerState === 'recording'
                    ? '● Recording · mic only'
                    : '◉ Listening · mic only'}
            </Text>
            {transcribingCount > 0 && (
              <Text color="yellow">
                {' + '}◐ Transcribing{transcribingCount > 1 ? ` (${transcribingCount})` : ''}
              </Text>
            )}
          </Text>
        )}
      </Box>

      {view === 'live' && !paused && (
        <Box marginBottom={1} flexShrink={0}>
          <Text dimColor>Mic </Text>
          <Text color={microphoneState === 'active' ? 'green' : 'yellow'}>
            {levelMeter(microphoneLevel)}
          </Text>
          <Text dimColor>  System </Text>
          <Text color={systemAudioState === 'active' ? 'cyan' : 'yellow'}>
            {levelMeter(systemAudioLevel)}
          </Text>
          <Text dimColor>{`  ${captureChunkCount} safe chunks`}</Text>
        </Box>
      )}

      {currentMeeting && !drawerOnly && (
        <Box marginBottom={1} flexShrink={0}>
          {([
            ['notes', '1 Notes'],
            ['transcript', '2 Transcript'],
            ['analysis', '3 Analysis'],
            ['chat', '4 Chat'],
          ] as Array<[MeetingView, string]>).map(([candidate, label], index) => (
            <React.Fragment key={candidate}>
              {index > 0 && <Text dimColor>  </Text>}
              <Text inverse={meetingView === candidate}>{` ${label} `}</Text>
            </React.Fragment>
          ))}
          <Text dimColor>  {currentMeeting.status[0]!.toUpperCase() + currentMeeting.status.slice(1)}</Text>
        </Box>
      )}

      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {historyOpen && historyDrawer}
        {!drawerOnly && transcriptPane}
      </Box>

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        {chatInputState ? (
          <Text color="yellow">Ask: {chatInputState.input}█  [Enter send · Esc cancel]</Text>
        ) : renameState ? (
          <Text color="yellow">Rename {renameState.speakerId}: {renameState.input}█  [Enter save · Esc cancel]</Text>
        ) : searchMode ? (
          <Text color="yellow">Search: {searchQuery}█  [Enter apply · Esc cancel]</Text>
        ) : exportMode ? (
          <Text color="yellow">Export: [S] SRT  [V] WebVTT  [T] Text  [J] JSON  [Esc] Cancel</Text>
        ) : confirmTrashId ? (
          <Text color="red">Move this transcript to recoverable Trash? [Y/N]</Text>
        ) : helpMode ? (
          <>
            <Text color="yellow">Keyboard help · [?] or [Esc] close</Text>
            <Text dimColor>F import · ⇧F import + speakers · T timestamps · S speaker labels</Text>
            <Text dimColor>C copy · E export · O folder · D trash · DEL clear live</Text>
            <Text dimColor>[/] choose speaker · R rename · ↑↓ scroll · L live · Q quit</Text>
            <Text dimColor>M mark meeting · 1-4 meeting views · G enrich/finalize · A ask</Text>
          </>
        ) : !historyOpen && currentRecord?.transcript.length ? (
          <Text dimColor>
            {currentMeeting && meetingView === 'analysis'
              ? `${currentMeeting.analysis?.claims.length ?? currentMeeting.provisionalClaims.length} insights`
              : currentMeeting && meetingView === 'notes'
                ? `${currentMeeting.attendees.length} attendees`
                : currentMeeting && meetingView === 'chat'
                  ? `${Math.floor(currentMeeting.chat.length / 2)} exchanges`
                  : `${renderText(currentRecord).length} chars`}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
