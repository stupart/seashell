import type { DiarizeFileOptions } from './diarize.ts';
import type { TranscriptFormat } from './transcript-types.ts';

export interface TranscribeCommandOptions extends DiarizeFileOptions {
  format: TranscriptFormat;
  timestamps: boolean;
  speakers: boolean;
  output?: string;
  save?: boolean;
  libraryDir?: string;
  title?: string;
  quiet: boolean;
}

export type LibraryAction =
  | { kind: 'list' }
  | { kind: 'show'; id: string }
  | { kind: 'search'; query: string }
  | { kind: 'export'; id: string }
  | { kind: 'speakers-set'; id: string; speakerId: string; label: string }
  | { kind: 'open'; id?: string }
  | { kind: 'trash'; id: string; confirmed: boolean };

export interface LibraryCommand {
  kind: 'library';
  action: LibraryAction;
  json: boolean;
  format: TranscriptFormat;
  output?: string;
  timestamps: boolean;
  speakers: boolean;
  libraryDir?: string;
}

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'tui'; libraryDir?: string }
  | { kind: 'doctor'; json: boolean }
  | { kind: 'transcribe'; files: string[]; options: TranscribeCommandOptions }
  | LibraryCommand;

const FORMATS = new Set<TranscriptFormat>(['text', 'json', 'srt', 'vtt']);

function positiveInteger(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return value;
}

function formatValue(raw: string): TranscriptFormat {
  if (!FORMATS.has(raw as TranscriptFormat)) {
    throw new Error(`--format must be one of: ${[...FORMATS].join(', ')}`);
  }
  return raw as TranscriptFormat;
}

function takeValue(args: string[], index: number, flag: string): [string, number] {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return [value, index + 1];
}

function parseTranscribe(rawArgs: string[], explicitCommand: boolean): CliCommand {
  const args = explicitCommand ? rawArgs.slice(1) : rawArgs;
  const files: string[] = [];
  const options: TranscribeCommandOptions = {
    format: 'text',
    timestamps: false,
    speakers: false,
    quiet: false,
  };
  let formatWasExplicit = false;
  let legacyDiarize = false;
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (positionalOnly) {
      files.push(arg);
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      continue;
    }

    const next = () => {
      const [value, consumedIndex] = takeValue(args, index, arg);
      index = consumedIndex;
      return value;
    };

    switch (arg) {
      case '--timestamps':
        options.timestamps = true;
        break;
      case '--speakers':
        options.speakers = true;
        break;
      case '--diarize':
        options.speakers = true;
        legacyDiarize = true;
        break;
      case '--format':
        options.format = formatValue(next());
        formatWasExplicit = true;
        break;
      case '--output':
        options.output = next();
        break;
      case '--save':
        options.save = true;
        break;
      case '--no-save':
        options.save = false;
        break;
      case '--library-dir':
        options.libraryDir = next();
        break;
      case '--title':
        options.title = next();
        break;
      case '--audio-stream':
        options.audioStreamIndex = nonNegativeInteger(arg, next());
        break;
      case '--channel-roles':
        options.channelRoles = next().split(',').map((role) => role.trim());
        options.speakers = true;
        break;
      case '--num-speakers':
        options.numSpeakers = positiveInteger(arg, next());
        options.speakers = true;
        break;
      case '--min-speakers':
        options.minSpeakers = positiveInteger(arg, next());
        options.speakers = true;
        break;
      case '--max-speakers':
        options.maxSpeakers = positiveInteger(arg, next());
        options.speakers = true;
        break;
      case '--diarization-model':
        options.model = next();
        options.speakers = true;
        break;
      case '--python':
        options.pythonPath = next();
        options.speakers = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown transcription option: ${arg}`);
        files.push(arg);
    }
  }

  if (legacyDiarize && !formatWasExplicit) options.format = 'json';
  if (files.length === 0) throw new Error('Transcription requires at least one input file');
  if (files.length > 1 && options.format !== 'text') {
    throw new Error('JSON and subtitle formats require exactly one input file');
  }
  if (files.length > 1 && options.output) {
    throw new Error('--output requires exactly one input file');
  }
  if (
    options.numSpeakers !== undefined &&
    (options.minSpeakers !== undefined || options.maxSpeakers !== undefined)
  ) {
    throw new Error('--num-speakers cannot be combined with speaker bounds');
  }
  if (
    options.minSpeakers !== undefined &&
    options.maxSpeakers !== undefined &&
    options.minSpeakers > options.maxSpeakers
  ) {
    throw new Error('--min-speakers cannot exceed --max-speakers');
  }

  return { kind: 'transcribe', files, options };
}

function parseLibrary(args: string[]): LibraryCommand {
  const actionName = args[1] ?? 'list';
  const positional: string[] = [];
  let json = false;
  let format: TranscriptFormat = 'text';
  let output: string | undefined;
  let timestamps = false;
  let speakers = false;
  let libraryDir: string | undefined;
  let confirmed = false;

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = () => {
      const [value, consumedIndex] = takeValue(args, index, arg);
      index = consumedIndex;
      return value;
    };
    switch (arg) {
      case '--json': json = true; break;
      case '--format': format = formatValue(next()); break;
      case '--output': output = next(); break;
      case '--timestamps': timestamps = true; break;
      case '--speakers': speakers = true; break;
      case '--library-dir': libraryDir = next(); break;
      case '--confirm': confirmed = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown library option: ${arg}`);
        positional.push(arg);
    }
  }

  let action: LibraryAction;
  switch (actionName) {
    case 'list':
      action = { kind: 'list' };
      break;
    case 'show':
      if (!positional[0]) throw new Error('library show requires a transcript ID');
      action = { kind: 'show', id: positional[0] };
      break;
    case 'search':
      if (positional.length === 0) throw new Error('library search requires a query');
      action = { kind: 'search', query: positional.join(' ') };
      break;
    case 'export':
      if (!positional[0]) throw new Error('library export requires a transcript ID');
      action = { kind: 'export', id: positional[0] };
      break;
    case 'speakers':
      if (positional[1] !== 'set' || !positional[0] || !positional[2] || !positional[3]) {
        throw new Error('Usage: seashell library speakers <id> set <speaker-id> <name>');
      }
      action = {
        kind: 'speakers-set',
        id: positional[0],
        speakerId: positional[2],
        label: positional.slice(3).join(' '),
      };
      break;
    case 'open':
      action = { kind: 'open', ...(positional[0] ? { id: positional[0] } : {}) };
      break;
    case 'trash':
      if (!positional[0]) throw new Error('library trash requires a transcript ID');
      action = { kind: 'trash', id: positional[0], confirmed };
      break;
    default:
      throw new Error(`Unknown library action: ${actionName}`);
  }

  return {
    kind: 'library',
    action,
    json,
    format: action.kind === 'show' && json ? 'json' : format,
    ...(output ? { output } : {}),
    timestamps,
    speakers,
    ...(libraryDir ? { libraryDir } : {}),
  };
}

export function parseCliArgs(args: string[]): CliCommand {
  if (args.length === 0) return { kind: 'tui' };
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    return { kind: 'help' };
  }
  if (args[0] === 'tui') {
    if (args.length === 1) return { kind: 'tui' };
    if (args[1] === '--library-dir' && args[2] && args.length === 3) {
      return { kind: 'tui', libraryDir: args[2] };
    }
    throw new Error('Usage: seashell tui [--library-dir <path>]');
  }
  if (args[0] === 'doctor') {
    const unknown = args.slice(1).filter((arg) => arg !== '--json');
    if (unknown.length) throw new Error(`Unknown doctor option: ${unknown[0]}`);
    return { kind: 'doctor', json: args.includes('--json') };
  }
  if (args[0] === 'library') return parseLibrary(args);
  return parseTranscribe(args, args[0] === 'transcribe');
}

export const CLI_HELP = `Sea Shell — local-first media transcription

Usage:
  seashell                                  Open the live + transcript library TUI
  seashell <file> ...                       Backward-compatible plain-text transcription
  seashell transcribe <file> [options]      Transcribe audio or video
  seashell library <action> [options]       Browse and manage saved transcripts
  seashell doctor [--json]                  Check dependencies and models

Transcription options:
  --timestamps                 Include aligned timestamps in text output
  --speakers                   Run local speaker diarization and include speaker labels
  --format text|json|srt|vtt   Output format (default: text)
  --output <path>              Write the selected rendering to a file
  --save / --no-save           Override transcript-library persistence
  --library-dir <path>         Override the transcript library directory
  --audio-stream <index>       Select an ffprobe audio stream index
  --title <title>              Override the saved transcript title
  --quiet                      Suppress progress on stderr

Speaker options:
  --channel-roles <roles>      Comma-separated channel roles, e.g. local,remote
  --num-speakers <n>           Exact speaker count
  --min-speakers <n>           Minimum speaker count
  --max-speakers <n>           Maximum speaker count
  --diarization-model <id>     Override the pyannote model
  --python <path>              Override the diarization Python executable
  --diarize                    Legacy alias for --speakers --format json

Library actions:
  library list [--json]
  library show <id> [--format text|json|srt|vtt] [--timestamps] [--speakers]
  library search <query> [--json]
  library export <id> --format text|json|srt|vtt [--output <path>]
  library speakers <id> set <speaker-id> <name> [--json]
  library open [id]
  library trash <id> --confirm

Configuration precedence:
  CLI flag > SEASHELL_LIBRARY_DIR > config.json > ~/Documents/Sea Shell/Transcripts

Machine use:
  stdout contains results only; progress and errors use stderr. Library and doctor
  commands support JSON. Non-interactive commands never prompt.
`;
