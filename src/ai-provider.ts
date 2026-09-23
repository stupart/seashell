import { resolveMeetingRoute, type SeashellMeetingConfig } from './config.ts';
import type { HumainBackend, HumainMeetingRoute } from './humain-client.ts';

export const AI_PROVIDERS: { id: HumainBackend; name: string; privacy: string }[] = [
  { id: 'claude-code', name: 'Claude Code', privacy: 'Meeting text is sent through your Claude Code account.' },
  { id: 'codex', name: 'Codex', privacy: 'Meeting text is sent through your Codex CLI account.' },
  { id: 'local-openai', name: 'Local model', privacy: 'Meeting text goes to your configured local model server.' },
  { id: 'openrouter', name: 'OpenRouter', privacy: 'Meeting text is sent through OpenRouter; API usage is billed.' },
];

/** Apply one explicit provider choice to every meeting role, retaining compatible limits. */
export function meetingProviderPatch(current: SeashellMeetingConfig | undefined,
  backend: HumainBackend, model: string): SeashellMeetingConfig {
  model = model.trim();
  if (!AI_PROVIDERS.some((p) => p.id === backend)) throw new Error('Choose a supported AI provider');
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('Enter a valid model ID');
  const api = backend === 'openrouter' || backend === 'local-openai';
  const route = (role: 'observer' | 'reconciliation' | 'chat'): HumainMeetingRoute => {
    const previous = resolveMeetingRoute(current, role);
    return { backend, model,
      ...(previous?.maxCostMicrousd === undefined ? {} : { maxCostMicrousd: previous.maxCostMicrousd }),
      ...(!api || previous?.maxOutputTokens === undefined ? {} : { maxOutputTokens: previous.maxOutputTokens }),
      ...(backend !== 'claude-code' || previous?.maxBudgetMicrousd === undefined ? {} : { maxBudgetMicrousd: previous.maxBudgetMicrousd }),
    };
  };
  return { backend, model, mode: 'post-session',
    maxOutputTokens: api ? current?.maxOutputTokens : undefined,
    maxBudgetMicrousd: backend === 'claude-code' ? current?.maxBudgetMicrousd : undefined,
    routes: { observer: route('observer'), reconciliation: route('reconciliation'), chat: route('chat') },
  };
}

export const MEETING_ROLES = [
  { id: 'observer', name: 'Live analysis', hint: 'Fast observations while you speak' },
  { id: 'reconciliation', name: 'Final notes', hint: 'Detailed summary, decisions and actions' },
  { id: 'chat', name: 'Meeting chat', hint: 'Questions answered with transcript evidence' },
] as const;
export type MeetingRole = typeof MEETING_ROLES[number]['id'];
export type MeetingRoutes = Partial<Record<MeetingRole, HumainMeetingRoute>>;

export function preferredAIProvider(statuses: { id: string; ready: boolean }[]): HumainBackend | undefined {
  // An explicitly configured local server takes precedence; otherwise reuse a
  // native login before a separately billed API. Never fail over after a call.
  return (['local-openai', 'codex', 'claude-code', 'openrouter'] as const)
    .find((id) => statuses.some((status) => status.id === id && status.ready));
}

export function meetingModelClass(model: import('./humain-client.ts').HumainModelOption): 'fast' | 'balanced' | 'deep' | 'unknown' {
  // Classify exact catalog IDs, not free-form descriptions or provider defaults.
  // Unknown models remain available in Advanced; they are never assumed cheap.
  const id = model.id.replace(/\[[^\]]+\]$/, '');
  if (/(?:^|[-/_.])(?:astra|fable|opus|pro|ultra|deep)(?:$|[-/_.\d])/i.test(id)) return 'deep';
  if (/(?:^|[-/_.])(?:haiku|luna|mini|nano|flash)(?:$|[-/_.\d])/i.test(id)) return 'fast';
  if (/(?:^|[-/_.])(?:sonnet|sol|terra)(?:$|[-/_.\d])/i.test(id)) return 'balanced';
  return 'unknown';
}

export function currentMeetingRoutes(current?: SeashellMeetingConfig): MeetingRoutes {
  return Object.fromEntries(MEETING_ROLES.map(({ id }) => [id, resolveMeetingRoute(current, id)]));
}

export function roleRoute(current: HumainMeetingRoute | undefined, backend: HumainBackend, model: string,
  effort?: import('./humain-client.ts').ModelEffort): HumainMeetingRoute {
  const route = meetingProviderPatch({ routes: { chat: current } }, backend, model).routes!.chat!;
  return { ...route, ...(effort === undefined ? {} : { effort }) };
}

export function meetingRolesPatch(current: SeashellMeetingConfig | undefined, routes: MeetingRoutes,
  mode: NonNullable<SeashellMeetingConfig['mode']>): SeashellMeetingConfig {
  if (!routes.chat || (mode !== 'streaming' && !routes.reconciliation) || (mode !== 'post-session' && !routes.observer)) {
    throw new Error('Choose models for the active meeting roles and chat before saving.');
  }
  return { mode, backend: undefined, model: undefined, maxOutputTokens: undefined, maxBudgetMicrousd: undefined,
    maxCostMicrousd: undefined, routes: Object.fromEntries(MEETING_ROLES.map(({ id }) => [id, routes[id]])) };
}

/** A visible draft based only on discovered options; never silently replace saved choices. */
export function suggestedMeetingRoutes(backend: HumainBackend, models: import('./humain-client.ts').HumainModelOption[],
  current: MeetingRoutes): MeetingRoutes {
  if (!models.length) throw new Error('No models discovered. Choose each role manually.');
  const fast = models.find((m) => meetingModelClass(m) === 'fast');
  const ordinary = models.find((m) => meetingModelClass(m) === 'balanced') ?? fast;
  // Fable can be advertised even when separate usage credits are unavailable.
  // Keep it an explicit advanced choice rather than a first-run default.
  const detailed = models.find((m) => meetingModelClass(m) === 'deep' && !/fable/i.test(m.id)) ?? ordinary
    ?? (backend === 'local-openai' ? models.find((m) => m.isDefault) ?? models[0] : undefined);
  if (!detailed) throw new Error('No recognized meeting models. Open Advanced to choose a model.');
  const chat = ordinary ?? detailed;
  const make = (role: MeetingRole, model: import('./humain-client.ts').HumainModelOption, preferred: import('./humain-client.ts').ModelEffort) =>
    roleRoute(current[role], backend, model.id, model.efforts.includes(preferred) ? preferred : model.defaultEffort);
  return { observer: fast ? make('observer', fast, 'low') : undefined,
    reconciliation: make('reconciliation', detailed, 'high'), chat: make('chat', chat, 'medium') };
}

export function recommendedMeetingSetup(current: SeashellMeetingConfig | undefined, backend: HumainBackend,
  models: import('./humain-client.ts').HumainModelOption[]): SeashellMeetingConfig {
  const routes = suggestedMeetingRoutes(backend, models, currentMeetingRoutes(current));
  // Recording/transcription stay real-time. Continuous LLM analysis is opt-in;
  // when no fast model is known it stays off even if the old provider had one.
  const mode = routes.observer ? current?.mode ?? 'post-session' : 'post-session';
  return { ...meetingRolesPatch(current, routes, mode), modelSelection: 'automatic' };
}
