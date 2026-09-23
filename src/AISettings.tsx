import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import AdvancedAISettings from './AIProviderPicker.tsx';
import { AI_PROVIDERS, currentMeetingRoutes, preferredAIProvider, recommendedMeetingSetup } from './ai-provider.ts';
import type { SeashellMeetingConfig } from './config.ts';
import { discoverHumainModels, discoverHumainProviders, type HumainBackend } from './humain-client.ts';

type Providers = Awaited<ReturnType<typeof discoverHumainProviders>>['integrations'];

/** One provider confirmation; individual models and effort remain in Advanced. */
export default function AISettings(props: {
  current?: SeashellMeetingConfig;
  recording?: boolean;
  onSave: (patch: SeashellMeetingConfig) => void;
  onClose: () => void;
}) {
  const [screen, setScreen] = useState<'home' | 'providers' | 'advanced'>('home');
  const [index, setIndex] = useState(0);
  const [providers, setProviders] = useState<Providers>();
  const [proposal, setProposal] = useState<SeashellMeetingConfig>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | undefined>(undefined);
  const currentRoutes = currentMeetingRoutes(props.current);
  const mode = props.current?.mode ?? 'post-session';
  const configured = Boolean(currentRoutes.chat && (mode === 'streaming' || currentRoutes.reconciliation)
    && (mode === 'post-session' || currentRoutes.observer));

  const propose = async (backend: HumainBackend, controller: AbortController) => {
    const models = await discoverHumainModels(backend, { signal: controller.signal });
    if (!controller.signal.aborted) setProposal(recommendedMeetingSetup(props.current, backend, models));
  };
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(undefined);
    void (async () => {
      try {
        const result = await discoverHumainProviders(undefined, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setProviders(result.integrations);
        if (!configured) {
          const backend = preferredAIProvider(result.integrations);
          if (backend) await propose(backend, controller);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { if (!controller.signal.aborted) setBusy(false); }
    })();
    return () => { controller.abort(); request.current?.abort(); };
  }, [refresh]);

  const chooseProvider = (backend: HumainBackend) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(undefined); setProposal(undefined);
    void propose(backend, controller).then(() => {
      if (!controller.signal.aborted) { setScreen('home'); setIndex(0); }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
  };
  const routes = proposal?.routes ?? currentRoutes;
  const backends = [...new Set(Object.values(routes).flatMap((route) => route ? [route.backend] : []))];
  const providerName = backends.map((id) => AI_PROVIDERS.find((provider) => provider.id === id)!.name).join(' + ');
  const automatic = proposal || props.current?.modelSelection === 'automatic';
  const canUse = Boolean(proposal || configured);
  const entries = screen === 'providers'
    ? AI_PROVIDERS.map((provider) => `${provider.name} · ${providers?.find((item) => item.id === provider.id)?.ready ? 'Connected' : 'Set up'}`)
    : [proposal ? `Use ${providerName}` : configured ? 'Done' : 'Find connected AI', 'Change provider…', 'Advanced · models and effort…',
      ...(configured ? ['Use recommended models…'] : [])];

  useInput((input, key) => {
    if (key.escape) {
      request.current?.abort(); setBusy(false); setError(undefined);
      if (screen === 'providers') { setScreen('home'); setIndex(0); }
      else props.onClose();
      return;
    }
    if (key.upArrow || key.downArrow) {
      setIndex((value) => (value + (key.upArrow ? -1 : 1) + entries.length) % entries.length);
      setError(undefined); return;
    }
    if (input.toLowerCase() === 'r') { setRefresh((value) => value + 1); return; }
    if (!key.return || busy) return;
    if (screen === 'providers') {
      const selected = AI_PROVIDERS[index]!;
      const status = providers?.find((item) => item.id === selected.id);
      if (status?.ready) chooseProvider(selected.id);
      else setError(status?.nextStep ?? status?.detail ?? 'Connect this provider, then press R to refresh.');
    } else if (index === 0) {
      try {
        if (proposal) props.onSave(proposal);
        else if (configured) props.onClose();
        else { setScreen('providers'); setIndex(0); }
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    } else if (index === 1) { setScreen('providers'); setIndex(0); }
    else if (index === 2) { request.current?.abort(); setBusy(false); setScreen('advanced'); }
    else {
      const backend = backends.length === 1 ? backends[0] : preferredAIProvider(providers ?? []);
      if (backend) chooseProvider(backend);
      else { setScreen('providers'); setIndex(0); }
    }
  }, { isActive: screen !== 'advanced' });

  if (screen === 'advanced') return <AdvancedAISettings current={proposal ? { ...props.current, ...proposal } : props.current} recording={props.recording}
    onClose={() => { setScreen('home'); setIndex(2); }}
    onSave={(patch) => props.onSave({ ...patch, modelSelection: 'custom' })} />;
  return <Box flexDirection="column" paddingX={1} paddingY={1}>
    <Text bold color="cyan">Meeting AI</Text>
    {props.recording && <Text color="red">Recording continues · Esc to return</Text>}
    <Text>{screen === 'providers' ? 'Connect once. Seashell chooses the models.' : busy ? 'Finding your connected AI…'
      : canUse ? `${proposal ? 'Ready with' : 'Using'} ${providerName}` : 'No connected AI found. Recording still works.'}</Text>
    {screen === 'home' && canUse && <Box flexDirection="column" marginTop={1}>
      <Text>{automatic ? 'Recommended models' : 'Your saved models'}</Text>
      <Text>Notes: {routes.reconciliation?.model ?? 'Off'} · Chat: {routes.chat?.model ?? 'Not set'}</Text>
      <Text dimColor>{(proposal?.mode ?? mode) === 'post-session' ? 'Final notes + chat · no live AI calls'
        : `Live analysis: ${routes.observer?.model ?? 'Not set'}`}</Text>
    </Box>}
    <Box flexDirection="column" marginTop={1}>
      {entries.map((label, i) => <Text key={label} color={index === i ? 'cyan' : undefined}>{index === i ? '›' : ' '} {label}</Text>)}
    </Box>
    <Box flexDirection="column" marginTop={1}>
      {screen === 'home' && canUse && <Text dimColor>{backends.some((id) => id !== 'local-openai')
        ? 'Meeting text uses these accounts. Usage follows your plan; advanced models may use paid credits.'
        : 'Meeting text stays with your configured local model server.'}</Text>}
      {screen === 'providers' && <Text dimColor>{AI_PROVIDERS[index]?.privacy}</Text>}
      {error && <Text color="red">{error.slice(0, 240)}</Text>}
      {!busy && !canUse && screen === 'home' && <Text dimColor>No Seashell account needed. Connect a provider or return to your transcript.</Text>}
    </Box>
    <Box marginTop={1}><Text dimColor>[↑↓] Choose  [Enter] Continue  [R] Refresh  [Esc] Back</Text></Box>
  </Box>;
}
