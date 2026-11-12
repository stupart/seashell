import { installHumainPackage, requireHumainNode } from './humain-install.ts';
import { checkMeetConnection, requestMeetAccessibilityPermission, meetPermissionHelp, MEETING_ACCESSIBILITY_HELPER } from './meet-speakers.ts';
import { microphonePermission, microphoneStartNotifier, microphoneUpdateNotice } from './microphone-permission.ts';
import { calendarPermission } from './calendar-permission.ts';
import { readFeatureStatuses, renderFeatureStatusTable } from './feature-status.ts';
import { oneSidedNotifier } from './capture-health.ts';
import { runMeetingsMcpServer } from './meetings-mcp.ts';
import { addMeetingNote, carryCaptureNotes, recordingBundle, noteAtMoment, writeNoteCommand } from './owner-notes.ts';
import { installMeetingsMcp } from './mcp-install.ts';
import { mergeMeetingFragments, planMeetingMerges } from './meeting-merge.ts';
import { discoverHumainProviders, resolveHumainExecutable } from './humain-client.ts';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type {
  CliCommand,
  LibraryCommand,
  MeetingCommand,
  MeetingVideoAction,
  TranscribeCommandOptions,
} from './cli-args.ts';
import {
  defaultConfigPath,
  loadConfig,
  resolveLibraryDir,
  resolveMeetingRoute,
  resolveSaveByDefault,
  updateMeetingConfig,
  updateSpeakerEngine,
  type SeashellConfig,
} from './config.ts';
import { findBrief, makeBrief, nextCalendarMeeting, upcomingFromEvent, type UpcomingMeeting } from './briefs.ts';
import { draftFollowUp, draftText } from './drafts.ts';
import { ensureVocabularyFile, loadVocabulary } from './vocabulary.ts';
import { sentenceClock } from './tui-state.ts';
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
import {
  ensureTemplatesDirectory,
  findMeetingTemplate,
  loadMeetingTemplates,
  loadProfile,
  meetingInstructions,
  NO_TEMPLATE,
  PROFILE_FILE,
} from './meeting-templates.ts';
import { transcribeMedia } from './transcription-service.ts';
import { PACKAGE_VERSION, renderCapabilityManifest, seashellCapabilityManifest } from './capabilities.ts';
import { DEFAULT_WHISPER_MODEL_FILENAME } from './model-config.ts';
import {
  defaultSystemAudioHelper,
  parseNativeSystemAudioEvent,
  systemAudioIdentity,
  systemAudioIdentityArguments,
} from './live-system-audio.ts';
import { readAudioChecks } from './audio-checks.ts';
import { checkComputerAudio } from './audio-levels.ts';
import { systemAudioRuntimeHelperPath } from './runtime-host.ts';
import {
  CaptureSessionStore,
  captureManifestPath,
  listRecoverableCaptureSessions,
  loadCaptureSession,
} from './capture-session.ts';
import { finalizeCaptureTranscript } from './capture-finalizer.ts';
import { recordBoundedCapture, runCaptureSignalTest } from './capture-test.ts';
import { runAutomaticMeetingWatch, watchRestartReason } from './automatic-meeting-watch.ts';
import {
  disableMeetingLaunchAtLogin,
  enableMeetingLaunchAtLogin,
  SEASHELL_LAUNCH_AGENT_LABEL,
  meetingLaunchAtLoginStatus,
  meetingWatchLogFiles,
} from './launch-at-login.ts';
import { WarningRateLimit, watchLogWriter } from './watch-log.ts';
import { MEETING_SIGNALS_HELPER, readMeetingSignalSnapshot } from './meeting-automation.ts';
import { buildMeetingContext, loadMeetingContextFiles } from './meeting-context.ts';
import { writeMeetingConsent } from './meeting-consent.ts';
import { recorderAnswering, requestRecorder, writeMeetingCommand } from './meeting-command.ts';
import { readBackgroundWatchStatus } from './background-watch-status.ts';
import { DEFAULT_MEETING_AUTOMATION, meetingApps, type MeetingCandidate } from './meeting-automation.ts';
import { diarizationStatus } from './diarization-environment.ts';
import { identifySavedSpeakers } from './speaker-reprocessing.ts';
import { setupDiarization } from './diarization-setup.ts';
import { compareSavedSpeakers, renderSpeakerComparison } from './speaker-compare.ts';
import { listVoiceprints } from './voiceprints.ts';
import { initializeFirstInstall } from './first-install.ts';
import { SCREEN_CAPTURE_HELPER, screenCapturePermission, screenFilmedNotifier } from './video-capture.ts';
import { clearVideoRequest, DEFAULT_MEETING_VIDEO, startRecordingWithVideo } from './video-recording.ts';
import { openMeetingVideo } from './video-meeting.ts';
import { testMeetingAi, type MeetingAiRole } from './humain-client.ts';
import { ensurePromptsDirectory, listPrompts, resetPrompt } from './prompts.ts';
import { ensureExtractorsDirectory, loadExtractors, runAutomaticExtractors, runExtractor } from './extractors.ts';
import {
  afterMeetingReady,
  askAutomationApprovalWithDialog,
  automationApprovalNote,
  automationDecision,
  automationNeedsApproval,
  ensureAutomationsDirectory,
  loadAutomations,
  readAutomationRuns,
  runAutomations,
} from './automations.ts';
import { queryNotes } from './meeting-memory.ts';
import { cleanPhantoms, forgetPersonVoice, listTranscriptHistory, restoreTranscript } from './transcript-edits.ts';
import { claimOwnerAndDue, type MeetingAttendee } from './meeting-artifact.ts';
import type { MeetingIntelligenceCommand } from './cli-args.ts';

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

async function executeLibrary(command: LibraryCommand): Promise<number> {
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
    case 'speakers-identify': {
      const record = await identifySavedSpeakers(libraryDir, command.action.id, {
        onStatus: (message) => process.stderr.write(message + '\n'),
      });
      print(command.json ? JSON.stringify(record, null, 2) : `Saved review copy: ${record.title} (${record.id}). Original unchanged.`);
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
    case 'clean-phantoms':
      return executeCleanPhantoms(libraryDir, command.action.ids, command.action.dryRun, command.json);
  }
}

/** Lines heard in silence, per meeting. A dry run changes nothing. */
async function executeCleanPhantoms(libraryDir: string, ids: string[], dryRun: boolean, json: boolean): Promise<number> {
  const results = await cleanPhantoms(libraryDir, {
    dryRun, ids, onStatus: (message) => { if (!json) process.stderr.write(`${message}\n`); },
  });
  if (json) {
    print(JSON.stringify({ dryRun, meetings: results }, null, 2));
    return 0;
  }
  const found = results.filter((result) => result.phantoms > 0);
  const problems = results.filter((result) => result.skipped && result.skipped !== 'no saved audio');
  const total = found.reduce((sum, result) => sum + result.phantoms, 0);
  const unrecorded = results.reduce((sum, result) => sum + (result.unrecorded ?? 0), 0);
  print([
    ...found.map((result) => `${result.title} (${result.id}): ${result.phantoms} of ${result.segments} lines ${dryRun ? 'heard in silence' : 'removed'}`),
    ...problems.map((result) => `${result.title} (${result.id}): skipped, ${result.skipped}`),
    `${results.length - results.filter((result) => result.skipped).length} meetings checked; ${total} lines ${dryRun ? 'heard in silence' : 'removed'}.`,
    ...(unrecorded ? [`${unrecorded} lines have no recorded audio under them, so they are kept.`] : []),
    ...(dryRun && total ? ['Dry run: nothing changed. Remove them: seashell library clean-phantoms'] : []),
    ...(!dryRun && total ? ['Each old transcript is in its meeting\'s history folder. Notes were kept and marked as possibly out of date.'] : []),
  ].join('\n'));
  return 0;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  path?: string;
  help?: string;
}

export function doctorChecks(options: {
  systemAudioHelper?: string;
  meetingSignalsHelper?: string;
  meetingAccessibilityHelper?: string;
  systemAudioProbeTimeoutMs?: number;
} = {}): DoctorCheck[] {
  // The copy the recorder runs, so the probe tests the permission meetings use.
  const systemAudioHelper = options.systemAudioHelper ?? defaultSystemAudioHelper();
  const identity = options.systemAudioHelper ? 'inherited' : systemAudioIdentity(systemAudioHelper);
  const meetingSignalsHelper = options.meetingSignalsHelper ?? MEETING_SIGNALS_HELPER;
  const meetingAccessibilityHelper = options.meetingAccessibilityHelper ?? MEETING_ACCESSIBILITY_HELPER;
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
    if (!existsSync(systemAudioHelper)) {
      return {
        name: 'system-audio-probe',
        ok: false,
        required: false,
        help: 'Run ./install.sh before testing live system audio',
      };
    }
    // The identity meetings record with, so doctor never asks macOS about a new one.
    const result = spawnSync(systemAudioHelper, [...systemAudioIdentityArguments(identity), '--probe-ms', '500'], {
      encoding: 'utf8',
      timeout: options.systemAudioProbeTimeoutMs ?? 5_000,
      // The native helper handles SIGTERM on its main queue, which CoreAudio
      // startup can block. A read-only probe must still honor its deadline.
      killSignal: 'SIGKILL',
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
            help: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
              ? 'System audio probe timed out; check macOS audio permissions and the active output device'
              : failure?.type === 'error'
                ? failure.message
                : 'Allow Screen & System Audio Recording, then verify the active output device',
          }),
    };
  };
  const meetingSignalCheck = (): DoctorCheck => {
    if (!existsSync(meetingSignalsHelper)) {
      return {
        name: 'meeting-signals',
        ok: false,
        required: false,
        help: 'Run ./install.sh before enabling automatic meeting capture',
      };
    }
    try {
      const snapshot = readMeetingSignalSnapshot(meetingSignalsHelper);
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

  const humainCheck = () => {
    try {
      const executable = resolveHumainExecutable();
      requireHumainNode();
      return { name: 'meeting-ai', ok: true, required: false, path: executable.prefix[0] ?? executable.command };
    } catch (error) {
      return { name: 'meeting-ai', ok: false, required: false,
        help: error instanceof Error ? error.message : String(error) };
    }
  };
  return [
    humainCheck(),
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
    {
      name: 'speaker-identification',
      ok: diarizationStatus().ready,
      required: false,
      ...(diarizationStatus().ready ? { path: 'Model verified; cached locally' }
        : { help: diarizationStatus().nextStep }),
    },
    fileCheck(
      'system-audio-helper',
      systemAudioHelper,
      false,
      'Run ./install.sh; live system audio requires macOS 14.2+',
    ),
    systemAudioPermissionCheck(),
    {
      name: 'system-audio-identity',
      ok: identity === 'own',
      required: false,
      ...(identity === 'own' ? { path: 'Meetings record computer audio with Seashell System Audio' }
        : { help: 'Meetings record computer audio with the background recorder\'s permission. To switch, run seashell meeting computer-audio setup at your Mac, or press , in Seashell and check Computer audio.' }),
    },
    meetingSignalCheck(),
    fileCheck(
      'meeting-accessibility-helper',
      meetingAccessibilityHelper,
      false,
      'Run ./install.sh; optional Meet names use macOS Accessibility. Set up access with seashell meeting speakers setup.',
    ),
    fileCheck(
      'screen-capture-helper',
      SCREEN_CAPTURE_HELPER,
      false,
      'Run ./install.sh; meeting video uses macOS Screen Recording. Set up access with seashell meeting video setup.',
    ),
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
    const result = updateRepository({ projectRoot: PROJECT_ROOT, check,
      ...(process.env.SEASHELL_MANAGED_BY === 'homebrew' ? { managedBy: 'homebrew' as const } : {}),
    });
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
    case 'video':
      return executeMeetingVideo(command.action, command.json, libraryDir, config);
    case 'merge': {
      const groups = command.action.auto
        ? planMeetingMerges(libraryDir, { maxGapMinutes: command.action.maxGapMinutes })
        : [{ ids: command.action.ids }];
      const time = (iso?: string) => iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      if (command.action.dryRun) {
        print(command.json ? JSON.stringify(groups, null, 2) : groups.length
          ? groups.map(group => `${'title' in group ? `${group.title} · ${time(group.startedAt)} → ${time(group.endedAt)}\n  ` : ''}seashell meeting merge ${group.ids.join(' ')}`).join('\n')
          : 'No split meetings found.');
        return 0;
      }
      const merged = groups.map(group => mergeMeetingFragments(libraryDir, group.ids));
      print(command.json ? JSON.stringify(merged.map(result => ({
        id: result.record.id, directory: result.directory, segments: result.record.transcript.length, trashed: result.trashed,
      })), null, 2) : merged.length
        ? merged.map(result => `Merged ${result.trashed.length} pieces into ${result.record.id} (${result.record.transcript.length} segments): ${result.directory}`).join('\n')
        : 'No split meetings found.');
      return 0;
    }
    case 'restore': {
      const { id, file } = command.action;
      const lines = (count: number) => `${count} line${count === 1 ? '' : 's'}`;
      if (file !== undefined) {
        const result = restoreTranscript(libraryDir, id, file);
        print(command.json ? JSON.stringify(result, null, 2) : result.restored
          ? `Restored ${result.file} (${lines(result.segments)}). The transcript it replaced is in history too; the notes stay, marked as possibly out of date.`
          : `${result.file} is already the transcript. Nothing changed.`);
        return 0;
      }
      const copies = listTranscriptHistory(libraryDir, id);
      const time = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      print(command.json ? JSON.stringify(copies, null, 2) : copies.length ? [
        'Kept before each change, newest first:',
        ...copies.map((copy) => `  ${time(copy.savedAt)}  ${copy.why.replace(/-/gu, ' ')}  ${lines(copy.segments)}  ${copy.file}`),
        `Restore one: seashell meeting restore ${id} <file>`,
      ].join('\n') : 'No earlier transcripts are kept for this meeting.');
      return 0;
    }
    case 'template':
    case 'note':
    case 'meeting-ai': {
      const { record } = findTranscriptRecord(libraryDir, command.action.id);
      const artifact = loadMeetingArtifact(libraryDir, record.id) ?? createMeetingArtifact(record);
      const ai = { ...artifact.ai };
      if (command.action.kind === 'template' && command.action.template !== undefined) {
        const wanted = command.action.template.trim();
        if (wanted.toLowerCase() === 'auto') delete ai.template;
        else if (wanted.toLowerCase() === NO_TEMPLATE) ai.template = NO_TEMPLATE;
        else {
          const found = findMeetingTemplate(loadMeetingTemplates(libraryDir), wanted);
          if (!found) throw new Error(`No template named "${wanted}". See: seashell templates`);
          ai.template = found.name;
        }
      }
      if (command.action.kind === 'note' && command.action.note !== undefined) {
        if (command.action.note.trim()) ai.note = command.action.note.trim();
        else delete ai.note;
      }
      if (command.action.kind === 'meeting-ai' && command.action.off !== undefined) {
        if (command.action.off) ai.off = true;
        else delete ai.off;
      }
      const changed = command.action.kind === 'template' ? command.action.template !== undefined
        : command.action.kind === 'note' ? command.action.note !== undefined
          : command.action.off !== undefined;
      const next = { ...artifact, ai };
      if (!Object.keys(ai).length) delete (next as { ai?: unknown }).ai;
      if (changed) saveMeetingArtifact(libraryDir, next);
      const selected = meetingInstructions(libraryDir, {
        title: next.title,
        ...(next.calendar?.title ? { calendarTitle: next.calendar.title } : {}),
        ...(next.ai?.template ? { template: next.ai.template } : {}),
      }).template;
      print(command.json ? JSON.stringify({ id: record.id, ai: next.ai?.off ? 'off' : 'on', template: selected?.name ?? null, chosen: next.ai?.template ?? 'auto', note: next.ai?.note ?? null }, null, 2) : [
        `${next.title}`,
        `  AI: ${next.ai?.off ? 'off — no notes or chat, and agents are refused it' : 'on'}`,
        `  Template: ${selected?.name ?? 'none'}${next.ai?.template ? '' : ' (from the title)'}`,
        `  Note: ${next.ai?.note ?? '—'}`,
        ...(changed && !next.ai?.off ? ['Applies the next time notes run: seashell meeting enrich ' + record.id] : []),
      ].join('\n'));
      return 0;
    }
    case 'microphone': {
      const result = await microphonePermission({ request: command.action.operation === 'setup' });
      if (command.action.operation === 'setup' && result.authorization === 'denied') {
        spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'], { stdio: 'ignore', timeout: 5_000 });
      }
      print(command.json ? JSON.stringify(result) : [
        `Meeting microphone · ${result.authorization}`, result.detail,
        ...(result.executable ? [`Permission belongs to: ${result.executable}`] : []),
      ].join('\n'));
      return result.authorization === 'authorized' ? 0 : 2;
    }
    case 'computer-audio': {
      if (command.action.operation === 'setup') {
        process.stderr.write('Playing a short sound to check. If macOS asks about "Seashell System Audio", choose Allow.\n');
        const result = await checkComputerAudio();
        if (result.refused) {
          spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], { stdio: 'ignore', timeout: 5_000 });
        }
        print(command.json ? JSON.stringify(result) : result.detail);
        return result.heard ? 0 : 2;
      }
      // Read only: which copy is installed, and whether a check confirmed it.
      const identity = systemAudioIdentity(systemAudioRuntimeHelperPath());
      const checkedAt = readAudioChecks().computer;
      print(command.json ? JSON.stringify({ identity, ...(checkedAt ? { checkedAt } : {}) }) : identity === 'own'
        ? 'Meetings record computer audio with Seashell System Audio.'
        : 'Meetings record computer audio with the background recorder\'s permission.\n' +
          'To switch to Seashell System Audio, run this at your Mac: seashell meeting computer-audio setup');
      return 0;
    }
    case 'speakers': {
      const selected = command.action.browser;
      const browser = selected === 'setup' ? 'auto'
        : selected === 'check' ? config.meeting?.speakerBrowser ?? 'off' : selected;
      if (selected !== 'check') updateMeetingConfig({ speakerBrowser: browser });
      if (browser === 'off') {
        print(command.json ? JSON.stringify({ state: 'off' }) : 'Meet reader off. Connect with Accessibility: seashell meeting speakers setup.');
        return 0;
      }
      const result = selected === 'setup'
        ? await requestMeetAccessibilityPermission()
        : await checkMeetConnection(browser);
      // Preflight output does not dump participant identifiers or meeting URLs.
      print(command.json ? JSON.stringify({ browser, detectedBrowser: result.browser, state: result.state, detail: result.detail }) : [
        `Meet names · Accessibility · ${browser} · ${result.state}`, result.detail,
        ...(result.state === 'permission' && result.detail !== meetPermissionHelp(browser) ? [meetPermissionHelp(browser)] : []),
        'Experimental Google Meet support in Chrome. No browser extension or developer setting required.',
        'Reopen Seashell after changing the connection setting. In the app, V also connects/checks names.',
        'Timing hints only: keep participant tiles visible and avoid other audio playback.',
      ].join('\n'));
      return result.state === 'connected' || result.state === 'idle' ? 0 : 2;
    }
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
      const existingMeeting = loadMeetingArtifact(libraryDir, command.action.id);
      const context = command.action.contextPath
        ? readJsonFile(command.action.contextPath, 'meeting context')
        : {
            ...buildMeetingContext(config.meeting?.contextFiles, existingMeeting?.calendar),
            attendees: existingMeeting?.attendees ?? [],
          };
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
      // Extractors whose "when" fits this meeting run after its final notes.
      if (reconciliationRoute && artifact.analysis?.final) {
        await runAutomaticExtractors(libraryDir, artifact.transcriptId, {
          route: reconciliationRoute, onStatus: (message) => process.stderr.write(`${message}\n`),
        });
      }
      print(command.json
        ? JSON.stringify(loadMeetingArtifact(libraryDir, artifact.transcriptId) ?? artifact, null, 2)
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
      if (command.action.operation) {
        const result = await calendarPermission({ request: command.action.operation === 'setup' });
        let enabled = config.meeting?.calendar?.enabled === true && config.meeting.calendar.policy !== 'off';
        if (command.action.operation === 'setup') {
          if (result.authorization === 'authorized' && !enabled) {
            updateMeetingConfig({ calendar: { enabled: true, policy: config.meeting?.calendar?.policy ?? 'ask' } });
            enabled = true;
          }
          if (result.authorization === 'denied' || result.authorization === 'writeOnly') {
            spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'], { stdio: 'ignore', timeout: 5_000 });
          }
        }
        print(command.json ? JSON.stringify({ ...result, enabled }) : [
          `Meeting titles from Calendar · ${enabled ? 'on' : 'off'} · ${result.authorization}`, result.detail,
          ...(result.calendars === 0 ? ['No calendars are set up on this Mac. Add your work account in System Settings → Internet Accounts.'] : []),
        ].join('\n'));
        return result.authorization === 'authorized' && enabled ? 0 : 2;
      }
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
      const notifyOneSided = oneSidedNotifier(notify);
      const notifyMicrophone = microphoneStartNotifier(notify);
      // A new Seashell Microphone copy macOS has not decided on would ask mid-call: ask now, at a calm moment.
      if (process.env.XPC_SERVICE_NAME === SEASHELL_LAUNCH_AGENT_LABEL && !once) {
        void microphoneUpdateNotice().then((message) => { if (message) notify(message); }).catch(() => {});
      }
      const notifyScreenFilmed = screenFilmedNotifier(notify);
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      const writeEvent = command.json ? watchLogWriter(meetingWatchLogFiles(), { fallback: print }) : print;
      // A warning that stopped recurring is forgotten with how often it came back unseen.
      const warnings = new WarningRateLimit(undefined, (message, repeats) => command.json
        ? writeEvent(JSON.stringify({ type: 'watch.warning', at: new Date().toISOString(), message, repeats, final: true }))
        : process.stderr.write(`watch.warning: ${message} (repeated ${repeats} more times)\n`));
      // After a meeting is ready: extractors, then automations, one meeting at a time.
      let followUps: Promise<void> = Promise.resolve();
      const followUp = (transcriptId: string, app: string) => {
        followUps = followUps.then(async () => {
          const result = await afterMeetingReady(libraryDir, transcriptId, {
            app, route: resolveMeetingRoute(config.meeting, 'reconciliation'), signal: controller.signal,
            ...(!once ? { ask: askAutomationApprovalWithDialog } : {}),
          });
          if (command.json) print(JSON.stringify({ type: 'meeting.followed-up', at: new Date().toISOString(), transcriptId, ...result }));
          else {
            if (result.extracted.length) print(`Insights ready: ${result.extracted.join(', ')}.`);
            for (const failure of result.extractorFailures) process.stderr.write(`Extractor ${failure.extractor} failed: ${failure.message}\n`);
            for (const run of result.automations) print(`Automation ${run.automation}: ${run.status}${run.detail ? ` (${run.detail})` : ''}.`);
          }
        }).catch((error: unknown) => {
          process.stderr.write(`Meeting follow-up failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      };
      try {
        await runAutomaticMeetingWatch({
          config,
          libraryDir,
          signal: controller.signal,
          once,
          // Only the login agent replaces itself; launchd starts the new watcher.
          ...(process.env.XPC_SERVICE_NAME === SEASHELL_LAUNCH_AGENT_LABEL && !once ? {
            restartWhen: watchRestartReason({ configPath: defaultConfigPath(),
              ...(process.env.SEASHELL_PACKAGE_ROOT ? { packageRoot: process.env.SEASHELL_PACKAGE_ROOT } : {}),
              codeRoot: PROJECT_ROOT }),
          } : {}),
          // The login agent has no window of its own, so it asks with a dialog.
          // It also says, once per meeting, that a brief is ready.
          ...(!once ? { dependencies: { askToRecord: askToRecordWithDialog, notify } } : {}),
          onEvent: (event) => {
            // Like the dialog, the notice is for someone at the Mac, not a one-shot check.
            if (!once) { notifyOneSided(event); notifyMicrophone(event); notifyScreenFilmed(event); }
            // The same warning at most once per 10 minutes, with how often it recurred.
            let repeats = 0;
            if (event.type === 'watch.warning') {
              const admitted = warnings.admit(event.message, Date.parse(event.at) || Date.now());
              if (admitted === undefined) return;
              repeats = admitted;
            }
            if (event.type === 'meeting.ready') followUp(event.transcriptId, event.candidate.appName);
            if (command.json) {
              writeEvent(JSON.stringify(repeats ? { ...event, repeats } : event));
              return;
            }
            if (event.type === 'watch.ready') print('Sea Shell is watching for meetings.');
            else if (event.type === 'meeting.started') print(`Recording ${event.candidate.title}.`);
            else if (event.type === 'watch.restarting') print(`${event.reason}; restarting the meeting watcher.`);
            else if (event.type === 'meeting.resumed') print(`Resumed ${event.candidate.title} after ${event.pausedSeconds}s; it stays one meeting.`);
            else if (event.type === 'meeting.capture-finished') print(`Captured ${event.candidate.title}; finalizing in the background.`);
            else if (event.type === 'meeting.ready') print(`Meeting ready: ${event.directory}`);
            else if (event.type === 'meeting.suggested') {
              print(`Possible ${event.candidate.appName} meeting detected; run \`seashell meeting consent approve\` to record it.`);
            }
            else if (event.type === 'meeting.stopped') print(`Stopped recording ${event.candidate.title}.`);
            else if (event.type === 'brief.ready') print(`Brief ready for ${event.title}: ${event.path}`);
            else process.stderr.write(`${event.type}: ${event.message}\n`);
          },
        });
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        await followUps;
      }
      return 0;
    }
    case 'apps': {
      const apps = meetingApps();
      const { app: wanted, policy } = command.action;
      if (wanted && policy) {
        const app = apps.find((candidate) => candidate.id === wanted || candidate.name.toLocaleLowerCase() === wanted);
        if (!app) throw new Error(`Unknown app. Choose one of: ${apps.map((candidate) => candidate.id).join(', ')}`);
        updateMeetingConfig({ automation: { apps: { ...config.meeting?.automation?.apps, [app.id]: policy } } });
      }
      const saved = loadConfig().meeting?.automation;
      const mode = saved?.mode ?? DEFAULT_MEETING_AUTOMATION.mode;
      const browsers = saved?.browserWithoutCalendar ?? DEFAULT_MEETING_AUTOMATION.browserWithoutCalendar;
      const word = (value: string) => value === 'automatic' ? 'records by itself' : value === 'ask' ? 'asks first' : 'never records';
      print(command.json ? JSON.stringify({ mode, browserWithoutCalendar: browsers, apps: saved?.apps ?? {} }, null, 2) : [
        `Calls: ${word(mode)}, unless an app says otherwise. Browser calls with no calendar event: ${word(browsers)}.`,
        '',
        ...apps.map((app) => {
          const own = saved?.apps?.[app.id];
          return `  ${app.id.padEnd(10)} ${app.name.padEnd(16)} ${own ? word(own) : 'default'}`;
        }),
        '',
        'Change one: seashell meeting apps facetime off   (on, off or ask)',
      ].join('\n'));
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

async function executeMeetingVideo(
  action: MeetingVideoAction,
  json: boolean,
  libraryDir: string,
  config: ReturnType<typeof loadConfig>,
): Promise<number> {
  if (action.operation === 'open') {
    const { page, video } = openMeetingVideo(libraryDir, action.id, {
      ...(action.atSeconds === undefined ? {} : { atSeconds: action.atSeconds }),
    });
    print(json ? JSON.stringify({ page, video }, null, 2) : page);
    return 0;
  }
  if (action.operation === 'on' || action.operation === 'off') {
    const enabled = action.operation === 'on';
    if (action.app) {
      const apps = meetingApps();
      const app = apps.find((candidate) => candidate.id === action.app || candidate.name.toLocaleLowerCase() === action.app);
      if (!app) throw new Error(`Unknown app. Choose one of: ${apps.map((candidate) => candidate.id).join(', ')}`);
      updateMeetingConfig({ video: { apps: { ...config.meeting?.video?.apps, [app.id]: enabled } } });
    } else updateMeetingConfig({ video: { enabled } });
  }
  const permission = await screenCapturePermission({ request: action.operation === 'setup' });
  if (action.operation === 'setup' && permission.authorization !== 'authorized') {
    spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], { stdio: 'ignore', timeout: 5_000 });
  }
  const video = loadConfig().meeting?.video;
  const enabled = video?.enabled ?? DEFAULT_MEETING_VIDEO.enabled;
  const fps = video?.fps ?? DEFAULT_MEETING_VIDEO.fps;
  const quality = video?.quality ?? DEFAULT_MEETING_VIDEO.quality;
  const off = meetingApps().filter((app) => video?.apps?.[app.id] === false).map((app) => app.name);
  print(json ? JSON.stringify({ enabled, fps, quality, apps: video?.apps ?? {}, permission }, null, 2) : [
    `Meeting video · ${enabled ? 'on' : 'off'} · Screen Recording ${permission.authorization}`,
    enabled
      ? `Calls record their app's window at ${fps} fps, ${quality} quality${off.length ? `, except ${off.join(', ')}` : ''}.`
      : 'Calls record audio only. Turn video on with: seashell meeting video on',
    'Each meeting keeps its video in its folder, under capture/video. Sizes are in the README.',
    permission.detail,
    ...(permission.executable ? [`Permission belongs to: ${permission.executable}`] : []),
    ...(action.operation === 'setup' && permission.authorization !== 'authorized'
      ? ['Turn on Seashell Screen Capture in the window that opened, then check with: seashell meeting video --status'] : []),
  ].join('\n'));
  return action.operation === 'setup' || action.operation === 'status'
    ? permission.authorization === 'authorized' ? 0 : 2
    : 0;
}

async function executeCapture(
  command: Extract<Exclude<CliCommand, { kind: 'tui' | 'help' | 'ai-setup' }>, { kind: 'capture' }>,
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
  // A live meeting saved its calendar event beside its transcript; its invitees cap how many voices there are.
  let attendees: readonly MeetingAttendee[] | undefined;
  try { attendees = loadMeetingArtifact(libraryDir, command.action.id)?.calendar?.attendees; } catch { /* No meeting saved for it yet. */ }
  const record = await finalizeCaptureTranscript(manifestPath, {
    ...(attendees?.length ? { attendees } : {}),
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
  try { carryCaptureNotes(libraryDir, record.id); } catch { /* They stay in the bundle, where the meeting still reads them. */ }
  print(command.json ? JSON.stringify(record, null, 2) : (
    `Recovered ${record.title}\n${saved.directory}`
  ));
  return 0;
}

export async function executeCliCommand(command: Exclude<CliCommand, { kind: 'tui' | 'help' | 'ai-setup' }>): Promise<number> {
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
    case 'ai': {
      if (command.action === 'test') return executeAiTest(command.json);
      if (command.action === 'providers') {
        requireHumainNode();
        const result = await discoverHumainProviders();
        print(command.json ? JSON.stringify(result, null, 2) : result.integrations.map((provider) =>
          `${provider.ready ? '✓' : '○'} ${provider.id}: ${provider.detail}${provider.nextStep ? `\n  ${provider.nextStep}` : ''}`
        ).join('\n'));
        return 0;
      }
      if (command.action === 'install') {
        const installed = await installHumainPackage(command.tarball);
        print(command.json ? JSON.stringify(installed, null, 2) :
          `Humain ${installed.version} installed.
Discover available providers: seashell ai providers
Choose your provider and model: seashell ai setup
Backends: local-openai, codex, claude-code, openrouter`);
        return 0;
      }
      try {
        const executable = resolveHumainExecutable();
        const node = requireHumainNode();
        print(command.json ? JSON.stringify({ ready: true, executable, node: node.version }, null, 2) :
          `Humain engine found: ${executable.prefix[0] ?? executable.command}
Node ${node.version}. Provider/model readiness is separate; run seashell ai providers.`);
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        print(command.json ? JSON.stringify({ ready: false, help: message }, null, 2) : message);
        return 1;
      }
    }
    case 'doctor':
      return executeDoctor(command.json);
    case 'mcp': {
      if (command.action === 'serve') {
        const config = loadConfig();
        // Extractors and briefs run on the final-notes route, drafts on chat's, as configured at the time of the call.
        await runMeetingsMcpServer(resolveLibraryDir(undefined, process.env, config), PACKAGE_VERSION, process.stdin, process.stdout,
          { route: () => resolveMeetingRoute(loadConfig().meeting, 'reconciliation'), chatRoute: () => resolveMeetingRoute(loadConfig().meeting, 'chat') });
        return 0;
      }
      const result = installMeetingsMcp();
      print(command.json ? JSON.stringify(result, null, 2) : [
        `Seashell meetings server: ${result.command.join(' ')}`,
        ...result.clients.map((client) => `  ${client.status === 'installed' || client.status === 'already-installed' ? '✓' : client.status === 'not-found' ? '–' : '✗'} ${client.client}: ${client.detail}`),
        ...result.skills.map((path) => `  ✓ skill: ${path}`),
        'Ask Claude Code things like "what did we decide in my last call?" or "draft a follow-up from today\'s meeting".',
      ].join('\n'));
      return result.clients.some((client) => client.status === 'failed') ? 1 : 0;
    }
    case 'templates': {
      const config = loadConfig();
      const libraryDir = resolveLibraryDir(undefined, process.env, config);
      const directory = ensureTemplatesDirectory(libraryDir);
      const templates = loadMeetingTemplates(libraryDir);
      const profile = loadProfile(libraryDir);
      print(command.json ? JSON.stringify({
        directory,
        profile: profile ? 'set' : 'empty',
        templates: templates.map((template) => ({ name: template.name, match: template.match, default: template.default, path: template.path })),
      }, null, 2) : [
        `Notes templates: ${directory}`,
        ...templates.map((template) => `  ${template.name}${template.default ? ' (default)' : ''}${template.match.length ? ` — ${template.match.join(', ')}` : ''}`),
        `  About me: ${profile ? 'set' : `empty — write who you are and how you like notes in "${PROFILE_FILE}"`}`,
        'Each ## heading is a section of the notes; the text under it tells the AI what goes there.',
        'Templates are picked from the meeting title. Choose one for a meeting: seashell meeting template <id> <name>',
      ].join('\n'));
      return 0;
    }
    case 'record': {
      const libraryDir = resolveLibraryDir(undefined, process.env, loadConfig());
      const recorder = recorderAnswering(readBackgroundWatchStatus(libraryDir));
      if (command.video && recorder.running && recorder.phase !== 'recording') {
        const permission = await screenCapturePermission();
        if (permission.authorization !== 'authorized') process.stderr.write(`No video yet: ${permission.detail}\n`);
      }
      const answer = await requestRecorder(command.command, {
        libraryDir,
        send: (sent, sessionId) => {
          if (command.video) { startRecordingWithVideo(command.video); return; }
          // A request left by an unanswered --video must not film this recording.
          if (sent === 'start') clearVideoRequest();
          writeMeetingCommand(sent, undefined, Date.now(), sessionId ? { sessionId } : {});
        },
        onWaiting: (sent) => { if (sent === 'stop' && !command.json) process.stdout.write('Stopping…'); },
      });
      if (answer.kind === 'not-running') {
        throw new Error('The background recorder is not running. Start it in Settings (press , in Seashell) and try again.');
      }
      const title = 'title' in answer && answer.title ? ` ${answer.title}` : '';
      if (command.json) {
        print(JSON.stringify(answer.kind === 'nothing-recording' ? { recording: false }
          : answer.kind === 'already-recording' ? { recording: true, title: answer.title }
          : { recording: answer.recording, title: answer.title, ...(answer.kind === 'busy' ? { pending: true } : {}) }));
      } else {
        print(answer.kind === 'nothing-recording' ? 'Nothing is recording.'
          : answer.kind === 'already-recording' ? `Already recording${title}.${command.video ? ' Video can only start with a new recording.' : ''}`
          : command.command === 'stop' ? answer.kind === 'done' ? ' stopped. The transcript and notes are being written.'
            : ' The recorder is busy; it will stop as soon as it can.'
          : answer.kind === 'done' ? `Recording${title}${command.video ? ' with video' : ''}. Stop with: seashell record stop`
          : 'The recorder is busy and has not started recording yet. Check seashell status in a moment.');
      }
      // A stop the recorder has not read yet is still kept: it stops as soon as the recorder can.
      return answer.kind === 'busy' && command.command === 'start' ? 1 : 0;
    }
    case 'speaker-compare': {
      const config = loadConfig();
      const libraryDir = resolveLibraryDir(undefined, process.env, config);
      const status = (message: string) => { if (!command.json) process.stderr.write(`${message}\n`); };
      const prepared = await setupDiarization({ login: false, check: false, engine: 'nemotron3', onStatus: status });
      if (!prepared.ready) throw new Error(prepared.nextStep ?? prepared.detail);
      const report = await compareSavedSpeakers(libraryDir, { ids: command.ids, last: command.last, onStatus: status });
      if (command.open && report.page) Bun.spawn(['open', report.page], { stdio: ['ignore', 'ignore', 'ignore'] });
      print(command.json ? JSON.stringify(report, null, 2) : renderSpeakerComparison(report));
      return 0;
    }
    case 'speaker-voices': {
      if (command.forget !== undefined) {
        const result = forgetPersonVoice(resolveLibraryDir(undefined, process.env, loadConfig()), command.forget);
        if (!result.forgotten) throw new Error(`Sea Shell doesn't know a voice called "${command.forget}". See: seashell speakers voices`);
        print(command.json ? JSON.stringify({ forgotten: command.forget, suggestionsUndone: result.suggestionsUndone })
          : `Forgot ${command.forget}'s voice. Names you gave keep it; ${result.suggestionsUndone === 1 ? '1 name Seashell suggested goes' : `${result.suggestionsUndone} names Seashell suggested go`} back to a number.`);
        return 0;
      }
      const people = listVoiceprints();
      print(command.json ? JSON.stringify(people, null, 2) : people.length === 0
        ? 'Sea Shell knows nobody by voice yet. Name a remote speaker in a meeting and it learns their voice, on this Mac only.'
        : [...people.map((person) => `  ${person.name} · from ${person.meetings} meeting${person.meetings === 1 ? '' : 's'}`),
          '', 'Voiceprints stay on this Mac. Forget one: seashell speakers voices forget <name>'].join('\n'));
      return 0;
    }
    case 'speaker-use': {
      const result = await setupDiarization({ login: false, check: false, engine: command.engine, onStatus: (message) => { if (!command.json) process.stderr.write(`${message}\n`); } });
      if (!result.ready) throw new Error(result.nextStep ?? result.detail);
      updateSpeakerEngine(command.engine);
      print(command.json ? JSON.stringify({ engine: command.engine, model: result.model }) : [
        `New meetings will separate voices with ${result.model}.`,
        'Past meetings keep their speakers. To redo one: seashell library speakers <id> identify',
      ].join('\n'));
      return 0;
    }
    case 'status': {
      const config = loadConfig();
      const statuses = await readFeatureStatuses({ config, libraryDir: resolveLibraryDir(undefined, process.env, config) });
      print(command.json ? JSON.stringify(statuses, null, 2) : renderFeatureStatusTable(statuses));
      return statuses.some((status) => !status.optional && status.state === 'broken') ? 2 : 0;
    }
    case 'speaker-setup': {
      const result = await setupDiarization(command);
      print(command.json ? JSON.stringify(result, null, 2) : [
        result.detail,
        ...(!result.ready ? [
          'Speaker identification is optional. Recording and transcription still work.',
          ...(result.loginCommand ? [
            ...(result.modelUrl ? [`1. Accept model access: ${result.modelUrl}`] : []),
            `2. Sign in locally: ${result.loginCommand}`,
            `3. ${result.nextStep}`,
          ] : result.nextStep ? [result.nextStep] : []),
        ] : []),
      ].join('\n'));
      return result.ready ? 0 : 1;
    }
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
    case 'prompts':
    case 'extractors':
    case 'extract':
    case 'automations':
    case 'query':
    case 'note':
    case 'brief':
    case 'draft':
    case 'vocabulary':
      return executeMeetingIntelligence(command);
  }
}

const ROLE_NAMES: Record<MeetingAiRole, string> = { observer: 'Live analysis', reconciliation: 'Final notes', chat: 'Meeting chat' };

/** One tiny fixed prompt through each route in use; no meeting text is sent. */
async function executeAiTest(json: boolean): Promise<number> {
  const config = loadConfig();
  const routes = Object.fromEntries((['observer', 'reconciliation', 'chat'] as const)
    .map((role) => [role, resolveMeetingRoute(config.meeting, role)]));
  if (!json) process.stderr.write('Sending a short test message through each meeting AI route…\n');
  const result = await testMeetingAi(routes, { mode: config.meeting?.mode ?? 'hybrid' });
  if (json) {
    print(JSON.stringify(result, null, 2));
  } else if (!result.routes.length) {
    print('No meeting AI is set up yet. Choose a provider: seashell ai setup');
  } else {
    print(['Meeting AI connection', ...result.routes.map((route) => {
      const roles = route.roles.map((role) => ROLE_NAMES[role]).join(', ');
      return route.ok
        ? `  ✓ ${roles} · ${route.backend} ${route.model}${route.latencyMs === undefined ? '' : ` · answered in ${(route.latencyMs / 1000).toFixed(1)} s`}`
        : `  ✗ ${roles} · ${route.backend} ${route.model}\n    ${route.reason}`;
    })].join('\n'));
  }
  return result.ok ? 0 : 1;
}

/** Prompts, extractors, automations and cross-meeting queries. */
async function executeMeetingIntelligence(command: MeetingIntelligenceCommand): Promise<number> {
  const config = loadConfig();
  const libraryDir = resolveLibraryDir(undefined, process.env, config);
  const status = (message: string) => { if (!command.json) process.stderr.write(`${message}\n`); };
  switch (command.kind) {
    case 'prompts': {
      if (command.action === 'reset') {
        const path = resetPrompt(libraryDir, command.name);
        print(command.json ? JSON.stringify({ path }, null, 2) : `Put back the original ${command.name} prompt: ${path}`);
        return 0;
      }
      const directory = ensurePromptsDirectory(libraryDir);
      const prompts = listPrompts(libraryDir);
      print(command.json ? JSON.stringify({ directory, prompts: prompts.map(({ text: _text, ...prompt }) => prompt) }, null, 2) : [
        `Meeting AI prompts: ${directory}`,
        ...prompts.map((prompt) => `  ${prompt.name.padEnd(6)} ${prompt.title.padEnd(14)} ${prompt.state === 'empty' ? 'empty, sends nothing' : prompt.state}  ${prompt.path}`),
        'Each file is sent to its role after "About me". Comments in a file are never sent.',
        'What the notes must cover and how they cite the transcript stay fixed. Put one back: seashell prompts reset notes',
      ].join('\n'));
      return 0;
    }
    case 'extractors': {
      const directory = ensureExtractorsDirectory(libraryDir);
      const { extractors, problems } = loadExtractors(libraryDir);
      const when = (extractor: (typeof extractors)[number]) => extractor.when.kind === 'always' ? 'after every meeting'
        : extractor.when.kind === 'manual' ? 'by hand only'
        : `when ${[...extractor.when.title, ...extractor.when.attendee, ...extractor.when.app].join(', ')} match`;
      print(command.json ? JSON.stringify({ directory, extractors, problems }, null, 2) : [
        `Extractors: ${directory}`,
        ...extractors.map((extractor) => `  ${extractor.name} — ${when(extractor)} · ${extractor.fields.map((field) => field.name).join(', ')}`),
        ...problems.map((problem) => `  ✗ ${problem.path}: ${problem.message}`),
        'Run one: seashell extract <meeting-id> <name>. Results show under Insights in the meeting\'s notes.',
      ].join('\n'));
      return problems.length ? 1 : 0;
    }
    case 'extract': {
      const route = resolveMeetingRoute(config.meeting, 'reconciliation');
      if (!route) throw new Error('Meeting AI is not set up for final notes. Choose a provider: seashell ai setup');
      const insight = await runExtractor(libraryDir, command.id, command.extractor, { route, onStatus: status });
      print(command.json ? JSON.stringify(insight, null, 2) : [
        insight.extractor,
        ...(insight.summary ? [insight.summary] : []),
        ...insight.fields.flatMap((field) => [`${field.name}:`, ...(field.items.length
          ? field.items.map((item) => `  - ${item.text} (${item.evidenceSegmentIds.join(', ')})`) : ['  - Not covered.'])]),
      ].join('\n'));
      return 0;
    }
    case 'automations': {
      if (command.action === 'run') {
        const runs = await runAutomations(libraryDir, command.id, {
          trigger: 'manual', ...(command.name ? { only: command.name } : {}),
          ask: askAutomationApprovalWithDialog, route: resolveMeetingRoute(config.meeting, 'reconciliation'), onStatus: status,
        });
        print(command.json ? JSON.stringify(runs, null, 2) : runs.length ? runs.map((run) => [
          `${run.automation}: ${run.status}${run.detail ? ` (${run.detail})` : ''}`,
          ...run.actions.map((action) => `  ${action.status === 'ok' ? '✓' : action.status === 'skipped' ? '○' : '✗'} ${action.kind} ${action.target}${action.detail ? ` — ${action.detail}` : ''}`),
        ].join('\n')).join('\n') : 'No automation fits this meeting.');
        return runs.some((run) => run.status === 'failed') ? 1 : 0;
      }
      const directory = ensureAutomationsDirectory(libraryDir);
      const { automations, problems } = loadAutomations(libraryDir);
      const runs = readAutomationRuns(libraryDir);
      print(command.json ? JSON.stringify({ directory, automations: automations.map((automation) => ({ ...automation,
        approval: automationDecision(automation) ?? null, lastRun: runs.filter((run) => run.automation === automation.name).at(-1) ?? null })),
      problems }, null, 2) : [
        `Automations: ${directory}`,
        ...automations.map((automation) => {
          const last = runs.filter((run) => run.automation === automation.name).at(-1);
          const outward = automationNeedsApproval(automation, libraryDir);
          const decision = automationDecision(automation);
          return `  ${automation.name} — ${automation.enabled ? 'on' : automation.by === 'agent' ? 'off: made by an agent; turn on in the file' : 'off'} · ${automation.actions.map((action) => action.kind).join(', ')}` +
            `${outward ? ` · ${decision === 'allow' ? 'allowed to send' : decision === 'deny' ? 'not allowed to send' : 'asks before sending'}` : ''}` +
            `${last ? ` · last run ${last.status} ${last.at.slice(0, 10)}` : ''}`;
        }),
        ...problems.map((problem) => `  ✗ ${problem.path}: ${problem.message}`),
        ...(automations.some((automation) => automationNeedsApproval(automation, libraryDir)) ? [automationApprovalNote()].flatMap((note) => note ?? []) : []),
        `Runs are logged in ${join(libraryDir, 'automation-runs.jsonl')}. Run them for one meeting: seashell automations run <meeting-id>`,
      ].join('\n'));
      return problems.length ? 1 : 0;
    }
    case 'vocabulary': {
      const path = ensureVocabularyFile(libraryDir);
      const vocabulary = loadVocabulary(libraryDir);
      print(command.json ? JSON.stringify(vocabulary, null, 2) : [
        `Vocabulary: ${path}`,
        vocabulary.terms.length ? `  ${vocabulary.terms.join(', ')}` : '  No words yet. Add one per line: names, companies, jargon.',
        ...vocabulary.problems.map((problem) => `  ! ${problem}`),
        'Transcription and the meeting AI spell these as written. Lines starting with # are notes to you.',
      ].join('\n'));
      return 0;
    }
    case 'note': {
      if (command.meeting) {
        const note = addMeetingNote(libraryDir, command.meeting, command.text, command.atSeconds === undefined ? {} : { at: command.atSeconds });
        const { record } = findTranscriptRecord(libraryDir, command.meeting);
        print(command.json ? JSON.stringify(note, null, 2)
          : `Added a note to ${record.title}${note.at === undefined ? '' : ` at ${sentenceClock(note.at)}`}. It is used the next time its notes are written.`);
        return 0;
      }
      // A busy recorder still takes notes; only one that is not recording refuses them.
      const recorder = recorderAnswering(readBackgroundWatchStatus(libraryDir));
      const watch = recorder.running && recorder.phase === 'recording' ? recorder.status : undefined;
      if (!watch?.sessionId) {
        throw new Error('Nothing is recording. To add a note to a meeting: seashell note "<text>" --meeting <id>');
      }
      const typedAt = Date.now();
      const path = writeNoteCommand(command.text, typedAt);
      // The recorder picks notes up on its next check, every few seconds.
      const deadline = Date.now() + 12_000;
      while (existsSync(path) && Date.now() < deadline) await Bun.sleep(250);
      const bundle = recordingBundle(libraryDir, watch.sessionId);
      const at = bundle ? noteAtMoment(bundle, typedAt) : undefined;
      const taken = !existsSync(path);
      print(command.json ? JSON.stringify({ kept: taken, ...(at === undefined ? {} : { at }) })
        : taken ? `Noted${at === undefined ? '' : ` at ${sentenceClock(at)}`}${watch.candidate?.title ? ` in ${watch.candidate.title}` : ''}.`
        : 'The recorder has not picked the note up yet. It keeps it for 10 minutes; check seashell status.');
      return taken ? 0 : 1;
    }
    case 'brief': {
      const route = resolveMeetingRoute(config.meeting, 'reconciliation');
      if (!route) throw new Error('Meeting AI is not set up, so there is no one to write the brief. Choose a provider: seashell ai setup');
      const upcoming = await briefTarget(libraryDir, config, command.target);
      const brief = findBrief(libraryDir, upcoming) ?? await makeBrief(libraryDir, upcoming, { route, onStatus: status });
      print(command.json ? JSON.stringify(brief, null, 2) : `${readFileSync(brief.path, 'utf8').replace(/^---[\s\S]*?---\n/u, '').trim()}\n\nSaved: ${brief.path}`);
      return 0;
    }
    case 'draft': {
      const route = resolveMeetingRoute(config.meeting, 'chat');
      if (!route) throw new Error('Meeting AI is not set up for chat. Choose a provider: seashell ai setup');
      const draft = await draftFollowUp(libraryDir, command.id, command.slack ? 'slack' : 'email', route,
        { ...(command.ask ? { ask: command.ask } : {}), onStatus: status });
      print(command.json ? JSON.stringify(draft, null, 2) : draftText(draft));
      if (!command.json) process.stderr.write('Nothing was sent.\n');
      return 0;
    }
    case 'query': {
      const result = queryNotes(libraryDir, {
        ...(command.noteKind ? { kind: command.noteKind } : {}),
        ...(command.person ? { person: command.person } : {}), ...(command.about ? { about: command.about } : {}),
        ...(command.meeting ? { meeting: command.meeting } : {}), ...(command.since ? { since: command.since } : {}),
        ...(command.until ? { until: command.until } : {}), ...(command.limit ? { limit: command.limit } : {}),
      });
      if (command.json) { print(JSON.stringify(result, null, 2)); return 0; }
      if (!result.items.length) { print('Nothing matches in the meeting notes.'); return 0; }
      const kinds: Record<string, string> = { decision: 'Decision', action_item: 'Action', risk: 'Risk', open_question: 'Question', follow_up: 'Follow-up' };
      const lines: string[] = [];
      let meeting = '';
      for (const item of result.items) {
        if (item.meetingId !== meeting) {
          meeting = item.meetingId;
          lines.push(`${lines.length ? '\n' : ''}${item.startedAt.slice(0, 10)}  ${item.title} (${item.meetingId})`);
        }
        const owner = item.type === 'action_item' || item.type === 'follow_up' ? claimOwnerAndDue(item) : undefined;
        lines.push(`  ${(kinds[item.type] ?? item.type).padEnd(9)} ${item.text}${owner ? ` (${owner})` : ''}  [${item.evidence[0] ?? ''}]`);
      }
      if (result.truncated) lines.push('', 'More match; narrow it with --since, --person or --about, or raise --limit.');
      print(lines.join('\n'));
      return 0;
    }
  }
}

/**
 * The meeting a brief is for: the next on the calendar, or the next whose title
 * has these words. Without a calendar event, a title still finds its past
 * meetings, as a series does.
 */
async function briefTarget(libraryDir: string, config: SeashellConfig, target: 'next' | { title: string }): Promise<UpcomingMeeting> {
  const calendar = config.meeting?.calendar;
  const events = calendar?.enabled && (calendar.policy ?? 'ask') !== 'off'
    ? await readMacCalendarEventsAsync({ leadMinutes: 7 * 24 * 60, lookbackMinutes: 0 }) : [];
  if (target === 'next') {
    if (!calendar?.enabled) throw new Error('Briefs for the next meeting come from your calendar. Turn on calendar titles: seashell meeting calendar setup');
    const next = nextCalendarMeeting(events);
    if (!next) throw new Error('Nothing on your calendar in the next week.');
    return upcomingFromEvent(next);
  }
  const words = target.title.toLocaleLowerCase('en-US').split(/\s+/u);
  const has = (title: string) => words.every((word) => title.toLocaleLowerCase('en-US').includes(word));
  const event = events.filter((candidate) => has(candidate.title)).toSorted((left, right) => left.startAt.localeCompare(right.startAt))[0];
  if (event) return upcomingFromEvent(event);
  // Not on the calendar: the newest past meeting with those words names the series.
  const past = listTranscriptRecords(libraryDir).find((entry) => has(entry.title));
  return { title: past?.title ?? target.title, startsAt: new Date().toISOString(), attendees: [] };
}

/** A notification that needs no answer. The text is an argument, never part of the script. */
function notify(message: string): void {
  Bun.spawn(['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Seashell"', '-e', 'end run', message],
    { stdout: 'ignore', stderr: 'ignore' }).unref();
}

/** A real question, with the call's name, that waits about as long as the answer is useful. */
async function askToRecordWithDialog(candidate: MeetingCandidate, signal: AbortSignal): Promise<'approve' | 'decline' | undefined> {
  const where = candidate.kind === 'browser' ? `a call in ${candidate.appName}` : candidate.appName;
  const question = candidate.calendar ? `Seashell heard ${where} during “${candidate.title}”. Record it?`
    : `Seashell heard ${where}. Record it?`;
  const child = Bun.spawn(['osascript',
    '-e', 'on run argv',
    '-e', 'set answer to display dialog (item 1 of argv) with title "Seashell" buttons {"Don’t record", "Record"} default button "Record" giving up after 100 with icon note',
    '-e', 'if gave up of answer then return ""',
    '-e', 'return button returned of answer',
    '-e', 'end run', question], { stdout: 'pipe', stderr: 'ignore' });
  const stop = () => child.kill();
  signal.addEventListener('abort', stop, { once: true });
  try {
    const answer = (await new Response(child.stdout).text()).trim();
    await child.exited;
    return answer === 'Record' ? 'approve' : answer ? 'decline' : undefined;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

