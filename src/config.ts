import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import type { MeetingCapturePolicy } from './calendar.ts';
import type { HumainBackend } from './humain-client.ts';
import type { MeetingEnrichmentMode } from './meeting-artifact.ts';

export interface SeashellMeetingConfig {
  mode?: MeetingEnrichmentMode;
  backend?: HumainBackend;
  model?: string;
  maxOutputTokens?: number;
  maxBudgetMicrousd?: number;
  maxCostMicrousd?: number;
  observerMinSegments?: number;
  observerMaxSegments?: number;
  maxObserverRuns?: number;
  calendar?: {
    enabled?: boolean;
    policy?: MeetingCapturePolicy;
    selectedCalendars?: string[];
    leadMinutes?: number;
  };
}

export interface SeashellConfig {
  libraryDir?: string;
  saveByDefault?: boolean;
  meeting?: SeashellMeetingConfig;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Sea Shell config ${label} must be a positive integer`);
  }
  return Number(value);
}

function parseMeetingConfig(value: unknown): SeashellMeetingConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sea Shell config meeting must be an object');
  }
  const meeting = value as Record<string, unknown>;
  const modes: MeetingEnrichmentMode[] = ['streaming', 'post-session', 'hybrid'];
  const backends: HumainBackend[] = ['codex', 'claude-code', 'openrouter'];
  if (meeting.mode !== undefined && !modes.includes(meeting.mode as MeetingEnrichmentMode)) {
    throw new Error('Sea Shell config meeting.mode is invalid');
  }
  if (meeting.backend !== undefined && !backends.includes(meeting.backend as HumainBackend)) {
    throw new Error('Sea Shell config meeting.backend is invalid');
  }
  if (meeting.model !== undefined && (typeof meeting.model !== 'string' || !meeting.model.trim())) {
    throw new Error('Sea Shell config meeting.model must be a non-empty string');
  }
  let calendar: SeashellMeetingConfig['calendar'];
  if (meeting.calendar !== undefined) {
    if (!meeting.calendar || typeof meeting.calendar !== 'object' || Array.isArray(meeting.calendar)) {
      throw new Error('Sea Shell config meeting.calendar must be an object');
    }
    const candidate = meeting.calendar as Record<string, unknown>;
    const policies: MeetingCapturePolicy[] = ['off', 'ask', 'selected-calendars', 'all'];
    if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') {
      throw new Error('Sea Shell config meeting.calendar.enabled must be a boolean');
    }
    if (candidate.policy !== undefined && !policies.includes(candidate.policy as MeetingCapturePolicy)) {
      throw new Error('Sea Shell config meeting.calendar.policy is invalid');
    }
    if (
      candidate.selectedCalendars !== undefined &&
      (!Array.isArray(candidate.selectedCalendars) ||
        candidate.selectedCalendars.some((name) => typeof name !== 'string' || !name.trim()))
    ) {
      throw new Error('Sea Shell config meeting.calendar.selectedCalendars must be strings');
    }
    calendar = {
      ...(candidate.enabled === undefined ? {} : { enabled: candidate.enabled }),
      ...(candidate.policy === undefined
        ? {}
        : { policy: candidate.policy as MeetingCapturePolicy }),
      ...(candidate.selectedCalendars === undefined
        ? {}
        : { selectedCalendars: [...candidate.selectedCalendars] as string[] }),
      ...(optionalPositiveInteger(candidate.leadMinutes, 'meeting.calendar.leadMinutes') === undefined
        ? {}
        : { leadMinutes: candidate.leadMinutes as number }),
    };
  }
  return {
    ...(meeting.mode === undefined ? {} : { mode: meeting.mode as MeetingEnrichmentMode }),
    ...(meeting.backend === undefined ? {} : { backend: meeting.backend as HumainBackend }),
    ...(meeting.model === undefined ? {} : { model: meeting.model as string }),
    ...(optionalPositiveInteger(meeting.maxOutputTokens, 'meeting.maxOutputTokens') === undefined
      ? {}
      : { maxOutputTokens: meeting.maxOutputTokens as number }),
    ...(optionalPositiveInteger(meeting.maxBudgetMicrousd, 'meeting.maxBudgetMicrousd') === undefined
      ? {}
      : { maxBudgetMicrousd: meeting.maxBudgetMicrousd as number }),
    ...(optionalPositiveInteger(meeting.maxCostMicrousd, 'meeting.maxCostMicrousd') === undefined
      ? {}
      : { maxCostMicrousd: meeting.maxCostMicrousd as number }),
    ...(optionalPositiveInteger(meeting.observerMinSegments, 'meeting.observerMinSegments') === undefined
      ? {}
      : { observerMinSegments: meeting.observerMinSegments as number }),
    ...(optionalPositiveInteger(meeting.observerMaxSegments, 'meeting.observerMaxSegments') === undefined
      ? {}
      : { observerMaxSegments: meeting.observerMaxSegments as number }),
    ...(optionalPositiveInteger(meeting.maxObserverRuns, 'meeting.maxObserverRuns') === undefined
      ? {}
      : { maxObserverRuns: meeting.maxObserverRuns as number }),
    ...(calendar === undefined ? {} : { calendar }),
  };
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SEASHELL_CONFIG || join(
    homedir(),
    'Library',
    'Application Support',
    'Sea Shell',
    'config.json',
  );
}

export function loadConfig(path = defaultConfigPath()): SeashellConfig {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Sea Shell config at ${path}: ${message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Sea Shell config at ${path} must be a JSON object`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.libraryDir !== undefined && typeof candidate.libraryDir !== 'string') {
    throw new Error('Sea Shell config libraryDir must be a string');
  }
  if (candidate.saveByDefault !== undefined && typeof candidate.saveByDefault !== 'boolean') {
    throw new Error('Sea Shell config saveByDefault must be a boolean');
  }
  return {
    ...(typeof candidate.libraryDir === 'string' ? { libraryDir: candidate.libraryDir } : {}),
    ...(typeof candidate.saveByDefault === 'boolean'
      ? { saveByDefault: candidate.saveByDefault }
      : {}),
    ...(parseMeetingConfig(candidate.meeting) === undefined
      ? {}
      : { meeting: parseMeetingConfig(candidate.meeting) as SeashellMeetingConfig }),
  };
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function resolveLibraryDir(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  config: SeashellConfig = loadConfig(),
): string {
  const configured = override || env.SEASHELL_LIBRARY_DIR || config.libraryDir || join(
    homedir(),
    'Documents',
    'Sea Shell',
    'Transcripts',
  );
  const expanded = expandHome(configured);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function resolveSaveByDefault(config: SeashellConfig = loadConfig()): boolean {
  return config.saveByDefault ?? true;
}

export function updateMeetingConfig(
  patch: SeashellMeetingConfig,
  path = defaultConfigPath(),
): SeashellConfig {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    loadConfig(path);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  }
  const currentMeeting = raw.meeting && typeof raw.meeting === 'object' && !Array.isArray(raw.meeting)
    ? raw.meeting as Record<string, unknown>
    : {};
  const next = {
    ...raw,
    meeting: {
      ...currentMeeting,
      ...patch,
      ...(patch.calendar === undefined
        ? {}
        : {
            calendar: {
              ...(currentMeeting.calendar && typeof currentMeeting.calendar === 'object'
                ? currentMeeting.calendar as Record<string, unknown>
                : {}),
              ...patch.calendar,
            },
          }),
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.config.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return loadConfig(path);
}
