import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { AI_PROVIDERS, meetingProviderPatch } from './ai-provider.ts';
import { resolveMeetingRoute, type SeashellMeetingConfig } from './config.ts';
import { discoverHumainProviders } from './humain-client.ts';

export default function AIProviderPicker(props: {
  current?: SeashellMeetingConfig;
  recording?: boolean;
  onSave: (patch: SeashellMeetingConfig) => void;
  onClose: () => void;
}) {
  const current = resolveMeetingRoute(props.current, 'reconciliation');
  const [index, setIndex] = useState(Math.max(0, AI_PROVIDERS.findIndex((p) => p.id === current?.backend)));
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof discoverHumainProviders>>['integrations']>();
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState('');
  const provider = AI_PROVIDERS[index]!;
  const status = providers?.find((p) => p.id === provider.id);
  useEffect(() => {
    const controller = new AbortController();
    setProviders(undefined); setError(undefined);
    void discoverHumainProviders(undefined, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setProviders(result.integrations);
    }, (cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [refresh]);
  useInput((input, key) => {
    if (key.escape) { if (editing) { setEditing(false); setError(undefined); } else props.onClose(); return; }
    if (editing) {
      if (key.return) {
        try { props.onSave(meetingProviderPatch(props.current, provider.id, model)); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      } else if (key.backspace || key.delete) setModel((value) => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setModel((value) => (value + input).slice(0, 200));
      return;
    }
    if (key.upArrow || key.downArrow) {
      setIndex((value) => (value + (key.upArrow ? -1 : 1) + AI_PROVIDERS.length) % AI_PROVIDERS.length);
      setError(undefined);
    } else if (input.toLowerCase() === 'r') setRefresh((value) => value + 1);
    else if (key.return && providers) {
      if (!status?.ready) setError(status?.nextStep ?? status?.detail ?? 'This provider is not available. Refresh after setup.');
      else {
        setError(undefined);
        setModel(current?.backend === provider.id ? current.model : provider.id === 'claude-code' ? 'sonnet' : '');
        setEditing(true);
      }
    }
  });
  return <Box flexDirection="column" paddingX={1} paddingY={1}>
    <Text bold color="cyan">Meeting AI</Text>
    {props.recording && <Text color="red">Recording continues · Esc to return</Text>}
    <Text dimColor>{current ? `Current: ${AI_PROVIDERS.find((p) => p.id === current.backend)?.name ?? current.backend} · ${current.model}` : 'Choose a provider for meeting notes and chat.'}</Text>
    <Box flexDirection="column" marginTop={1}>
      {editing ? <>
        <Text bold>{provider.name}</Text>
        <Text>Model: {model}█</Text>
        <Text dimColor>{provider.id === 'claude-code' ? 'Use sonnet, opus, haiku, or an exact model ID.' : provider.id === 'codex' ? 'Enter the model ID you use in Codex.' : 'Enter a model ID supported by your server or provider.'}</Text>
      </> : AI_PROVIDERS.map((item, itemIndex) => {
        const found = providers?.find((p) => p.id === item.id);
        return <Text key={item.id} color={itemIndex === index ? 'cyan' : undefined}>
          {itemIndex === index ? '›' : ' '} {item.name} · {providers ? found?.ready ? 'Ready' : 'Setup needed' : error ? 'Unavailable' : 'Checking…'}
        </Text>;
      })}
    </Box>
    <Box flexDirection="column" marginTop={1}>
      <Text>{provider.privacy}</Text>
      {editing ? <Text dimColor>Save for notes after meetings and for chat. No model call is made now.</Text>
        : <Text dimColor>{status?.nextStep ?? status?.detail ?? 'Checking installed providers through Humain…'}</Text>}
      {error && <Text color="red">{error}</Text>}
    </Box>
    <Box marginTop={1}><Text dimColor>{editing ? '[Enter] Save  [Esc] Back' : '[↑↓] Choose  [Enter] Model  [R] Refresh  [Esc] Close'}</Text></Box>
  </Box>;
}
