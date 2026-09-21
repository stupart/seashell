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
