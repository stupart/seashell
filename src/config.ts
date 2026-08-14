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
import type { HumainBackend, HumainMeetingRoute } from './humain-client.ts';
import type { MeetingEnrichmentMode } from './meeting-artifact.ts';
import {
  DEFAULT_TRANSCRIPTION_ROUTING,
  type TranscriptionMode,
  type TranscriptionRoute,
  type TranscriptionRoutingConfig,
} from './transcription-routing.ts';

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
  /** Per-job model routes. Legacy backend/model remain the shared fallback. */
  routes?: {
    observer?: HumainMeetingRoute;
    reconciliation?: HumainMeetingRoute;
    chat?: HumainMeetingRoute;
  };
  calendar?: {
    enabled?: boolean;
    policy?: MeetingCapturePolicy;
    selectedCalendars?: string[];
    leadMinutes?: number;
  };
}

export type MeetingRouteRole = 'observer' | 'reconciliation' | 'chat';

function parseRoute(value: unknown, label: string): HumainMeetingRoute | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Sea Shell config ${label} must be an object`);
  }
  const route = value as Record<string, unknown>;
  const backends: HumainBackend[] = ['codex', 'claude-code', 'openrouter'];
  if (!backends.includes(route.backend as HumainBackend)) {
    throw new Error(`Sea Shell config ${label}.backend is invalid`);
  }
  if (typeof route.model !== 'string' || !route.model.trim()) {
    throw new Error(`Sea Shell config ${label}.model must be a non-empty string`);
  }
  return {
    backend: route.backend as HumainBackend,
    model: route.model.trim(),
    ...(optionalPositiveInteger(route.maxOutputTokens, `${label}.maxOutputTokens`) === undefined
      ? {}
      : { maxOutputTokens: route.maxOutputTokens as number }),
    ...(optionalPositiveInteger(route.maxBudgetMicrousd, `${label}.maxBudgetMicrousd`) === undefined
      ? {}
      : { maxBudgetMicrousd: route.maxBudgetMicrousd as number }),
    ...(optionalPositiveInteger(route.maxCostMicrousd, `${label}.maxCostMicrousd`) === undefined
      ? {}
      : { maxCostMicrousd: route.maxCostMicrousd as number }),
  };
}

export interface SeashellConfig {
  libraryDir?: string;
  saveByDefault?: boolean;
  meeting?: SeashellMeetingConfig;
  transcription?: TranscriptionRoutingConfig;
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
  let routes: SeashellMeetingConfig['routes'];
  if (meeting.routes !== undefined) {
    if (!meeting.routes || typeof meeting.routes !== 'object' || Array.isArray(meeting.routes)) {
      throw new Error('Sea Shell config meeting.routes must be an object');
    }
    const candidate = meeting.routes as Record<string, unknown>;
    const unknown = Object.keys(candidate).find(
      (key) => key !== 'observer' && key !== 'reconciliation' && key !== 'chat',
    );
    if (unknown) throw new Error(`Sea Shell config meeting.routes.${unknown} is not supported`);
    const observer = parseRoute(candidate.observer, 'meeting.routes.observer');
    const reconciliation = parseRoute(candidate.reconciliation, 'meeting.routes.reconciliation');
    const chat = parseRoute(candidate.chat, 'meeting.routes.chat');
    routes = {
      ...(observer === undefined ? {} : { observer }),
      ...(reconciliation === undefined ? {} : { reconciliation }),
      ...(chat === undefined ? {} : { chat }),
    };
  }
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
    ...(routes === undefined ? {} : { routes }),
  };
}

function parseTranscriptionConfig(value: unknown): TranscriptionRoutingConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sea Shell config transcription must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const unknown = Object.keys(candidate).find((key) =>
    !['mode', 'canonicalFinal', 'adaptiveCloudQueueDepth', 'cloud'].includes(key));
  if (unknown) throw new Error(`Sea Shell config transcription.${unknown} is not supported`);
  const modes: TranscriptionMode[] = ['local', 'cloud', 'adaptive'];
  const routes: TranscriptionRoute[] = ['local', 'cloud'];
  const mode = candidate.mode ?? DEFAULT_TRANSCRIPTION_ROUTING.mode;
  const canonicalFinal = candidate.canonicalFinal ?? DEFAULT_TRANSCRIPTION_ROUTING.canonicalFinal;
  if (!modes.includes(mode as TranscriptionMode)) {
    throw new Error('Sea Shell config transcription.mode is invalid');
  }
  if (!routes.includes(canonicalFinal as TranscriptionRoute)) {
    throw new Error('Sea Shell config transcription.canonicalFinal is invalid');
  }
  const adaptiveCloudQueueDepth = candidate.adaptiveCloudQueueDepth === undefined
    ? DEFAULT_TRANSCRIPTION_ROUTING.adaptiveCloudQueueDepth
    : optionalPositiveInteger(candidate.adaptiveCloudQueueDepth, 'transcription.adaptiveCloudQueueDepth') as number;
  let cloud: TranscriptionRoutingConfig['cloud'];
  if (candidate.cloud !== undefined) {
    if (!candidate.cloud || typeof candidate.cloud !== 'object' || Array.isArray(candidate.cloud)) {
      throw new Error('Sea Shell config transcription.cloud must be an object');
    }
    const raw = candidate.cloud as Record<string, unknown>;
    const unknownCloud = Object.keys(raw).find((key) =>
      !['model', 'upstreamProvider', 'maxCostMicrousd', 'uploadConsent'].includes(key));
    if (unknownCloud) throw new Error(`Sea Shell config transcription.cloud.${unknownCloud} is not supported`);
    if (typeof raw.model !== 'string' || !raw.model.trim()) {
      throw new Error('Sea Shell config transcription.cloud.model must be an exact model ID');
    }
    if (raw.upstreamProvider !== undefined &&
        (typeof raw.upstreamProvider !== 'string' || !raw.upstreamProvider.trim())) {
      throw new Error('Sea Shell config transcription.cloud.upstreamProvider must be a string');
    }
    if (typeof raw.uploadConsent !== 'boolean') {
      throw new Error('Sea Shell config transcription.cloud.uploadConsent must be a boolean');
    }
    cloud = {
      model: raw.model.trim(),
      ...(raw.upstreamProvider === undefined ? {} : { upstreamProvider: raw.upstreamProvider.trim() }),
      ...(optionalPositiveInteger(raw.maxCostMicrousd, 'transcription.cloud.maxCostMicrousd') === undefined
        ? {}
        : { maxCostMicrousd: raw.maxCostMicrousd as number }),
      uploadConsent: raw.uploadConsent,
    };
  }
  return {
    mode: mode as TranscriptionMode,
    canonicalFinal: canonicalFinal as TranscriptionRoute,
    adaptiveCloudQueueDepth,
    ...(cloud === undefined ? {} : { cloud }),
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
    ...(parseTranscriptionConfig(candidate.transcription) === undefined
      ? {}
      : { transcription: parseTranscriptionConfig(candidate.transcription) as TranscriptionRoutingConfig }),
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
      ...(patch.routes === undefined
        ? {}
        : {
            routes: {
              ...(currentMeeting.routes && typeof currentMeeting.routes === 'object'
                ? currentMeeting.routes as Record<string, unknown>
                : {}),
              ...patch.routes,
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

/** Resolve a job-specific route without ever inventing or silently changing a model. */
export function resolveMeetingRoute(
  config: SeashellMeetingConfig | undefined,
  role: MeetingRouteRole,
  override?: Partial<Pick<HumainMeetingRoute, 'backend' | 'model'>>,
): HumainMeetingRoute | undefined {
  const exact = config?.routes?.[role];
  if ((override?.backend === undefined) !== (override?.model === undefined)) {
    throw new Error(`Meeting ${role} route requires both backend and model`);
  }
  const selected = override?.backend && override.model
    ? { backend: override.backend, model: override.model }
    : exact ?? (config?.backend && config.model
      ? { backend: config.backend, model: config.model }
      : undefined);
  const backend = selected?.backend;
  const model = selected?.model;
  if ((config?.backend === undefined) !== (config?.model === undefined)) {
    throw new Error('Shared meeting route requires both backend and model');
  }
  if (!backend || !model) return undefined;
  return {
    backend,
    model,
    ...(exact?.maxOutputTokens ?? config?.maxOutputTokens) === undefined
      ? {}
      : { maxOutputTokens: exact?.maxOutputTokens ?? config?.maxOutputTokens },
    ...(exact?.maxBudgetMicrousd ?? config?.maxBudgetMicrousd) === undefined
      ? {}
      : { maxBudgetMicrousd: exact?.maxBudgetMicrousd ?? config?.maxBudgetMicrousd },
    ...(exact?.maxCostMicrousd ?? config?.maxCostMicrousd) === undefined
      ? {}
      : { maxCostMicrousd: exact?.maxCostMicrousd ?? config?.maxCostMicrousd },
  };
}
