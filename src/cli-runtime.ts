import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type {
  CliCommand,
  LibraryCommand,
  MeetingCommand,
  TranscribeCommandOptions,
} from './cli-args.ts';
import {
  defaultConfigPath,
  loadConfig,
  resolveLibraryDir,
  resolveMeetingRoute,
  resolveSaveByDefault,
  updateMeetingConfig,
} from './config.ts';
import { parseCalendarEvents, readMacCalendarEventsAsync } from './calendar.ts';
import {
  findTranscriptRecord,
  listTranscriptRecords,
  renameTranscriptSpeaker,
  saveTranscriptRecord,
  searchTranscriptRecords,
  trashTranscriptRecord,
  writeTranscriptExport,
} from './transcript-library.ts';
import { renderTranscript } from './transcript-renderer.ts';
import { formatSelfUpdateResult, updateRepository } from './self-update.ts';
import { parseSpeakerLabelingEvidence } from './speaker-labeling.ts';
import {
  createMeetingArtifact,
  loadMeetingArtifact,
  saveMeetingArtifact,
} from './meeting-artifact.ts';
import { chatWithMeeting, enrichMeeting } from './meeting-enrichment.ts';
import { transcribeMedia } from './transcription-service.ts';
import { renderCapabilityManifest, seashellCapabilityManifest } from './capabilities.ts';
import { DEFAULT_WHISPER_MODEL_FILENAME } from './model-config.ts';
import {
  parseNativeSystemAudioEvent,
  SYSTEM_AUDIO_HELPER,
} from './live-system-audio.ts';
import {
  CaptureSessionStore,
  captureManifestPath,
  listRecoverableCaptureSessions,
  loadCaptureSession,
} from './capture-session.ts';
import { finalizeCaptureTranscript } from './capture-finalizer.ts';
import { recordBoundedCapture, runCaptureSignalTest } from './capture-test.ts';
import { runAutomaticMeetingWatch } from './automatic-meeting-watch.ts';
import {
  disableMeetingLaunchAtLogin,
  enableMeetingLaunchAtLogin,
  meetingLaunchAtLoginStatus,
} from './launch-at-login.ts';
import { MEETING_SIGNALS_HELPER, readMeetingSignalSnapshot } from './meeting-automation.ts';
import { loadMeetingContextFiles } from './meeting-context.ts';
import { writeMeetingConsent } from './meeting-consent.ts';
import { initializeFirstInstall } from './first-install.ts';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(__filename), '..');

function print(value: string): void {
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
}

function writeOutputAtomic(path: string, contents: string): void {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(absolutePath),
    `.${absolutePath.split('/').at(-1)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, absolutePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function progressCallbacks(options: TranscribeCommandOptions) {
  let progressLineOpen = false;
  const finishProgress = () => {
    if (progressLineOpen) process.stderr.write('\n');
    progressLineOpen = false;
  };
  return {
    onStatus(message: string) {
      if (options.quiet) return;
      finishProgress();
      process.stderr.write(`${message}\n`);
    },
    onWhisperProgress(percentage: number) {
      if (options.quiet || !process.stderr.isTTY) return;
      progressLineOpen = percentage < 100;
      process.stderr.write(`\rTranscribing ${String(percentage).padStart(3, ' ')}%`);
      if (percentage >= 100) process.stderr.write('\n');
    },
    onDiarizationMessage(message: string) {
      if (options.quiet) return;
      finishProgress();
      process.stderr.write(message);
    },
    finishProgress,
  };
}

function loadSpeakerEvidence(path: string) {
  const absolutePath = resolve(path);
  try {
    return parseSpeakerLabelingEvidence(JSON.parse(readFileSync(absolutePath, 'utf8')));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load speaker evidence ${absolutePath}: ${message}`);
  }
}

async function executeTranscription(
  files: string[],
  options: TranscribeCommandOptions,
): Promise<number> {
  const config = loadConfig();
  const libraryDir = resolveLibraryDir(options.libraryDir, process.env, config);
  const shouldSave = options.save ?? resolveSaveByDefault(config);
  const rendered: string[] = [];
  const labelingEvidence = options.speakerEvidencePath
    ? loadSpeakerEvidence(options.speakerEvidencePath)
    : options.labelingEvidence;

  for (const file of files) {
    const progress = progressCallbacks(options);
    try {
      const record = await transcribeMedia(file, {
        ...options,
        routing: config.transcription,
        humainStoreDir: join(libraryDir, '_Humain'),
        labelingEvidence,
        onStatus: progress.onStatus,
        onWhisperProgress: progress.onWhisperProgress,
        onWhisperFallback: progress.onStatus,
        onDiarizationMessage: progress.onDiarizationMessage,
      });
      progress.finishProgress();
      if (shouldSave) {
        const saved = saveTranscriptRecord(libraryDir, record);
        if (!options.quiet) process.stderr.write(`Saved ${saved.directory}\n`);
      }
      rendered.push(renderTranscript(record, options.format, {
        timestamps: options.timestamps,
        speakers: options.speakers,
      }));
    } finally {
      progress.finishProgress();
    }
  }

  const output = rendered.join(options.format === 'text' ? '\n' : '');
  if (options.output) {
    writeOutputAtomic(options.output, `${output}${output.endsWith('\n') ? '' : '\n'}`);
    if (!options.quiet) process.stderr.write(`Wrote ${resolve(options.output)}\n`);
  } else {
    print(output);
  }
  return 0;
}

function printLibraryEntries(entries: ReturnType<typeof listTranscriptRecords>, json: boolean): void {
  if (json) {
    print(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    print('No saved transcripts.');
    return;
  }
  print('ID                        CREATED              DURATION  SPK  TITLE');
  for (const entry of entries) {
    const roundedDuration = entry.duration === undefined ? undefined : Math.round(entry.duration);
    const duration = roundedDuration === undefined
      ? '   —   '
      : `${Math.floor(roundedDuration / 60)}:${String(roundedDuration % 60).padStart(2, '0')}`.padStart(7);
    print(
      `${entry.id.padEnd(25)} ${entry.createdAt.slice(0, 19).padEnd(20)} ` +
      `${duration}  ${String(entry.speakerCount).padStart(3)}  ${entry.title}`,
    );
  }
}

function executeLibrary(command: LibraryCommand): number {
  const libraryDir = resolveLibraryDir(command.libraryDir);
  switch (command.action.kind) {
    case 'list':
      printLibraryEntries(listTranscriptRecords(libraryDir), command.json);
      return 0;
    case 'search':
      printLibraryEntries(searchTranscriptRecords(libraryDir, command.action.query), command.json);
      return 0;
    case 'show': {
      const { record } = findTranscriptRecord(libraryDir, command.action.id);
      print(renderTranscript(record, command.format, {
        timestamps: command.timestamps,
        speakers: command.speakers,
      }));
      return 0;
    }
    case 'export': {
      const path = writeTranscriptExport(
        libraryDir,
        command.action.id,
        command.format,
        command.output,
      );
      print(command.json ? JSON.stringify({ path }, null, 2) : path);
      return 0;
    }
    case 'speakers-set': {
      const record = renameTranscriptSpeaker(
        libraryDir,
        command.action.id,
        command.action.speakerId,
        command.action.label,
      );
      if (command.json) {
        print(JSON.stringify(record, null, 2));
      } else {
        print(`${command.action.speakerId} is now “${command.action.label}”.`);
      }
      return 0;
    }
    case 'open': {
      const path = command.action.id
        ? dirname(findTranscriptRecord(libraryDir, command.action.id).path)
        : libraryDir;
      mkdirSync(path, { recursive: true });
      const result = spawnSync('open', [path], { stdio: 'ignore' });
      if (result.error || result.status !== 0) throw new Error(`Could not open ${path}`);
      return 0;
    }
    case 'trash': {
      if (!command.action.confirmed) {
        throw new Error('Refusing to trash a transcript without --confirm');
      }
      const path = trashTranscriptRecord(libraryDir, command.action.id);
      print(command.json ? JSON.stringify({ trashedTo: path }, null, 2) : `Moved to ${path}`);
      return 0;
    }
  }
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  path?: string;
  help?: string;
}

export function doctorChecks(): DoctorCheck[] {
  const commandCheck = (
    name: string,
    required: boolean,
    help: string,
  ): DoctorCheck => {
    const path = Bun.which(name) ?? undefined;
    return { name, ok: Boolean(path), required, ...(path ? { path } : {}), help };
  };
  const fileCheck = (
    name: string,
    path: string,
    required: boolean,
    help: string,
  ): DoctorCheck => ({ name, path, ok: existsSync(path), required, help });
  const systemAudioPermissionCheck = (): DoctorCheck => {
    if (!existsSync(SYSTEM_AUDIO_HELPER)) {
      return {
        name: 'system-audio-probe',
        ok: false,
        required: false,
        help: 'Run ./install.sh before testing live system audio',
      };
    }
    const result = spawnSync(SYSTEM_AUDIO_HELPER, ['--probe-ms', '500'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const events = (result.stderr ?? '').split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try { return [parseNativeSystemAudioEvent(line)]; } catch { return []; }
    });
    const started = result.status === 0 && events.some((event) => event.type === 'start');
    const receivedBuffer = events.some((event) => event.type === 'first-buffer');
    const failure = events.find((event) => event.type === 'error');
    return {
      name: 'system-audio-probe',
      ok: started,
      required: false,
      ...(receivedBuffer
        ? { path: 'Helper started and received a CoreAudio buffer' }
        : started
          ? { path: 'Helper started; run `seashell capture test` while computer audio is playing' }
        : {
            help: failure?.type === 'error'
              ? failure.message
              : 'Allow Screen & System Audio Recording, then verify the active output device',
          }),
    };
  };
  const meetingSignalCheck = (): DoctorCheck => {
    if (!existsSync(MEETING_SIGNALS_HELPER)) {
      return {
        name: 'meeting-signals',
        ok: false,
        required: false,
        help: 'Run ./install.sh before enabling automatic meeting capture',
      };
    }
    try {
      const snapshot = readMeetingSignalSnapshot();
      return {
        name: 'meeting-signals',
        ok: snapshot.supported,
        required: false,
        path: snapshot.supported
          ? 'CoreAudio process detection is ready'
          : 'This macOS version does not expose process audio signals',
      };
    } catch (error) {
      return {
        name: 'meeting-signals',
        ok: false,
        required: false,
        help: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return [
    commandCheck('bun', true, 'Install Bun from https://bun.sh'),
    commandCheck('ffmpeg', true, 'brew install ffmpeg'),
    commandCheck('ffprobe', true, 'brew install ffmpeg'),
    commandCheck('sox', true, 'brew install sox'),
    fileCheck(
      'whisper-cli',
      join(PROJECT_ROOT, 'whisper.cpp/build/bin/whisper-cli'),
      true,
      'Run ./install.sh',
    ),
    fileCheck(
      'whisper-model',
      join(PROJECT_ROOT, 'models', DEFAULT_WHISPER_MODEL_FILENAME),
      true,
      'Run ./install.sh',
    ),
    fileCheck(
      'diarization-python',
      join(PROJECT_ROOT, '.venv-diarization/bin/python'),
      false,
      'See README speaker diarization setup',
    ),
    fileCheck(
      'system-audio-helper',
      SYSTEM_AUDIO_HELPER,
      false,
      'Run ./install.sh; live system audio requires macOS 14.2+',
    ),
    systemAudioPermissionCheck(),
    meetingSignalCheck(),
  ];
}

function executeDoctor(json: boolean): number {
  const checks = doctorChecks();
  if (json) {
    print(JSON.stringify({ ok: checks.every((check) => !check.required || check.ok), checks }, null, 2));
  } else {
    for (const check of checks) {
      const status = check.ok ? '✓' : check.required ? '✗' : '○';
      print(`${status} ${check.name.padEnd(20)} ${check.path ?? check.help ?? ''}`);
    }
  }
  return checks.every((check) => !check.required || check.ok) ? 0 : 1;
}

function executeUpdate(check: boolean, json: boolean): number {
  try {
    const result = updateRepository({ projectRoot: PROJECT_ROOT, check });
    print(json ? JSON.stringify({ ok: true, ...result }, null, 2) : formatSelfUpdateResult(result));
    return 0;
  } catch (error) {
    if (!json) throw error;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    return 1;
  }
}

function readJsonFile(path: string, label: string): unknown {
  const absolutePath = resolve(path);
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${label} ${absolutePath}: ${message}`);
  }
}

function meetingRoute(
  command: Extract<MeetingCommand['action'], { kind: 'enrich' | 'chat' }>,
  config: ReturnType<typeof loadConfig>,
  role: 'observer' | 'reconciliation' | 'chat',
) {
  const route = resolveMeetingRoute(config.meeting, role, {
    ...(command.backend === undefined ? {} : { backend: command.backend }),
    ...(command.model === undefined ? {} : { model: command.model }),
  });
  if (!route) {
    throw new Error(
      `Meeting ${role} intelligence requires an exact route. Pass --backend and --model or configure meeting.routes.${role}.`,
    );
  }
  return route;
}

async function executeMeeting(command: MeetingCommand): Promise<number> {
  const config = loadConfig();
  const libraryDir = resolveLibraryDir(command.libraryDir, process.env, config);
  switch (command.action.kind) {
    case 'setup': {
      const contextFiles = command.action.contextFiles?.map((path) => resolve(path));
      if (contextFiles) loadMeetingContextFiles(contextFiles);
      const updated = updateMeetingConfig({
        ...(command.action.mode === undefined ? {} : { mode: command.action.mode }),
        ...(command.action.backend === undefined ? {} : { backend: command.action.backend }),
        ...(command.action.model === undefined ? {} : { model: command.action.model }),
        ...(command.action.routes === undefined ? {} : { routes: command.action.routes }),
        ...(contextFiles === undefined
          ? {}
          : { contextFiles }),
        ...(command.action.calendarPolicy === undefined
          ? {}
          : {
              calendar: {
                enabled: command.action.calendarPolicy !== 'off',
                policy: command.action.calendarPolicy,
              },
            }),
        ...(
          command.action.automationMode === undefined &&
          command.action.browserWithoutCalendar === undefined
            ? {}
            : {
                automation: {
                  enabled: command.action.automationMode !== 'off',
                  ...(command.action.automationMode === undefined
                    ? {}
                    : { mode: command.action.automationMode }),
                  ...(command.action.browserWithoutCalendar === undefined
                    ? {}
                    : { browserWithoutCalendar: command.action.browserWithoutCalendar }),
                },
              }
        ),
      });
      print(command.json
        ? JSON.stringify({ path: defaultConfigPath(), config: updated }, null, 2)
        : `Saved meeting settings to ${defaultConfigPath()}`);
      return 0;
    }
    case 'create': {
      const { record } = findTranscriptRecord(libraryDir, command.action.id);
      const calendar = command.action.eventJsonPath
        ? parseCalendarEvents([readJsonFile(command.action.eventJsonPath, 'calendar event')])[0]
        : undefined;
      const existing = loadMeetingArtifact(libraryDir, record.id);
      const artifact = existing ?? createMeetingArtifact(record, {
        ...(calendar ? { calendar } : {}),
        mode: command.action.mode ?? config.meeting?.mode,
        maxObserverRuns: config.meeting?.maxObserverRuns,
      });
      const directory = saveMeetingArtifact(libraryDir, artifact);
      print(command.json
        ? JSON.stringify({ directory, meeting: artifact }, null, 2)
        : `Created meeting artifact in ${directory}`);
      return 0;
    }
    case 'show': {
      const artifact = loadMeetingArtifact(libraryDir, command.action.id);
      if (!artifact) throw new Error(`Meeting artifact not found: ${command.action.id}`);
      if (command.json) {
        print(JSON.stringify(artifact, null, 2));
      } else {
        const claimCount = artifact.analysis?.claims.length ?? artifact.provisionalClaims.length;
        print([
          artifact.title,
          `Status: ${artifact.status} · mode ${artifact.mode}`,
          `Attendees: ${artifact.attendees.map((attendee) => attendee.name).join(', ') || 'none'}`,
          `Claims: ${claimCount}`,
          artifact.analysis?.summary ?? 'No analysis yet.',
        ].join('\n'));
      }
      return 0;
    }
    case 'enrich': {
      const mode = command.action.mode ?? config.meeting?.mode ?? 'hybrid';
      const observerRoute = mode === 'post-session'
        ? undefined
        : meetingRoute(command.action, config, 'observer');
      const reconciliationRoute = mode === 'streaming'
        ? undefined
        : meetingRoute(command.action, config, 'reconciliation');
      const context = command.action.contextPath
        ? readJsonFile(command.action.contextPath, 'meeting context')
        : undefined;
      const artifact = await enrichMeeting(libraryDir, command.action.id, {
        routes: {
          ...(observerRoute === undefined ? {} : { observer: observerRoute }),
          ...(reconciliationRoute === undefined ? {} : { reconciliation: reconciliationRoute }),
        },
        mode,
        ...(context === undefined ? {} : { context }),
        minimumNewSegments: config.meeting?.observerMinSegments,
        maximumNewSegments: config.meeting?.observerMaxSegments,
        maxObserverRuns: config.meeting?.maxObserverRuns,
        onStatus: (message) => process.stderr.write(`${message}\n`),
      });
      print(command.json
        ? JSON.stringify(artifact, null, 2)
        : `Meeting enrichment ready: ${artifact.title}`);
      return 0;
    }
    case 'chat': {
      const artifact = await chatWithMeeting(
        libraryDir,
        command.action.id,
        command.action.question,
        meetingRoute(command.action, config, 'chat'),
        (message) => process.stderr.write(`${message}\n`),
      );
      const answer = artifact.chat.at(-1);
      print(command.json ? JSON.stringify(answer, null, 2) : answer?.text ?? '');
      return 0;
    }
    case 'calendar': {
      const events = await readMacCalendarEventsAsync({
        leadMinutes: config.meeting?.calendar?.leadMinutes,
      });
      if (command.json) {
        print(JSON.stringify(events, null, 2));
      } else if (events.length === 0) {
        print('No current or upcoming calendar meetings found.');
      } else {
        print(events.map((event) => `${event.startAt}  ${event.title}  ${event.calendar ?? ''}`).join('\n'));
      }
      return 0;
    }
    case 'watch': {
      const once = command.action.once;
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        await runAutomaticMeetingWatch({
          config,
          libraryDir,
          signal: controller.signal,
          once,
          onEvent: (event) => {
            if (command.json) {
              print(JSON.stringify(event));
              return;
            }
            if (event.type === 'watch.ready') print('Sea Shell is watching for meetings.');
            else if (event.type === 'meeting.started') print(`Recording ${event.candidate.title}.`);
            else if (event.type === 'meeting.capture-finished') print(`Captured ${event.candidate.title}; finalizing in the background.`);
            else if (event.type === 'meeting.ready') print(`Meeting ready: ${event.directory}`);
            else if (event.type === 'meeting.suggested') {
              print(`Possible ${event.candidate.appName} meeting detected; run \`seashell meeting consent approve\` to record it.`);
              if (!once) {
                spawnSync('osascript', [
                  '-e', 'on run argv',
                  '-e', 'display notification (item 1 of argv) with title "Sea Shell"',
                  '-e', 'end run',
                  `Possible ${event.candidate.appName} meeting. Run seashell meeting consent approve to record.`,
                ], { stdio: 'ignore' });
              }
            }
            else process.stderr.write(`${event.type}: ${event.message}\n`);
          },
        });
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
      return 0;
    }
    case 'consent': {
      const path = writeMeetingConsent(command.action.decision);
      print(command.json
        ? JSON.stringify({ decision: command.action.decision, path }, null, 2)
        : command.action.decision === 'approve'
          ? 'Approved the current background meeting suggestion for the next two minutes.'
          : 'Declined the current background meeting suggestion.');
      return 0;
    }
    case 'autostart': {
      const status = command.action.operation === 'enable'
        ? enableMeetingLaunchAtLogin()
        : command.action.operation === 'disable'
          ? disableMeetingLaunchAtLogin()
          : meetingLaunchAtLoginStatus();
      if (command.action.operation !== 'status') {
        updateMeetingConfig({ automation: { launchAtLogin: command.action.operation === 'enable' } });
      }
      print(command.json ? JSON.stringify(status, null, 2) : [
        status.enabled ? '✓ Sea Shell meeting watch launches when you log into this Mac' : '○ Launch at login is disabled',
        `  service: ${status.loaded ? 'running' : 'not running'}`,
        `  config: ${status.plistPath}`,
      ].join('\n'));
      return 0;
    }
  }
}

async function executeCapture(
  command: Extract<Exclude<CliCommand, { kind: 'tui' | 'help' }>, { kind: 'capture' }>,
): Promise<number> {
  const config = loadConfig();
  const libraryDir = resolveLibraryDir(command.libraryDir, process.env, config);
  if (command.action.kind === 'test') {
    process.stderr.write(`Speak and play meeting audio for ${command.action.seconds} seconds…\n`);
    const result = await runCaptureSignalTest(libraryDir, command.action.seconds);
    print(command.json ? JSON.stringify(result, null, 2) : [
      result.ready ? '✓ Microphone + system audio are ready' : '○ Capture needs attention',
      `  microphone: ${result.microphone.audibleChunks > 0 ? 'signal detected' : 'no speech detected'} (${result.microphone.chunks} chunks)`,
      `  system audio: ${result.systemAudio.audibleChunks > 0 ? 'signal detected' : 'no speech detected'} (${result.systemAudio.chunks} chunks)`,
      ...result.guidance.map((line) => `  next: ${line}`),
      '  test audio discarded',
    ].join('\n'));
    return result.ready ? 0 : 2;
  }
  if (command.action.kind === 'record') {
    process.stderr.write(`Capturing microphone + system audio for ${command.action.seconds} seconds…\n`);
    const result = await recordBoundedCapture(libraryDir, command.action.seconds);
    print(command.json ? JSON.stringify(result, null, 2) : [
      `Captured ${result.session.sessionId}`,
      result.manifestPath,
      `Finalize: seashell capture finalize ${result.session.sessionId}`,
    ].join('\n'));
    return 0;
  }
  if (command.action.kind === 'list') {
    const sessions = listRecoverableCaptureSessions(libraryDir).map((manifest) => ({
      id: manifest.sessionId,
      status: manifest.status,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      durationMs: Math.max(0, ...manifest.chunks.map((chunk) => chunk.endMs)),
      chunks: manifest.chunks.length,
      audibleChunks: manifest.chunks.filter((chunk) => chunk.audible).length,
    }));
    print(command.json ? JSON.stringify(sessions, null, 2) : (
      sessions.length === 0
        ? 'No recoverable live captures.'
        : sessions.map((session) => (
            `${session.id}  ${session.status}  ${session.chunks} chunks  ${session.createdAt}`
          )).join('\n')
    ));
    return 0;
  }
  const manifestPath = captureManifestPath(libraryDir, command.action.id);
  if (command.action.kind === 'show') {
    const manifest = loadCaptureSession(manifestPath);
    print(command.json ? JSON.stringify(manifest, null, 2) : [
      `${manifest.sessionId} · ${manifest.status}`,
      `${manifest.chunks.length} durable chunks`,
      `Started ${manifest.createdAt}`,
      manifestPath,
    ].join('\n'));
    return 0;
  }
  const record = await finalizeCaptureTranscript(manifestPath, {
    onStatus: (message) => process.stderr.write(`${message}\n`),
  });
  const saved = saveTranscriptRecord(libraryDir, record);
  const store = new CaptureSessionStore({
    libraryDir,
    sessionId: command.action.id,
    startedAtUnixMs: loadCaptureSession(manifestPath).startedAtUnixMs,
  });
  store.setStatus('completed', 'final-transcript-published');
  store.attachTo(saved.directory);
  print(command.json ? JSON.stringify(record, null, 2) : (
    `Recovered ${record.title}\n${saved.directory}`
  ));
  return 0;
}

export async function executeCliCommand(command: Exclude<CliCommand, { kind: 'tui' | 'help' }>): Promise<number> {
  switch (command.kind) {
    case 'capabilities':
      print(command.json
        ? JSON.stringify(seashellCapabilityManifest(), null, 2)
        : renderCapabilityManifest());
      return 0;
    case 'transcribe':
      return executeTranscription(command.files, command.options);
    case 'capture':
      return executeCapture(command);
    case 'library':
      return executeLibrary(command);
    case 'doctor':
      return executeDoctor(command.json);
    case 'setup': {
      const result = initializeFirstInstall({ enableAutostart: command.autostart });
      if (command.json) {
        print(JSON.stringify(result, null, 2));
      } else if (!result.initialized) {
        print(`Existing Sea Shell settings preserved at ${result.configPath}`);
      } else {
        print([
          `Sea Shell is ready. Settings saved to ${result.configPath}`,
          'Automatic capture: on for dedicated meeting apps and calendar-backed browser meetings',
          'Browser without Calendar: asks before recording',
          `Launch at login: ${result.launchAtLogin}`,
          ...(result.warning ? [`Note: ${result.warning}`, 'Enable later with: seashell meeting autostart enable'] : []),
        ].join('\n'));
      }
      return 0;
    }
    case 'update':
      return executeUpdate(command.check, command.json);
    case 'meeting':
      return executeMeeting(command);
  }
}
