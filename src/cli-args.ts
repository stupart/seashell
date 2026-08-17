import type { DiarizeFileOptions } from './diarize.ts';
import type { TranscriptFormat } from './transcript-types.ts';
import type { HumainBackend } from './humain-client.ts';
import type { MeetingEnrichmentMode } from './meeting-artifact.ts';
import type { MeetingCapturePolicy } from './calendar.ts';
import type {
  BrowserMeetingPolicy,
  MeetingAutomationMode,
} from './meeting-automation.ts';

export interface TranscribeCommandOptions extends DiarizeFileOptions {
  format: TranscriptFormat;
  timestamps: boolean;
  speakers: boolean;
  output?: string;
  save?: boolean;
  libraryDir?: string;
  title?: string;
  speakerEvidencePath?: string;
  quiet: boolean;
}

export type MeetingCommand = {
  kind: 'meeting';
  action:
    | { kind: 'create'; id: string; eventJsonPath?: string; mode?: MeetingEnrichmentMode }
    | {
        kind: 'enrich';
        id: string;
        mode?: MeetingEnrichmentMode;
        backend?: HumainBackend;
        model?: string;
        contextPath?: string;
      }
    | {
        kind: 'chat';
        id: string;
        question: string;
        backend?: HumainBackend;
        model?: string;
      }
    | { kind: 'show'; id: string }
    | {
        kind: 'setup';
        mode?: MeetingEnrichmentMode;
        backend?: HumainBackend;
        model?: string;
        routes?: {
          observer?: { backend: HumainBackend; model: string };
          reconciliation?: { backend: HumainBackend; model: string };
          chat?: { backend: HumainBackend; model: string };
        };
        calendarPolicy?: MeetingCapturePolicy;
        automationMode?: MeetingAutomationMode;
        browserWithoutCalendar?: BrowserMeetingPolicy;
        contextFiles?: string[];
      }
    | { kind: 'calendar' }
    | { kind: 'watch'; once: boolean }
    | { kind: 'consent'; decision: 'approve' | 'decline' }
    | { kind: 'autostart'; operation: 'enable' | 'disable' | 'status' };
  libraryDir?: string;
  json: boolean;
};

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

export interface CaptureCommand {
  kind: 'capture';
  action:
    | { kind: 'list' }
    | { kind: 'show'; id: string }
    | { kind: 'finalize'; id: string }
    | { kind: 'test'; seconds: number }
    | { kind: 'record'; seconds: number };
  libraryDir?: string;
  json: boolean;
}

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'tui'; libraryDir?: string }
  | { kind: 'capabilities'; json: boolean }
  | { kind: 'doctor'; json: boolean }
  | { kind: 'setup'; autostart: boolean; json: boolean }
  | { kind: 'update'; check: boolean; json: boolean }
  | { kind: 'transcribe'; files: string[]; options: TranscribeCommandOptions }
  | CaptureCommand
  | MeetingCommand
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
      case '--speaker-evidence':
        options.speakerEvidencePath = next();
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

function meetingMode(value: string): MeetingEnrichmentMode {
  if (value === 'streaming' || value === 'post-session' || value === 'hybrid') return value;
  throw new Error('--mode must be streaming, post-session, or hybrid');
}

function meetingBackend(value: string): HumainBackend {
  if (value === 'codex' || value === 'claude-code' || value === 'openrouter') return value;
  throw new Error('--backend must be codex, claude-code, or openrouter');
}

function parseMeeting(args: string[]): MeetingCommand {
  const actionName = args[1];
  if (!actionName) {
    throw new Error('Meeting command requires setup, create, enrich, show, chat, calendar, watch, consent, or autostart');
  }
  const positional: string[] = [];
  let libraryDir: string | undefined;
  let json = false;
  let eventJsonPath: string | undefined;
  let contextPath: string | undefined;
  let mode: MeetingEnrichmentMode | undefined;
  let backend: HumainBackend | undefined;
  let model: string | undefined;
  let observerBackend: HumainBackend | undefined;
  let observerModel: string | undefined;
  let reconciliationBackend: HumainBackend | undefined;
  let reconciliationModel: string | undefined;
  let chatBackend: HumainBackend | undefined;
  let chatModel: string | undefined;
  let calendarPolicy: MeetingCapturePolicy | undefined;
  let automationMode: MeetingAutomationMode | undefined;
  let browserWithoutCalendar: BrowserMeetingPolicy | undefined;
  const contextFiles: string[] = [];
  let contextFilesSpecified = false;
  let once = false;

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = () => {
      const [value, consumedIndex] = takeValue(args, index, arg);
      index = consumedIndex;
      return value;
    };
    switch (arg) {
      case '--library-dir': libraryDir = next(); break;
      case '--json': json = true; break;
      case '--event-json': eventJsonPath = next(); break;
      case '--context': contextPath = next(); break;
      case '--mode': mode = meetingMode(next()); break;
      case '--backend': backend = meetingBackend(next()); break;
      case '--model': model = next(); break;
      case '--observer-backend': observerBackend = meetingBackend(next()); break;
      case '--observer-model': observerModel = next(); break;
      case '--reconciliation-backend': reconciliationBackend = meetingBackend(next()); break;
      case '--reconciliation-model': reconciliationModel = next(); break;
      case '--chat-backend': chatBackend = meetingBackend(next()); break;
      case '--chat-model': chatModel = next(); break;
      case '--calendar': {
        const value = next();
        if (value !== 'off' && value !== 'ask' && value !== 'selected-calendars' && value !== 'all') {
          throw new Error('--calendar must be off, ask, selected-calendars, or all');
        }
        calendarPolicy = value;
        break;
      }
      case '--automation': {
        const value = next();
        if (value !== 'off' && value !== 'ask' && value !== 'automatic') {
          throw new Error('--automation must be off, ask, or automatic');
        }
        automationMode = value;
        break;
      }
      case '--browser-without-calendar': {
        const value = next();
        if (value !== 'off' && value !== 'ask' && value !== 'automatic') {
          throw new Error('--browser-without-calendar must be off, ask, or automatic');
        }
        browserWithoutCalendar = value;
        break;
      }
      case '--context-file':
        if (contextFilesSpecified && contextFiles.length === 0) {
          throw new Error('--context-file cannot be combined with --clear-context-files');
        }
        contextFilesSpecified = true;
        contextFiles.push(next());
        break;
      case '--clear-context-files':
        if (contextFilesSpecified) {
          throw new Error('--clear-context-files cannot be combined with --context-file');
        }
        contextFilesSpecified = true;
        break;
      case '--once': once = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown meeting option: ${arg}`);
        positional.push(arg);
    }
  }

  if (
    (actionName === 'enrich' || actionName === 'chat') &&
    (backend === undefined) !== (model === undefined)
  ) {
    throw new Error(`meeting ${actionName} requires --backend and --model together`);
  }

  let action: MeetingCommand['action'];
  switch (actionName) {
    case 'create':
      if (!positional[0]) throw new Error('meeting create requires a transcript ID');
      if (positional.length > 1) throw new Error('meeting create accepts one transcript ID');
      action = {
        kind: 'create',
        id: positional[0],
        ...(eventJsonPath ? { eventJsonPath } : {}),
        ...(mode ? { mode } : {}),
      };
      break;
    case 'enrich':
      if (!positional[0]) throw new Error('meeting enrich requires a transcript ID');
      if (positional.length > 1) throw new Error('meeting enrich accepts one transcript ID');
      action = {
        kind: 'enrich',
        id: positional[0],
        ...(mode ? { mode } : {}),
        ...(backend ? { backend } : {}),
        ...(model ? { model } : {}),
        ...(contextPath ? { contextPath } : {}),
      };
      break;
    case 'show':
      if (!positional[0]) throw new Error('meeting show requires a transcript ID');
      if (positional.length > 1) throw new Error('meeting show accepts one transcript ID');
      action = { kind: 'show', id: positional[0] };
      break;
    case 'setup':
      if (positional.length > 0) throw new Error('meeting setup accepts no positional arguments');
      if ((backend === undefined) !== (model === undefined)) {
        throw new Error('meeting setup requires --backend and --model together');
      }
      for (const [role, roleBackend, roleModel] of [
        ['observer', observerBackend, observerModel],
        ['reconciliation', reconciliationBackend, reconciliationModel],
        ['chat', chatBackend, chatModel],
      ] as const) {
        if ((roleBackend === undefined) !== (roleModel === undefined)) {
          throw new Error(`meeting setup requires --${role}-backend and --${role}-model together`);
        }
      }
      const routes = {
        ...(observerBackend && observerModel
          ? { observer: { backend: observerBackend, model: observerModel } }
          : {}),
        ...(reconciliationBackend && reconciliationModel
          ? { reconciliation: { backend: reconciliationBackend, model: reconciliationModel } }
          : {}),
        ...(chatBackend && chatModel
          ? { chat: { backend: chatBackend, model: chatModel } }
          : {}),
      };
      if (!backend && !model && Object.keys(routes).length === 0 && !mode && !calendarPolicy &&
          !automationMode && !browserWithoutCalendar && !contextFilesSpecified) {
        throw new Error('meeting setup requires a route, mode, or calendar policy');
      }
      action = {
        kind: 'setup',
        ...(mode ? { mode } : {}),
        ...(backend ? { backend } : {}),
        ...(model ? { model } : {}),
        ...(Object.keys(routes).length === 0 ? {} : { routes }),
        ...(calendarPolicy ? { calendarPolicy } : {}),
        ...(automationMode ? { automationMode } : {}),
        ...(browserWithoutCalendar ? { browserWithoutCalendar } : {}),
        ...(contextFilesSpecified ? { contextFiles } : {}),
      };
      break;
    case 'chat':
      if (!positional[0] || positional.length < 2) {
        throw new Error('meeting chat requires a transcript ID and question');
      }
      action = {
        kind: 'chat',
        id: positional[0],
        question: positional.slice(1).join(' '),
        ...(backend ? { backend } : {}),
        ...(model ? { model } : {}),
      };
      break;
    case 'calendar':
      if (positional.length > 0) throw new Error('meeting calendar accepts no positional arguments');
      action = { kind: 'calendar' };
      break;
    case 'watch':
      if (positional.length > 0) throw new Error('meeting watch accepts no positional arguments');
      action = { kind: 'watch', once };
      break;
    case 'consent': {
      const decision = positional[0];
      if (decision !== 'approve' && decision !== 'decline') {
        throw new Error('meeting consent requires approve or decline');
      }
      if (positional.length !== 1) throw new Error('meeting consent accepts one decision');
      action = { kind: 'consent', decision };
      break;
    }
    case 'autostart': {
      const operation = positional[0];
      if (operation !== 'enable' && operation !== 'disable' && operation !== 'status') {
        throw new Error('meeting autostart requires enable, disable, or status');
      }
      if (positional.length !== 1) throw new Error('meeting autostart accepts one operation');
      action = { kind: 'autostart', operation };
      break;
    }
    default:
      throw new Error(`Unknown meeting action: ${actionName}`);
  }
  const validForAction = action.kind === 'create'
      ? !backend && !model && !contextPath && !calendarPolicy && !automationMode && !browserWithoutCalendar && !once && !contextFilesSpecified &&
        !observerBackend && !observerModel && !reconciliationBackend && !reconciliationModel &&
        !chatBackend && !chatModel
      : action.kind === 'enrich'
      ? !eventJsonPath && !calendarPolicy && !automationMode && !browserWithoutCalendar && !once && !contextFilesSpecified &&
        !observerBackend && !observerModel && !reconciliationBackend && !reconciliationModel &&
        !chatBackend && !chatModel
      : action.kind === 'chat'
        ? !eventJsonPath && !contextPath && !mode && !calendarPolicy && !automationMode && !browserWithoutCalendar && !once && !contextFilesSpecified &&
          !observerBackend && !observerModel && !reconciliationBackend && !reconciliationModel &&
          !chatBackend && !chatModel
        : action.kind === 'setup'
          ? !eventJsonPath && !contextPath && !once
          : action.kind === 'watch'
            ? !eventJsonPath && !contextPath && !mode && !backend && !model && !calendarPolicy && !contextFilesSpecified &&
              !automationMode && !browserWithoutCalendar &&
              !observerBackend && !observerModel && !reconciliationBackend && !reconciliationModel &&
              !chatBackend && !chatModel
            : !eventJsonPath && !contextPath && !mode && !backend && !model && !calendarPolicy && !contextFilesSpecified &&
            !automationMode && !browserWithoutCalendar && !once &&
            !observerBackend && !observerModel && !reconciliationBackend && !reconciliationModel &&
            !chatBackend && !chatModel;
  if (!validForAction) throw new Error(`One or more options do not apply to meeting ${action.kind}`);
  return { kind: 'meeting', action, ...(libraryDir ? { libraryDir } : {}), json };
}

function parseCapture(args: string[]): CaptureCommand {
  const actionName = args[1] ?? 'list';
  const positional: string[] = [];
  let libraryDir: string | undefined;
  let json = false;
  let seconds = 5;
  let secondsProvided = false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--library-dir') {
      const [value, consumedIndex] = takeValue(args, index, arg);
      libraryDir = value;
      index = consumedIndex;
    } else if (arg === '--seconds') {
      const [value, consumedIndex] = takeValue(args, index, arg);
      seconds = positiveInteger(arg, value);
      secondsProvided = true;
      index = consumedIndex;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown capture option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (actionName === 'list') {
    if (positional.length > 0) throw new Error('capture list accepts no session ID');
    if (secondsProvided) throw new Error('--seconds only applies to capture test or record');
    return { kind: 'capture', action: { kind: 'list' }, ...(libraryDir ? { libraryDir } : {}), json };
  }
  if (actionName === 'test') {
    if (positional.length > 0) throw new Error('capture test accepts no session ID');
    if (seconds < 2 || seconds > 30) throw new Error('--seconds must be from 2 to 30');
    return {
      kind: 'capture', action: { kind: 'test', seconds },
      ...(libraryDir ? { libraryDir } : {}), json,
    };
  }
  if (actionName === 'record') {
    if (positional.length > 0) throw new Error('capture record accepts no session ID');
    if (!secondsProvided) throw new Error('capture record requires --seconds');
    if (seconds < 2 || seconds > 14_400) throw new Error('--seconds must be from 2 to 14400');
    return {
      kind: 'capture', action: { kind: 'record', seconds },
      ...(libraryDir ? { libraryDir } : {}), json,
    };
  }
  if (actionName !== 'show' && actionName !== 'finalize') {
    throw new Error(`Unknown capture action: ${actionName}`);
  }
  if (secondsProvided) throw new Error('--seconds only applies to capture test or record');
  if (!positional[0] || positional.length !== 1) {
    throw new Error(`capture ${actionName} requires one session ID`);
  }
  return {
    kind: 'capture',
    action: { kind: actionName, id: positional[0] },
    ...(libraryDir ? { libraryDir } : {}),
    json,
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
  if (args[0] === 'setup') {
    const unknown = args.slice(1).filter((arg) => arg !== '--no-autostart' && arg !== '--json');
    if (unknown.length) throw new Error(`Unknown setup option: ${unknown[0]}`);
    return {
      kind: 'setup',
      autostart: !args.includes('--no-autostart'),
      json: args.includes('--json'),
    };
  }
  if (args[0] === 'capabilities') {
    const unknown = args.slice(1).filter((arg) => arg !== '--json');
    if (unknown.length) throw new Error(`Unknown capabilities option: ${unknown[0]}`);
    return { kind: 'capabilities', json: args.includes('--json') };
  }
  if (args[0] === 'update') {
    const unknown = args.slice(1).filter((arg) => arg !== '--check' && arg !== '--json');
    if (unknown.length) throw new Error(`Unknown update option: ${unknown[0]}`);
    return { kind: 'update', check: args.includes('--check'), json: args.includes('--json') };
  }
  if (args[0] === 'capture') return parseCapture(args);
  if (args[0] === 'meeting') return parseMeeting(args);
  if (args[0] === 'library') return parseLibrary(args);
  return parseTranscribe(args, args[0] === 'transcribe');
}

export const CLI_HELP = `Sea Shell — local-first media transcription

Usage:
  seashell                                  Open the live + transcript library TUI
  seashell <file> ...                       Backward-compatible plain-text transcription
  seashell transcribe <file> [options]      Transcribe audio or video
  seashell library <action> [options]       Browse and manage saved transcripts
  seashell capture <action> [options]       Inspect or finalize recoverable live capture
  seashell meeting <action> [options]       Create, enrich, browse, or chat with meetings
  seashell setup [--no-autostart] [--json]  Apply safe defaults on a true first install
  seashell doctor [--json]                  Check dependencies and models
  seashell capabilities [--json]            Describe optional engine capabilities
  seashell update [--check] [--json]        Safely update this Git checkout

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
  --speaker-evidence <json>    External roster + timestamped active-speaker evidence
  --diarize                    Legacy alias for --speakers --format json

Library actions:
  library list [--json]
  library show <id> [--format text|json|srt|vtt] [--timestamps] [--speakers]
  library search <query> [--json]
  library export <id> --format text|json|srt|vtt [--output <path>]
  library speakers <id> set <speaker-id> <name> [--json]
  library open [id]
  library trash <id> --confirm

Capture actions:
  capture test [--seconds 5] [--json]       Prove mic + system signal, then discard test audio
  capture record --seconds <n> [--json]     Run a bounded durable provider capture
  capture list [--json]
  capture show <session-id> [--json]
  capture finalize <session-id> [--json]

Meeting actions:
  meeting setup --backend <backend> --model <exact-model> [--mode <mode>]
                [--calendar off|ask|selected-calendars|all]
                [--automation off|ask|automatic]
                [--browser-without-calendar off|ask|automatic]
                [--context-file <path>]...
                [--clear-context-files]
                [--observer-backend <backend> --observer-model <model>]
                [--reconciliation-backend <backend> --reconciliation-model <model>]
                [--chat-backend <backend> --chat-model <model>]
  meeting create <id> [--event-json <path>] [--mode streaming|post-session|hybrid]
  meeting enrich <id> [--mode <mode>] [--backend <backend>] [--model <exact-model>]
                      [--context <json>]
  meeting show <id> [--json]
  meeting chat <id> <question> [--backend <backend>] [--model <exact-model>]
  meeting calendar [--json]
  meeting watch [--once] [--json]             Watch cheaply and record detected meetings
  meeting consent approve|decline             Answer a background browser-capture request
  meeting autostart enable|disable|status      Manage the macOS login agent

Configuration precedence:
  CLI flag > SEASHELL_LIBRARY_DIR > config.json > ~/Documents/Sea Shell/Transcripts

Machine use:
  stdout contains results only; progress and errors use stderr. Library, doctor,
  and update commands support JSON. Non-interactive commands never prompt.
`;
