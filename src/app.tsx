import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, resolveLibraryDir, resolveSaveByDefault } from './config.ts';
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
  coalesceTranscriptSegments,
  formatClock,
  renderText,
  speakerLabel,
} from './transcript-renderer.ts';
import type { TranscriptFormat, TranscriptRecord } from './transcript-types.ts';
import { transcribeMedia } from './transcription-service.ts';
import {
  moveSelection,
  moveTranscriptScroll,
  SPEAKER_COLORS,
  speakerColorIndex,
  tuiLayout,
} from './tui-state.ts';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(__filename), '..');
const WHISPER_CLI = join(PROJECT_ROOT, 'whisper.cpp/build/bin/whisper-cli');
const MODEL_PATH = join(PROJECT_ROOT, 'models/ggml-large-v3-turbo-q5_0.bin');
const VAD_MODEL_PATH = join(PROJECT_ROOT, 'whisper.cpp/models/ggml-silero-v6.2.0.bin');
const MAX_RECORDING_DURATION = 30_000;

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
  return createTranscriptRecord({ transcript: [], speakers: [] }, {
    title: liveTitle(),
    source: { filename: 'Live microphone session' },
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
  const config = useMemo(() => loadConfig(), []);
  const libraryRoot = useMemo(
    () => resolveLibraryDir(props.libraryDir, process.env, config),
    [props.libraryDir, config],
  );
  const saveByDefault = useMemo(() => resolveSaveByDefault(config), [config]);
  const terminal = useTerminalSize();
  const layout = useMemo(
    () => tuiLayout(terminal.columns, terminal.rows),
    [terminal.columns, terminal.rows],
  );

  const [listenerState, setListenerState] = useState<ListenerState>('listening');
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

  const listenerProcess = useRef<ChildProcess | null>(null);
  const fileCounter = useRef(0);
  const isExiting = useRef(false);
  const pausedRef = useRef(false);
  const checkInterval = useRef<NodeJS.Timeout | null>(null);
  const maxDurationTimeout = useRef<NodeJS.Timeout | null>(null);
  const immediateStartRef = useRef(false);
  const liveRecordRef = useRef(liveRecord);
  const liveSessionStartedAt = useRef(Date.now());

  const refreshLibrary = useCallback(() => {
    setLibraryEntries(listTranscriptRecords(libraryRoot));
  }, [libraryRoot]);

  useEffect(() => {
    refreshLibrary();
  }, [refreshLibrary]);

  const visibleEntries = useMemo(
    () => searchQuery.trim()
      ? searchTranscriptRecords(libraryRoot, searchQuery)
      : libraryEntries,
    [libraryEntries, libraryRoot, searchQuery],
  );
  const navigationItems: NavigationItem[] = useMemo(() => [
    { kind: 'live', label: '● Live transcription' },
    ...visibleEntries.map((entry) => ({
      kind: 'record' as const,
      label: entry.title,
      entry,
    })),
  ], [visibleEntries]);

  useEffect(() => {
    setSelectionIndex((current) => moveSelection(current, 0, navigationItems.length));
  }, [navigationItems.length]);

  const getTempFile = useCallback(() => {
    fileCounter.current += 1;
    return `/tmp/seashell-live-${process.pid}-${fileCounter.current}.wav`;
  }, []);

  const cleanupFile = useCallback((path: string) => {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {}
  }, []);

  const appendLiveSegment = useCallback((segment: TranscriptRecord['transcript'][number]) => {
    const current = liveRecordRef.current;
    const next: TranscriptRecord = {
      ...current,
      updatedAt: new Date().toISOString(),
      transcript: [...current.transcript, segment]
        .toSorted((a, b) => a.start - b.start || a.end - b.end),
    };
    liveRecordRef.current = next;
    setLiveRecord(next);
    if (saveByDefault) {
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
  ) => {
    if (!existsSync(audioFile)) return;
    try {
      if (statSync(audioFile).size < 1000) {
        cleanupFile(audioFile);
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
      cleanupFile(audioFile);
      setTranscribingCount((count) => Math.max(0, count - 1));
      if (text) {
        appendLiveSegment({ start, end: Math.max(start, end), text });
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

      let output = '';
      let stderr = '';
      process.stdout?.on('data', (data) => { output += data.toString(); });
      process.stderr?.on('data', (data) => { stderr = (stderr + data.toString()).slice(-2000); });
      process.on('close', (code, signal) => {
        if (!disableGpu && (Boolean(signal) || code === 139)) {
          setNotice('Metal unavailable; using CPU transcription fallback.');
          runAttempt(true);
          return;
        }
        const text = output.replace(/\[.*?\]/gu, '').replace(/\s+/gu, ' ').trim();
        const reason = signal ? `signal ${signal}` : stderr.trim().slice(-120) || `exit ${code}`;
        finish(text, code === 0 ? undefined : reason);
      });
      process.on('error', (processError) => finish('', processError.message));
    };

    runAttempt(process.env.SEASHELL_DISABLE_GPU === '1');
  }, [appendLiveSegment, cleanupFile]);

  const startListener = useCallback(() => {
    if (isExiting.current || pausedRef.current) return;
    if (listenerProcess.current) {
      listenerProcess.current.kill('SIGTERM');
      listenerProcess.current = null;
    }
    if (checkInterval.current) clearInterval(checkInterval.current);

    const audioFile = getTempFile();
    const immediate = immediateStartRef.current;
    immediateStartRef.current = false;
    let recordingStartedAt = immediate
      ? (Date.now() - liveSessionStartedAt.current) / 1000
      : undefined;
    setListenerState(immediate ? 'recording' : 'listening');

    const soxArgs = immediate
      ? ['-d', '-r', '16000', '-c', '1', '-b', '16', audioFile,
        'silence', '1', '0', '0%', '1', '2.0', '1.5%']
      : ['-d', '-r', '16000', '-c', '1', '-b', '16', audioFile,
        'silence', '1', '0.05', '1.5%', '1', '2.0', '1.5%'];
    const process = spawn('sox', soxArgs, { stdio: ['ignore', 'ignore', 'pipe'] });

    checkInterval.current = setInterval(() => {
      try {
        if (existsSync(audioFile) && statSync(audioFile).size > 1000) {
          if (recordingStartedAt === undefined) {
            recordingStartedAt = (Date.now() - liveSessionStartedAt.current) / 1000;
          }
          setListenerState('recording');
          if (!maxDurationTimeout.current) {
            maxDurationTimeout.current = setTimeout(() => {
              maxDurationTimeout.current = null;
              if (listenerProcess.current && !pausedRef.current && !isExiting.current) {
                immediateStartRef.current = true;
                listenerProcess.current.kill('SIGTERM');
              }
            }, MAX_RECORDING_DURATION);
          }
        }
      } catch {}
    }, 100);

    process.on('error', (processError) => {
      if (checkInterval.current) clearInterval(checkInterval.current);
      if (maxDurationTimeout.current) clearTimeout(maxDurationTimeout.current);
      checkInterval.current = null;
      maxDurationTimeout.current = null;
      listenerProcess.current = null;
      setError(`Recording failed: ${processError.message}`);
      if (!isExiting.current && !pausedRef.current) setTimeout(startListener, 1000);
    });

    process.on('close', () => {
      if (checkInterval.current) clearInterval(checkInterval.current);
      if (maxDurationTimeout.current) clearTimeout(maxDurationTimeout.current);
      checkInterval.current = null;
      maxDurationTimeout.current = null;
      listenerProcess.current = null;
      if (isExiting.current) return;

      let hasAudio = false;
      try {
        hasAudio = existsSync(audioFile) && statSync(audioFile).size > 1000;
      } catch {}
      if (hasAudio) {
        const end = (Date.now() - liveSessionStartedAt.current) / 1000;
        transcribeLiveChunk(audioFile, recordingStartedAt ?? Math.max(0, end - 0.1), end);
      } else {
        cleanupFile(audioFile);
      }

      if (!pausedRef.current) {
        if (immediateStartRef.current || hasAudio) startListener();
        else setTimeout(startListener, 100);
      }
    });
    listenerProcess.current = process;
  }, [cleanupFile, getTempFile, transcribeLiveChunk]);

  useEffect(() => {
    startListener();
    return () => {
      isExiting.current = true;
      if (checkInterval.current) clearInterval(checkInterval.current);
      if (maxDurationTimeout.current) clearTimeout(maxDurationTimeout.current);
      listenerProcess.current?.kill('SIGTERM');
    };
  }, [startListener]);

  const setListeningPaused = useCallback((nextPaused: boolean) => {
    pausedRef.current = nextPaused;
    setPaused(nextPaused);
    if (nextPaused) {
      listenerProcess.current?.kill('SIGTERM');
      if (checkInterval.current) clearInterval(checkInterval.current);
      if (maxDurationTimeout.current) clearTimeout(maxDurationTimeout.current);
      checkInterval.current = null;
      maxDurationTimeout.current = null;
      setListenerState('listening');
    } else if (!listenerProcess.current) {
      startListener();
    }
  }, [startListener]);

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
      setView('record');
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
    const next = createLiveRecord();
    liveRecordRef.current = next;
    liveSessionStartedAt.current = Date.now();
    setLiveRecord(next);
    setTranscriptScroll(0);
    setNotice('Started a fresh live transcript.');
  }, []);

  useInput((input, key) => {
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
        isExiting.current = true;
        listenerProcess.current?.kill('SIGTERM');
        exit();
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
      isExiting.current = true;
      listenerProcess.current?.kill('SIGTERM');
      exit();
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
      setHistoryOpen(false);
      setSelectionIndex(0);
      setTranscriptScroll(0);
      return;
    }
    if (input === 'f' || input === 'F') {
      pickMedia(input === 'F');
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
          displaySegments.length,
          visibleRows,
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
          displaySegments.length,
          visibleRows,
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
        -visibleRows,
        displaySegments.length,
        visibleRows,
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
        visibleRows,
        displaySegments.length,
        visibleRows,
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
  const plainTranscript = currentRecord && !showTimestamps && !showSpeakers
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
      {visibleSegments.length === 0 ? (
        <Text dimColor>{view === 'live' ? 'Start speaking - always listening' : 'No transcript text'}</Text>
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
                {showTimestamps && <Text dimColor>[{formatClock(segment.start)}] </Text>}
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
          <Text color="cyan" wrap="truncate-end">◆ {truncate(title, Math.max(12, terminal.columns - 6))}</Text>
        ) : paused ? (
          <Text dimColor>⏸ Paused</Text>
        ) : (
          <Text>
            <Text color={listenerState === 'recording' ? 'red' : 'green'}>
              {listenerState === 'recording' ? '● Recording' : '◉ Listening'}
            </Text>
            {transcribingCount > 0 && (
              <Text color="yellow">
                {' + '}◐ Transcribing{transcribingCount > 1 ? ` (${transcribingCount})` : ''}
              </Text>
            )}
          </Text>
        )}
      </Box>

      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {historyOpen && historyDrawer}
        {!drawerOnly && transcriptPane}
      </Box>

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        {renameState ? (
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
          </>
        ) : !historyOpen && currentRecord?.transcript.length ? (
          <Text dimColor>{renderText(currentRecord).length} chars</Text>
        ) : null}
      </Box>
    </Box>
  );
}
