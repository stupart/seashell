import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { AI_PROVIDERS, MEETING_ROLES, currentMeetingRoutes, meetingRolesPatch, roleRoute, suggestedMeetingRoutes,
  type MeetingRole, type MeetingRoutes } from './ai-provider.ts';
import type { SeashellMeetingConfig } from './config.ts';
import { discoverHumainModels, discoverHumainProviders, type HumainBackend, type HumainModelOption, type ModelEffort } from './humain-client.ts';

type Screen = 'roles' | 'providers' | 'models' | 'custom' | 'effort';
const MODE_NAMES = { 'post-session': 'Final notes only', hybrid: 'Live analysis + final notes', streaming: 'Live analysis only' } as const;
const MODES = ['post-session', 'hybrid', 'streaming'] as const;

export default function AIProviderPicker(props: {
  current?: SeashellMeetingConfig;
  recording?: boolean;
  onSave: (patch: SeashellMeetingConfig) => void;
  onClose: () => void;
}) {
  const [routes, setRoutes] = useState<MeetingRoutes>(() => currentMeetingRoutes(props.current));
  const [mode, setMode] = useState<NonNullable<SeashellMeetingConfig['mode']>>(props.current?.mode ?? 'post-session');
  const [screen, setScreen] = useState<Screen>('roles');
  const [index, setIndex] = useState(0);
  const [role, setRole] = useState<MeetingRole>('observer');
  const [suggesting, setSuggesting] = useState(false);
  const [backend, setBackend] = useState<HumainBackend>('claude-code');
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof discoverHumainProviders>>['integrations']>();
  const [models, setModels] = useState<HumainModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [chosen, setChosen] = useState<HumainModelOption>();
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const catalog = useRef<AbortController | undefined>(undefined);
  const provider = AI_PROVIDERS.find((p) => p.id === backend)!;
  const roleName = MEETING_ROLES.find((r) => r.id === role)!.name;
  const move = (next: Screen, selected = 0) => { setScreen(next); setIndex(selected); setError(undefined); };

  useEffect(() => {
    const controller = new AbortController();
    setProviders(undefined);
    void discoverHumainProviders(undefined, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setProviders(result.integrations);
    }, (cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => () => catalog.current?.abort(), []);

  const loadModels = (id: HumainBackend, suggest: boolean) => {
    catalog.current?.abort();
    const controller = new AbortController(); catalog.current = controller;
    setBackend(id); setModels([]); setLoadingModels(true); move('models');
    void discoverHumainModels(id, { signal: controller.signal }).then((found) => {
      if (controller.signal.aborted) return;
      setModels(found); setLoadingModels(false);
      if (suggest) {
        setRoutes(suggestedMeetingRoutes(id, found, routes)); move('roles', 5);
        setNotice('Suggested models filled in. Review each role and mode before saving.');
      } else setIndex(Math.max(0, found.findIndex((m) => m.id === routes[role]?.model)));
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setLoadingModels(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const saveRole = (model: string, effort?: ModelEffort) => {
    const route = roleRoute(routes[role], backend, model, effort);
    setRoutes((previous) => ({ ...previous, [role]: route })); move('roles', MEETING_ROLES.findIndex((r) => r.id === role));
    setNotice('Role updated in draft. Save choices to apply.');
  };
  const chooseModel = (model: HumainModelOption) => {
    setChosen(model);
    if (!model.efforts.length) saveRole(model.id);
    else {
      const previous = routes[role];
      const retained = previous?.backend === backend && previous.model === model.id ? previous.effort : undefined;
      move('effort', Math.max(0, model.efforts.indexOf(retained as ModelEffort) + 1));
    }
  };
  const count = screen === 'roles' ? 6 : screen === 'providers' ? AI_PROVIDERS.length : screen === 'models' ? models.length + 1 : (chosen?.efforts.length ?? 0) + 1;
  useInput((input, key) => {
    if (key.escape) {
      catalog.current?.abort(); setLoadingModels(false);
      if (screen === 'roles') props.onClose();
      else if (screen === 'providers') move('roles');
      else if (screen === 'models') move('providers', Math.max(0, AI_PROVIDERS.findIndex((p) => p.id === backend)));
      else move('models', Math.max(0, models.findIndex((m) => m.id === chosen?.id)));
      return;
    }
    if (screen === 'custom') {
      if (key.return) { try { saveRole(custom); } catch (cause) { setError(String(cause)); } }
      else if (key.backspace || key.delete) setCustom((value) => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setCustom((value) => (value + input).slice(0, 200));
      return;
    }
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const delta = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -7 : 7;
      setIndex((value) => (value + delta % count + count) % count); return;
    }
    if (input.toLowerCase() === 'r') {
      if (screen === 'models') loadModels(backend, suggesting);
      else setRefresh((value) => value + 1);
      return;
    }
    if (!key.return) return;
    try {
      if (screen === 'roles') {
        setNotice(undefined);
        if (index <= 3) {
          const selected = MEETING_ROLES[Math.min(index, 2)]!.id;
          setRole(selected); setSuggesting(index === 3);
          move('providers', Math.max(0, AI_PROVIDERS.findIndex((p) => p.id === routes[selected]?.backend)));
        } else if (index === 4) setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]!);
        else props.onSave(meetingRolesPatch(props.current, routes, mode));
      } else if (screen === 'providers' && providers) {
        const candidate = AI_PROVIDERS[index]!;
        const status = providers.find((p) => p.id === candidate.id);
        if (!status?.ready) setError(status?.nextStep ?? status?.detail ?? 'Provider setup is required.');
        else loadModels(candidate.id, suggesting);
      } else if (screen === 'models' && !loadingModels) {
        setSuggesting(false);
        if (index === models.length) { setCustom(routes[role]?.backend === backend ? routes[role]?.model ?? '' : ''); move('custom'); }
        else chooseModel(models[index]!);
      } else if (screen === 'effort' && chosen) saveRole(chosen.id, index === 0 ? undefined : chosen.efforts[index - 1]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  });

  let entries: string[];
  if (screen === 'roles') entries = [
    ...MEETING_ROLES.map(({ id, name }) => {
      const route = routes[id];
      const inactive = id === 'observer' && mode === 'post-session' || id === 'reconciliation' && mode === 'streaming';
      return `${name}${inactive ? ' (off)' : ''}: ${route ? `${AI_PROVIDERS.find((p) => p.id === route.backend)?.name} / ${route.model} · ${route.effort ?? 'default effort'}` : 'Choose model'}`;
    }), 'Suggest models for all roles…', `Mode: ${MODE_NAMES[mode]}`, 'Save choices',
  ];
  else if (screen === 'providers') entries = AI_PROVIDERS.map((p) => `${p.name} · ${providers ? providers.find((s) => s.id === p.id)?.ready ? 'Ready' : 'Setup needed' : 'Checking…'}`);
  else if (screen === 'models') entries = [...models.map((m) => `${m.name}${m.id !== m.name ? ` · ${m.id}` : ''}`), 'Enter a custom model ID…'];
  else entries = ['Provider default', ...(chosen?.efforts ?? [])];
  const offset = Math.max(0, Math.min(index - 3, entries.length - 7));
  const selectedProvider = screen === 'providers' ? AI_PROVIDERS[index]! : provider;
  return <Box flexDirection="column" paddingX={1} paddingY={1}>
    <Text bold color="cyan">Meeting AI{screen === 'roles' ? ' · models by role' : ` · ${suggesting ? 'Suggested setup' : roleName}`}</Text>
    {props.recording && <Text color="red">Recording continues · Esc to return</Text>}
    {screen === 'roles' && <Text dimColor>Each role can use its own provider, model and effort.</Text>}
    {screen === 'models' && <Text dimColor>{loadingModels ? 'Reading available models…' : `${provider.name} · ${models.length} discovered models`}</Text>}
    {screen === 'effort' && <Text>{chosen?.name} · reasoning effort</Text>}
    <Box flexDirection="column" marginTop={1}>
      {screen === 'custom' ? <><Text>Model: {custom}█</Text><Text dimColor>Custom IDs use provider-default effort.</Text></>
        : entries.slice(offset, offset + 7).map((label, i) => <Text key={offset + i} color={offset + i === index ? 'cyan' : undefined}>{offset + i === index ? '›' : ' '} {label}</Text>)}
    </Box>
    {entries.length > 7 && screen !== 'custom' && <Text dimColor>{index + 1}/{entries.length} · ↑↓ or PgUp/PgDn</Text>}
    <Box flexDirection="column" marginTop={1}>
      {screen === 'roles' ? <>
        <Text dimColor>{index < 3 ? MEETING_ROLES[index]!.hint : 'Choices are a draft until you save. No model call is made here.'}</Text>
        <Text dimColor>Cloud roles send meeting text to that provider. Usage depends on your plan; Fable may use paid credits.</Text>
      </> : <>
        <Text>{selectedProvider.privacy}</Text>
        {screen === 'providers' && <Text dimColor>{providers?.find((p) => p.id === selectedProvider.id)?.nextStep ?? providers?.find((p) => p.id === selectedProvider.id)?.detail}</Text>}
        {screen === 'models' && <Text dimColor>{models[index]?.description.slice(0, 140) || 'Keep an exact model ID if it is not listed. Account limits still apply.'}</Text>}
        {screen === 'effort' && <Text dimColor>Higher effort can take longer and use more tokens.</Text>}
      </>}
      {notice && screen === 'roles' && <Text color="green">{notice}</Text>}
      {error && <Text color="red">{error.slice(0, 250)}</Text>}
    </Box>
    <Box marginTop={1}><Text dimColor>{screen === 'custom' ? '[Enter] Use model  [Esc] Back' : '[↑↓] Choose  [Enter] Select  [R] Refresh  [Esc] Back'}</Text></Box>
  </Box>;
}
