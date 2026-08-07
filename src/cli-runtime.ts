import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type {
  CliCommand,
  LibraryCommand,
  TranscribeCommandOptions,
} from './cli-args.ts';
import { loadConfig, resolveLibraryDir, resolveSaveByDefault } from './config.ts';
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
import { transcribeMedia } from './transcription-service.ts';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(__filename), '..');

function print(value: string): void {
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
}

function writeOutputAtomic(path: string, contents: string): void {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const temporary = join(
    dirname(absolutePath),
    `.${absolutePath.split('/').at(-1)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' });
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

async function executeTranscription(
  files: string[],
  options: TranscribeCommandOptions,
): Promise<number> {
  const config = loadConfig();
  const libraryDir = resolveLibraryDir(options.libraryDir, process.env, config);
  const shouldSave = options.save ?? resolveSaveByDefault(config);
  const rendered: string[] = [];

  for (const file of files) {
    const progress = progressCallbacks(options);
    try {
      const record = await transcribeMedia(file, {
        ...options,
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
      join(PROJECT_ROOT, 'models/ggml-large-v3-turbo-q5_0.bin'),
      true,
      'Run ./install.sh',
    ),
    fileCheck(
      'diarization-python',
      join(PROJECT_ROOT, '.venv-diarization/bin/python'),
      false,
      'See README speaker diarization setup',
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

export async function executeCliCommand(command: Exclude<CliCommand, { kind: 'tui' | 'help' }>): Promise<number> {
  switch (command.kind) {
    case 'transcribe':
      return executeTranscription(command.files, command.options);
    case 'library':
      return executeLibrary(command);
    case 'doctor':
      return executeDoctor(command.json);
  }
}
