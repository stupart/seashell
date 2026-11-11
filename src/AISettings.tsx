import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import AdvancedAISettings from './AIProviderPicker.tsx';
import { KeyBar, Paragraph, ScreenTitle } from './tui-chrome.tsx';
import { AI_PROVIDERS, currentMeetingRoutes, preferredAIProvider, recommendedMeetingSetup } from './ai-provider.ts';
import type { SeashellMeetingConfig } from './config.ts';
import {
  discoverHumainModels,
  discoverHumainProviders,
  testMeetingAi,
  type HumainBackend,
  type MeetingAiRole,
  type MeetingAiTest,
} from './humain-client.ts';

type Providers = Awaited<ReturnType<typeof discoverHumainProviders>>['integrations'];
type HomeEntry = 'use' | 'test' | 'another' | 'advanced' | 'recommended';

const ROLE_WORDS: Record<MeetingAiRole, string> = { observer: 'live', reconciliation: 'notes', chat: 'chat' };
const nameOf = (id: HumainBackend) => AI_PROVIDERS.find((provider) => provider.id === id)?.name ?? id;

/** Each route the test tried: ✓ with how long it took, or ✗ with what to do. */
function ConnectionTest(props: { test: MeetingAiTest; width: number }) {
  if (!props.test.routes.length) {
    return <Paragraph width={props.width} color={props.test.engine.ready ? 'yellow' : 'red'}
      text={props.test.engine.ready ? 'No AI is chosen yet, so there is nothing to test.' : props.test.engine.detail ?? 'The AI engine is not installed.'} />;
  }
  return <>{props.test.routes.map((route) => {
    const name = `${nameOf(route.backend)} · ${route.model}`;
    const roles = route.roles.map((role) => ROLE_WORDS[role]).join(', ');
    return <Box key={`${route.backend}-${route.model}-${roles}`} flexDirection="column" flexShrink={0}>
      <Text wrap="truncate-end"><Text color={route.ok ? 'green' : 'red'}>{route.ok ? '✓' : '✗'}</Text> {name}
        <Text dimColor>{'  '}{roles}{route.ok && route.latencyMs !== undefined ? ` · answered in ${(route.latencyMs / 1000).toFixed(1)} s` : ''}</Text></Text>
      {!route.ok && <Box paddingLeft={2}><Paragraph width={props.width - 2} color="red" text={route.reason ?? route.failure?.message ?? 'It did not answer.'} /></Box>}
    </Box>;
  })}</>;
}

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
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<MeetingAiTest>();
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
  const canUse = Boolean(proposal || configured);
  const { stdout } = useStdout();
  // Testing sends one tiny fixed prompt through each route that is saved, so it waits for a proposal to be saved first.
  const home: Array<[HomeEntry, string]> = [
    ['use', proposal ? `Yes, use ${providerName}` : configured ? 'Done' : 'Find connected AI'],
    ...(configured && !proposal ? [['test', 'Test connection'] as [HomeEntry, string]] : []),
    ['another', 'Choose another AI…'], ['advanced', 'Advanced · models and effort…'],
    ...(configured ? [['recommended', 'Use recommended models…'] as [HomeEntry, string]] : []),
  ];
  const entries = screen === 'providers'
    ? AI_PROVIDERS.map((provider) => `${provider.name} · ${providers?.find((item) => item.id === provider.id)?.ready ? 'Connected' : 'Not set up'}`)
    : home.map(([, label]) => label);
  const runTest = () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setTesting(true); setTest(undefined); setError(undefined);
    void testMeetingAi(currentMeetingRoutes(props.current), { mode: props.current?.mode ?? 'hybrid', signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setTest(result); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setTesting(false); });
  };

  useInput((input, key) => {
    if (testing) {
      if (key.escape) { request.current?.abort(); setTesting(false); }
      return;
    }
    if (key.escape) {
      request.current?.abort(); setBusy(false); setError(undefined); setTest(undefined);
      if (screen === 'providers') { setScreen('home'); setIndex(0); }
      else props.onClose();
      return;
    }
    if (key.upArrow || key.downArrow) {
      setIndex((value) => (value + (key.upArrow ? -1 : 1) + entries.length) % entries.length);
      setError(undefined); setTest(undefined); return;
    }
    if (input.toLowerCase() === 'r') { setRefresh((value) => value + 1); return; }
    if (!key.return || busy) return;
    if (screen === 'providers') {
      const selected = AI_PROVIDERS[index]!;
      const status = providers?.find((item) => item.id === selected.id);
      if (status?.ready) chooseProvider(selected.id);
      else setError(status?.nextStep ?? status?.detail ?? 'Connect this provider, then press R to refresh.');
      return;
    }
    const entry = home[index]?.[0];
    if (entry === 'use') {
      try {
        if (proposal) props.onSave(proposal);
        else if (configured) props.onClose();
        else { setScreen('providers'); setIndex(0); }
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    } else if (entry === 'test') runTest();
    else if (entry === 'another') { setScreen('providers'); setIndex(0); }
    else if (entry === 'advanced') { request.current?.abort(); setBusy(false); setScreen('advanced'); }
    else {
      const backend = backends.length === 1 ? backends[0] : preferredAIProvider(providers ?? []);
      if (backend) chooseProvider(backend);
      else { setScreen('providers'); setIndex(0); }
    }
  }, { isActive: screen !== 'advanced' });

  if (screen === 'advanced') return <AdvancedAISettings current={proposal ? { ...props.current, ...proposal } : props.current} recording={props.recording}
    onClose={() => { setScreen('home'); setIndex(Math.max(0, home.findIndex(([entry]) => entry === 'advanced'))); }}
    onSave={(patch) => props.onSave({ ...patch, modelSelection: 'custom' })} />;
  return <Box flexDirection="column" paddingX={1} height={stdout?.rows ?? 24} overflow="hidden">
    <ScreenTitle name="AI for notes and chat" />
    {props.recording && <Text color="yellow">Recording continues · Esc to return</Text>}
    <Text>{screen === 'providers' ? 'Connect once. Seashell chooses the models.' : busy ? 'Finding your connected AI…'
      : canUse ? `${proposal ? 'Write notes with' : 'Using'} ${providerName}${proposal ? '?' : ''}` : 'No connected AI found. Recording still works.'}</Text>
    <Box flexDirection="column" marginTop={1}>
      {entries.map((label, i) => <Text key={label} inverse={index === i} wrap="truncate-end">{index === i ? '› ' : '  '}{label}</Text>)}
    </Box>
    <Box flexDirection="column" marginTop={1}>
      {screen === 'home' && canUse && <Text dimColor>{backends.some((id) => id !== 'local-openai')
        ? `Your meeting text will be sent through your ${providerName} account. Usage follows your plan.`
        : 'Meeting text stays with your configured local model server.'}</Text>}
      {screen === 'providers' && <Text dimColor>{AI_PROVIDERS[index]?.privacy}</Text>}
      {screen === 'home' && (testing || test) && <Box flexDirection="column" marginTop={1}>
        <Text bold>Connection test</Text>
        {testing ? <Text dimColor>Sending one short fixed prompt to each AI in use. No meeting text is sent.</Text>
          : test && <ConnectionTest test={test} width={(stdout?.columns ?? 80) - 2} />}
      </Box>}
      {error && <Text color="red">{error.slice(0, 240)}</Text>}
      {!busy && !canUse && screen === 'home' && <Text dimColor>No Seashell account needed. Connect a provider or return to your transcript.</Text>}
    </Box>
    <Box flexGrow={1} />
    <Box flexShrink={0}>{testing ? <Text color="yellow">Testing… Esc cancels</Text>
      : <KeyBar help={false} columns={(stdout?.columns ?? 80) - 2}
        hints={[['↑↓', 'choose'], ['Enter', screen === 'home' && home[index]?.[0] === 'test' ? test ? 'test again' : 'test' : 'continue'], ['r', 'refresh'], ['Esc', 'back']]} />}</Box>
  </Box>;
}
