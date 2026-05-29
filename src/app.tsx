import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { spawn, ChildProcess, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync, existsSync, statSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..');
const WHISPER_CLI = join(PROJECT_ROOT, 'whisper.cpp/build/bin/whisper-cli');
const MODEL_PATH = join(PROJECT_ROOT, 'models/ggml-large-v3-turbo-q5_0.bin');
const VAD_MODEL_PATH = join(PROJECT_ROOT, 'whisper.cpp/models/ggml-silero-v6.2.0.bin');

/*
 * CONCURRENT ARCHITECTURE:
 *
 * Problem: If user speaks while transcribing, that speech is lost.
 * Solution: Always have a listener running, even during transcription.
 *
 * Flow:
 * 1. Listener 1 starts → detects speech → captures audio to file_1.wav
 * 2. When speech ends:
 *    - Immediately start Listener 2 (new temp file)
 *    - Start transcribing file_1.wav in parallel
 * 3. If user speaks during transcription:
 *    - Listener 2 captures it to file_2.wav
 *    - When it ends, start Listener 3, transcribe file_2.wav
 * 4. Transcriptions complete and append to transcript in order received
 *
 * This ensures we NEVER miss speech, even during transcription.
 */

type ListenerState = 'listening' | 'recording';

// Clean a path that arrived via paste or drag-drop in the terminal.
// Handles bracketed-paste markers, surrounding quotes, backslash-escaped spaces, ~.
function cleanDroppedPath(raw: string): string | null {
  let s = raw.replace(/\x1b\[20[01]~/g, '').trim();
  if (!s) return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\(.)/g, '$1');
  if (s.startsWith('~/') || s === '~') {
    s = (process.env.HOME ?? '') + s.slice(1);
  }
  if (!s.startsWith('/')) return null;
  return s;
}

export default function App() {
  const { exit } = useApp();
  const [listenerState, setListenerState] = useState<ListenerState>('listening');
  const [transcribingCount, setTranscribingCount] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fileTranscribing, setFileTranscribing] = useState(false);
  const [fileProgress, setFileProgress] = useState<string>('');

  const listenerProcess = useRef<ChildProcess | null>(null);
  const fileTranscribeProcess = useRef<ChildProcess | null>(null);
  const fileCounter = useRef(0);
  const isExiting = useRef(false);
  const pausedRef = useRef(false);  // Ref for event handlers (avoids stale closure)
  const checkInterval = useRef<NodeJS.Timeout | null>(null);
  const maxDurationTimeout = useRef<NodeJS.Timeout | null>(null);
  const immediateStartRef = useRef(false);  // Skip voice detection on next start (for seamless chunking)

  const MAX_RECORDING_DURATION = 30000;  // 30 seconds max per chunk

  // Generate unique temp file path
  const getTempFile = useCallback(() => {
    fileCounter.current += 1;
    return `/tmp/whisper-recording-${fileCounter.current}.wav`;
  }, []);

  // Cleanup a specific audio file
  const cleanupFile = useCallback((filepath: string) => {
    try {
      if (existsSync(filepath)) unlinkSync(filepath);
    } catch {}
  }, []);

  // Transcribe audio file (runs in parallel, doesn't block listener)
  const transcribe = useCallback((audioFile: string) => {
    if (!existsSync(audioFile)) return;

    try {
      const stats = statSync(audioFile);
      if (stats.size < 1000) {
        cleanupFile(audioFile);
        return;
      }
    } catch {
      return;
    }

    setTranscribingCount(c => c + 1);

    const proc = spawn(WHISPER_CLI, [
      '-m', MODEL_PATH,
      '-vm', VAD_MODEL_PATH,
      '--vad',
      '-f', audioFile,
      '-l', 'en',
      '-t', '6',
      '-nt',
      '-np',
      '-mc', '0',  // No text context carryover - prevents hallucination loops
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      if (text.toLowerCase().includes('error') &&
          !text.includes('whisper_init') &&
          !text.includes('silero') &&
          !text.includes('vad')) {
        setError(text.trim().slice(0, 80));
      }
    });

    proc.on('close', () => {
      cleanupFile(audioFile);
      setTranscribingCount(c => Math.max(0, c - 1));

      const cleaned = output
        .replace(/\[.*?\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (cleaned && cleaned.length > 1) {
        setTranscript(prev => (prev ? prev + ' ' + cleaned : cleaned));
      }
    });

    proc.on('error', () => {
      cleanupFile(audioFile);
      setTranscribingCount(c => Math.max(0, c - 1));
    });
  }, [cleanupFile]);

  // Start a new listener (always runs, even during transcription)
  const startListener = useCallback(() => {
    if (isExiting.current || pausedRef.current) return;

    // Kill any existing listener first
    if (listenerProcess.current) {
      listenerProcess.current.kill('SIGTERM');
      listenerProcess.current = null;
    }

    if (checkInterval.current) {
      clearInterval(checkInterval.current);
      checkInterval.current = null;
    }

    const audioFile = getTempFile();
    const shouldStartImmediately = immediateStartRef.current;
    immediateStartRef.current = false;  // Reset after use

    setListenerState(shouldStartImmediately ? 'recording' : 'listening');

    // Normal mode: wait for voice, then record until 2s silence
    // Immediate mode: start recording NOW (for seamless chunking), stop on 2s silence
    const soxArgs = shouldStartImmediately
      ? ['-d', '-r', '16000', '-c', '1', '-b', '16', audioFile,
         'silence', '1', '0', '0%',    // No wait for voice (0% threshold = everything passes)
                   '1', '2.0', '1.5%'] // Still stop on 2s silence
      : ['-d', '-r', '16000', '-c', '1', '-b', '16', audioFile,
         'silence', '1', '0.05', '1.5%',  // Start faster: 1.5% threshold, 0.05s
                   '1', '2.0', '1.5%'];   // Stop slower: wait 2s of silence

    const proc = spawn('sox', soxArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Check file size to detect when recording starts
    checkInterval.current = setInterval(() => {
      try {
        if (existsSync(audioFile)) {
          const stats = statSync(audioFile);
          if (stats.size > 1000) {
            setListenerState('recording');

            // Start max duration timer (only once per recording)
            if (!maxDurationTimeout.current) {
              maxDurationTimeout.current = setTimeout(() => {
                maxDurationTimeout.current = null;
                if (listenerProcess.current && !pausedRef.current && !isExiting.current) {
                  immediateStartRef.current = true;  // Next listener starts recording immediately
                  listenerProcess.current.kill('SIGTERM');  // Triggers close handler
                }
              }, MAX_RECORDING_DURATION);
            }
          }
        }
      } catch {}
    }, 100);

    proc.on('error', (err) => {
      if (checkInterval.current) clearInterval(checkInterval.current);
      if (maxDurationTimeout.current) {
        clearTimeout(maxDurationTimeout.current);
        maxDurationTimeout.current = null;
      }
      setError(`Recording failed: ${err.message}`);
      listenerProcess.current = null;
      // Retry after delay
      if (!isExiting.current && !pausedRef.current) {
        setTimeout(startListener, 1000);
      }
    });

    proc.on('close', () => {
      // Cleanup timers
      if (checkInterval.current) {
        clearInterval(checkInterval.current);
        checkInterval.current = null;
      }
      if (maxDurationTimeout.current) {
        clearTimeout(maxDurationTimeout.current);
        maxDurationTimeout.current = null;
      }
      listenerProcess.current = null;

      if (isExiting.current) return;

      // Transcribe if we have meaningful audio (works for normal end, pause, OR timeout kill)
      let hasAudio = false;
      if (existsSync(audioFile)) {
        try {
          const stats = statSync(audioFile);
          if (stats.size > 1000) {
            hasAudio = true;
            transcribe(audioFile);
          } else {
            cleanupFile(audioFile);
          }
        } catch {
          cleanupFile(audioFile);
        }
      }

      // Restart listener if not paused
      if (!pausedRef.current) {
        if (immediateStartRef.current) {
          startListener();  // Immediate restart for seamless chunking
        } else if (hasAudio) {
          startListener();  // Normal restart after speech
        } else {
          setTimeout(startListener, 100);  // Brief delay if no audio captured
        }
      }
    });

    listenerProcess.current = proc;
  }, [getTempFile, transcribe, cleanupFile]);

  // Start on mount
  useEffect(() => {
    startListener();

    return () => {
      isExiting.current = true;
      if (checkInterval.current) clearInterval(checkInterval.current);
      if (maxDurationTimeout.current) clearTimeout(maxDurationTimeout.current);
      if (listenerProcess.current) {
        listenerProcess.current.kill('SIGTERM');
      }
      if (fileTranscribeProcess.current) {
        fileTranscribeProcess.current.kill('SIGTERM');
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle pause/unpause
  useEffect(() => {
    if (!paused && !listenerProcess.current && !isExiting.current) {
      startListener();
    }
  }, [paused, startListener]);

  const copyToClipboard = useCallback(() => {
    if (!transcript) return;
    try {
      execSync(`printf '%s' ${JSON.stringify(transcript)} | pbcopy`);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setError('Copy failed');
      setTimeout(() => setError(null), 3000);
    }
  }, [transcript]);

  // Shared: convert any audio file to wav and run whisper-cli on it.
  // Callers must have set fileTranscribing=true before invoking.
  const runFileTranscription = useCallback((filePath: string) => {
    const wasListening = !pausedRef.current;
    if (wasListening && listenerProcess.current) {
      listenerProcess.current.kill('SIGTERM');
    }

    if (!existsSync(filePath)) {
      setError('File not found');
      setFileTranscribing(false);
      setFileProgress('');
      if (wasListening) startListener();
      return;
    }

    setFileProgress('Converting audio...');

    const tempWav = '/tmp/whisper-file-input.wav';
    try {
      execSync(`afconvert -f WAVE -d LEI16@16000 ${JSON.stringify(filePath)} ${JSON.stringify(tempWav)}`, { encoding: 'utf-8' });
    } catch {
      setError('Failed to convert audio file');
      setFileTranscribing(false);
      setFileProgress('');
      if (wasListening) startListener();
      return;
    }

    setFileProgress('Transcribing 0%...');

    const proc = spawn(WHISPER_CLI, [
      '-m', MODEL_PATH,
      '-vm', VAD_MODEL_PATH,
      '--vad',
      '-f', tempWav,
      '-l', 'en',
      '-t', '6',
      '-nt',
      '-pp',          // print progress -> stderr "progress = N%"
      '-mc', '0',     // No text context carryover - prevents hallucination loops
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    fileTranscribeProcess.current = proc;
    let output = '';

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      const progressMatch = text.match(/progress\s*=\s*(\d+)%/);
      if (progressMatch) {
        setFileProgress(`Transcribing ${progressMatch[1]}%...`);
      }
    });

    proc.on('close', () => {
      fileTranscribeProcess.current = null;
      cleanupFile(tempWav);
      setFileTranscribing(false);
      setFileProgress('');

      const cleaned = output
        .replace(/\[.*?\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (cleaned && cleaned.length > 1) {
        setTranscript(prev => (prev ? prev + ' ' + cleaned : cleaned));
      }

      if (wasListening && !isExiting.current) {
        startListener();
      }
    });

    proc.on('error', () => {
      fileTranscribeProcess.current = null;
      cleanupFile(tempWav);
      setFileTranscribing(false);
      setFileProgress('');
      setError('File transcription failed');
      if (wasListening && !isExiting.current) {
        startListener();
      }
    });
  }, [cleanupFile, startListener]);

  // Open native macOS file picker and transcribe selected file
  const transcribeFile = useCallback(() => {
    if (fileTranscribing) return;

    setFileTranscribing(true);
    setFileProgress('Opening file picker...');

    const script = `
      set theFile to choose file with prompt "Select audio file to transcribe" of type {"public.audio"}
      return POSIX path of theFile
    `;

    let filePath: string;
    try {
      filePath = execSync(`osascript -e '${script}'`, { encoding: 'utf-8' }).trim();
    } catch {
      // User cancelled
      setFileTranscribing(false);
      setFileProgress('');
      return;
    }

    runFileTranscription(filePath);
  }, [fileTranscribing, runFileTranscription]);

  // Handle a file path that arrived via drag-drop or paste in the TUI
  const handleDroppedPath = useCallback((rawInput: string) => {
    if (fileTranscribing) return;
    const filePath = cleanDroppedPath(rawInput);
    if (!filePath) return;
    setFileTranscribing(true);
    setFileProgress('Loading dropped file...');
    runFileTranscription(filePath);
  }, [fileTranscribing, runFileTranscription]);

  const togglePause = useCallback(() => {
    if (paused) {
      pausedRef.current = false;  // Update ref BEFORE state (sync)
      setPaused(false);
      startListener();
    } else {
      pausedRef.current = true;   // Update ref BEFORE state (sync)
      setPaused(true);
      if (listenerProcess.current) {
        listenerProcess.current.kill('SIGTERM');
        // Note: close handler will transcribe any captured audio
      }
      if (checkInterval.current) {
        clearInterval(checkInterval.current);
        checkInterval.current = null;
      }
      if (maxDurationTimeout.current) {
        clearTimeout(maxDurationTimeout.current);
        maxDurationTimeout.current = null;
      }
      setListenerState('listening');
    }
  }, [paused, startListener]);

  useInput((input, key) => {
    // Multi-character input = paste or drag-drop. Try to interpret as a file path.
    if (input.length > 1) {
      handleDroppedPath(input);
      return;
    }

    if (key.escape || input === 'q') {
      isExiting.current = true;
      if (listenerProcess.current) {
        listenerProcess.current.kill('SIGTERM');
      }
      exit();
      return;
    }

    if (input === ' ' || key.return) {
      togglePause();
      return;
    }

    if (input === 'c' && transcript) {
      copyToClipboard();
      return;
    }

    if (key.delete || key.backspace) {
      setTranscript('');
      setError(null);
      return;
    }

    if (input === 'f') {
      transcribeFile();
      return;
    }
  });

  const getStatusDisplay = () => {
    if (fileTranscribing) {
      return <Text color="magenta">◐ {fileProgress}</Text>;
    }

    if (paused) {
      return <Text dimColor>⏸ Paused</Text>;
    }

    return (
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
    );
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text>🐚 </Text>
        <Text bold color="cyan">Sea Shell</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          [SPACE] {paused ? 'Resume' : 'Pause'}  [F] File  [C] Copy  [DEL] Clear  [Q] Quit
        </Text>
      </Box>

      {error && <Text color="red">{error}</Text>}
      {copied && <Text color="green">Copied!</Text>}

      <Box marginBottom={1}>
        {getStatusDisplay()}
      </Box>

      <Box
        borderStyle="round"
        borderColor={
          fileTranscribing ? 'magenta' :
          paused ? 'gray' :
          listenerState === 'recording' ? 'red' :
          transcribingCount > 0 ? 'yellow' : 'green'
        }
        paddingX={2}
        paddingY={1}
        minHeight={8}
      >
        <Text wrap="wrap">
          {transcript || <Text dimColor>Start speaking - always listening</Text>}
        </Text>
      </Box>

      {transcript && (
        <Box marginTop={1}>
          <Text dimColor>{transcript.length} chars</Text>
        </Box>
      )}
    </Box>
  );
}
