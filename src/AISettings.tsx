import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import AdvancedAISettings from './AIProviderPicker.tsx';
import { KeyBar, Paragraph, Prompt, ScreenTitle } from './tui-chrome.tsx';
import { AI_PROVIDERS, currentMeetingRoutes, preferredAIProvider, providerName, recommendedMeetingSetup } from './ai-provider.ts';
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
type HomeEntry = 'use' | 'test' | 'another' | 'models';

const ROLE_WORDS: Record<MeetingAiRole, string> = { observer: 'Live analysis', reconciliation: 'Final notes', chat: 'Chat' };

/**
 * What the test found, in columns: each role, the AI it uses, then ✓ with how long it took or ✗. What to
 * do about one that failed goes under it. The models are under Models.
 */
function ConnectionTest(props: { test: MeetingAiTest; width: number }) {
  if (!props.test.routes.length) {
    return <Paragraph width={props.width} color={props.test.engine.ready ? 'yellow' : 'red'}
      text={props.test.engine.ready ? 'No AI is chosen yet, so there is nothing to test.' : props.test.engine.detail ?? 'The AI engine is not installed.'} />;
  }
  const roleWidth = Math.max(...props.test.routes.flatMap((route) => route.roles.map((role) => ROLE_WORDS[role].length)));
  const nameWidth = Math.max(...props.test.routes.map((route) => providerName(route.backend).length));
  return <>{props.test.routes.map((route) => {
    const timing = route.ok && route.latencyMs !== undefined ? ` ${(route.latencyMs / 1000).toFixed(1)} s` : '';
    return <Box key={`${route.backend}-${route.model}-${route.roles.join()}`} flexDirection="column" flexShrink={0}>
      {route.roles.map((role) => <Text key={role} wrap="truncate-end">
        {ROLE_WORDS[role].padEnd(roleWidth)}  {providerName(route.backend).padEnd(nameWidth)}  <Text color={route.ok ? 'green' : 'red'}>{route.ok ? '✓' : '✗'}</Text>
        <Text dimColor>{timing}</Text>
      </Text>)}
      {!route.ok && <Box paddingLeft={roleWidth + 2}>
        <Paragraph width={props.width - roleWidth - 2} color="red" text={route.reason ?? route.failure?.message ?? 'It did not answer.'} />
      </Box>}
    </Box>;
  })}</>;
}

/** One provider confirmation; each role's model and effort, and the recommended ones, are under Models. */
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
    if (controller.signal.aborted) return undefined;
    const next = recommendedMeetingSetup(props.current, backend, models);
    setProposal(next);
    return next;
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

  // Choosing an AI that is connected is the answer: it is used straight away, with no second question.
  const chooseProvider = (backend: HumainBackend) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(undefined); setProposal(undefined);
    void propose(backend, controller).then((next) => {
      if (!controller.signal.aborted && next) props.onSave(next);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
  };
  const routes = proposal?.routes ?? currentRoutes;
  const backends = [...new Set(Object.values(routes).flatMap((route) => route ? [route.backend] : []))];
  const names = backends.map(providerName);
  const providerNames = names.join(' + ');
  const canUse = Boolean(proposal || configured);
  const { stdout } = useStdout();
  const width = (stdout?.columns ?? 80) - 2;
  // Testing sends one tiny fixed prompt through each route that is saved, so it waits for a proposal to be saved first.
  // Once AI is chosen there is nothing to confirm: Esc goes back.
  const home: Array<[HomeEntry, string]> = [
    ...(proposal ? [['use', `Yes, use ${providerNames}`] as [HomeEntry, string]] : configured ? [] : [['use', 'Find connected AI'] as [HomeEntry, string]]),
    ...(configured && !proposal ? [['test', 'Test connection'] as [HomeEntry, string]] : []),
    ['another', 'Choose another AI…'], ['models', 'Models…'],
  ];
  const ready = (id: HumainBackend) => Boolean(providers?.find((item) => item.id === id)?.ready);
  const entries = screen === 'providers' ? AI_PROVIDERS.map((provider) => provider.name) : home.map(([, label]) => label);
  const runTest = () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setTesting(true); setTest(undefined); setError(undefined);
    void testMeetingAi(currentMeetingRoutes(props.current), { mode: props.current?.mode ?? 'hybrid', signal: controller.signal, surface: 'app' })
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
    if (!key.return || busy) return;
    if (screen === 'providers') {
      const selected = AI_PROVIDERS[index]!;
      const status = providers?.find((item) => item.id === selected.id);
      if (status?.ready) chooseProvider(selected.id);
      else setError(status?.nextStep ?? status?.detail ?? 'Connect this provider, then choose it here again.');
      return;
    }
    const entry = home[index]?.[0];
    if (entry === 'use') {
      try {
        if (proposal) props.onSave(proposal);
        else if (configured) props.onClose();
        else { setScreen('providers'); setIndex(0); setRefresh((value) => value + 1); }
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    } else if (entry === 'test') runTest();
    else if (entry === 'another') { setScreen('providers'); setIndex(0); setRefresh((value) => value + 1); }
    else if (entry === 'models') { request.current?.abort(); setBusy(false); setScreen('advanced'); }
  }, { isActive: screen !== 'advanced' });

  if (screen === 'advanced') return <AdvancedAISettings current={proposal ? { ...props.current, ...proposal } : props.current} recording={props.recording}
    onClose={() => { setScreen('home'); setIndex(Math.max(0, home.findIndex(([entry]) => entry === 'models'))); }}
    onSave={(patch) => props.onSave({ ...patch, modelSelection: 'custom' })} />;
  return <Box flexDirection="column" paddingX={1} height={stdout?.rows ?? 24} overflow="hidden">
    <ScreenTitle name="AI for notes and chat" status={props.recording ? { text: 'Recording continues', color: 'yellow' } : undefined} />
    <Text>{screen === 'providers' ? 'Connect once. Seashell chooses the models.' : busy ? 'Finding your connected AI…'
      : canUse ? `${proposal ? 'Write notes with' : 'Using'} ${providerNames}${proposal ? '?' : ''}` : 'No connected AI found. Recording still works.'}</Text>
    <Box flexDirection="column" marginTop={1}>
      {/* Each AI marked as Settings marks its rows: ✓ connected, – not set up. */}
      {entries.map((label, i) => <Text key={label} inverse={index === i} wrap="truncate-end">{index === i ? '› ' : '  '}
        {screen === 'providers' ? <><Text {...(index === i ? {} : { color: ready(AI_PROVIDERS[i]!.id) ? 'green' : 'gray' })}>
          {ready(AI_PROVIDERS[i]!.id) ? '✓' : '–'}</Text> </> : null}{label}</Text>)}
    </Box>
    <Box flexDirection="column" marginTop={1}>
      {screen === 'home' && canUse && <Paragraph width={width} dimColor text={backends.some((id) => id !== 'local-openai')
        ? `Your meeting text will be sent through your ${names.join(' and ')} ${names.length === 1 ? 'account' : 'accounts'}.`
        : 'Meeting text stays with your configured local model server.'} />}
      {screen === 'providers' && <Paragraph width={width} dimColor text={AI_PROVIDERS[index]?.privacy ?? ''} />}
      {screen === 'home' && (testing || test) && <Box flexDirection="column" marginTop={1}>
        <Text bold>Connection test</Text>
        {testing ? <Paragraph width={width} dimColor text="Sending one short fixed prompt to each AI in use. No meeting text is sent." />
          : test && <ConnectionTest test={test} width={width} />}
      </Box>}
      {error && <Paragraph width={width} color="red" text={error.slice(0, 240)} />}
      {!busy && !canUse && screen === 'home' && <Paragraph width={width} dimColor text="No Seashell account needed. Connect a provider or return to your transcript." />}
    </Box>
    <Box flexGrow={1} />
    <Box flexShrink={0}>{testing ? <Prompt text="◐ Testing…" dimColor hints={[['Esc', 'cancel']]} columns={(stdout?.columns ?? 80) - 2} />
      : <KeyBar help={false} columns={(stdout?.columns ?? 80) - 2}
        hints={[['Enter', screen === 'providers' ? ready(AI_PROVIDERS[index]!.id) ? 'use it' : 'how to connect'
          : home[index]?.[0] === 'test' ? test ? 'test again' : 'test' : 'continue'], ['↑↓', 'choose'], ['Esc', 'back']]} />}</Box>
  </Box>;
}
