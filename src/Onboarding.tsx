import React, { useEffect, useRef, useState } from 'react';
import { spawnSync } from 'child_process';
import { Box, Text, useInput } from 'ink';
import { rememberAudioCheck, type AudioCheckSource } from './audio-checks.ts';
import { updateMeetingConfig, type SeashellConfig } from './config.ts';
import {
  FEATURE_STATE_COLOR,
  FEATURE_STATE_SYMBOL,
  readFeatureStatuses,
  type FeatureId,
  type FeatureStatus,
  type FeatureStatusDependencies,
} from './feature-status.ts';
import { COMPUTER_PASS, computerLevels, microphoneLevels, type LevelProblem, type LevelSource } from './audio-levels.ts';
import { MENU_LABEL, useSetupActions, type SetupActionProps } from './SettingsScreen.tsx';
import { KeyBar, Paragraph, Prompt, ScreenTitle, Toast, type Hint } from './tui-chrome.tsx';

// MARK: - Levels

// The level sources live with the computer-audio check, which Settings and the CLI run too.
export { computerLevels, microphoneLevels, type LevelProblem, type LevelSource } from './audio-levels.ts';

export interface LevelSources {
  readonly microphone: LevelSource;
  readonly computer: LevelSource;
}

export const DEFAULT_LEVEL_SOURCES: LevelSources = { microphone: microphoneLevels, computer: computerLevels };

/** For a window started with listening turned off: the guide must not open a device either. */
export function switchedOff(variable: string): LevelSource {
  return ({ onProblem }) => {
    onProblem({ kind: 'stopped', message: `Listening is turned off in this window (${variable}=1).` });
    return () => {};
  };
}

/** Speech into a Mac's microphone sits well above a quiet room's -60 dBFS. */
const MICROPHONE_PASS = { dbfs: -42, windows: 3 };
const QUIET_AFTER_MS = 6_000;

interface Meter {
  /** The latest level, 0 to 1. */
  readonly level: number;
  readonly heard: boolean;
  /** Listening this long without hearing what was asked for. */
  readonly quiet: boolean;
  /** Every sample so far was exactly zero: muted, or the wrong input. */
  readonly zeros: boolean;
  readonly problem?: LevelProblem;
}

function useMeter(source: LevelSource | undefined, pass: { dbfs: number; windows: number }): Meter {
  const [meter, setMeter] = useState<Meter>({ level: 0, heard: false, quiet: false, zeros: false });
  useEffect(() => {
    if (!source) return;
    setMeter({ level: 0, heard: false, quiet: false, zeros: false });
    let loud = 0;
    let readings = 0;
    let sound = false;
    let quiet = false;
    let stop: (() => void) | undefined;
    let done = false;
    // Silence gets its explanation after a while; a recorder that sends nothing at all gets its own.
    const timer = setTimeout(() => {
      quiet = true;
      setMeter(current => readings ? { ...current, quiet: !current.heard }
        : { ...current, problem: current.problem ?? { kind: 'stopped', message: 'Nothing is arriving from the recorder. Press s to skip; Settings shows what is wrong.' } });
    }, QUIET_AFTER_MS);
    const finish = () => { if (done) return; done = true; clearTimeout(timer); stop?.(); };
    stop = source({
      onLevel: (level) => {
        if (done) return;
        readings += 1;
        if (level.peak > 0) sound = true;
        if (level.rmsDbfs >= pass.dbfs) loud += 1;
        const heard = loud >= pass.windows;
        setMeter({ level: Math.max(0, Math.min(1, (level.rmsDbfs + 60) / 50)), heard, quiet: quiet && !heard, zeros: !sound });
        // The test is over once it passes; the microphone is not held open longer than that.
        if (heard) finish();
      },
      onProblem: (problem) => { if (!done) setMeter(current => ({ ...current, problem })); },
    });
    if (done) stop();
    return finish;
  }, [source]);
  return meter;
}

function LevelBar(props: { level: number; width: number; heard: boolean }) {
  const filled = Math.round(props.level * props.width);
  return <Text>
    <Text color={props.heard ? 'green' : 'cyan'}>{'█'.repeat(filled)}</Text>
    <Text dimColor>{'░'.repeat(Math.max(0, props.width - filled))}</Text>
  </Text>;
}

// MARK: - Steps

export type GuideStep = 'recorder' | 'microphone' | 'computer' | 'extras' | 'done';

export interface GuideProgress {
  readonly steps: readonly GuideStep[];
  readonly at: number;
  /** What the guide heard itself, which outweighs a silent meeting from before. */
  readonly heard: { readonly microphone?: boolean; readonly computer?: boolean };
}

const EXTRAS: readonly FeatureId[] = ['meet-names', 'speaker-separation', 'ai-notes', 'calendar'];

/** Which steps to show: anything not done yet, and always the microphone, because only hearing it proves it. */
export function planGuide(statuses: readonly FeatureStatus[]): GuideStep[] {
  const state = (id: FeatureId) => statuses.find(status => status.id === id)?.state;
  return [
    ...(state('recorder') !== 'ok' ? ['recorder' as const] : []),
    'microphone',
    ...(state('computer-audio') !== 'ok' ? ['computer' as const] : []),
    ...(EXTRAS.some(id => state(id) !== 'ok') ? ['extras' as const] : []),
    'done',
  ];
}

/** Settings panes the guide opens; injected in tests so nothing outside the window opens. */
export type SystemSettingsPane = 'sound-input' | 'sound-output' | 'microphone-privacy' | 'audio-recording-privacy';
const PANES: Record<SystemSettingsPane, string> = {
  'sound-input': 'x-apple.systempreferences:com.apple.preference.sound?input',
  'sound-output': 'x-apple.systempreferences:com.apple.preference.sound?output',
  'microphone-privacy': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  'audio-recording-privacy': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};
function openPane(pane: SystemSettingsPane): void {
  spawnSync('/usr/bin/open', [PANES[pane]], { stdio: 'ignore', timeout: 5_000 });
}

/**
 * The guided first run: the background recorder, then proof that the microphone
 * and the Mac's sound are heard, then the optional extras. Tyler's own voice was
 * once missing from weeks of calls while every status said "allowed"; hearing
 * the microphone here is how that can never go unnoticed again.
 */
export default function Onboarding(props: SetupActionProps & {
  config: SeashellConfig;
  columns: number;
  rows?: number;
  progress?: GuideProgress;
  /** Updates from the guide, which may arrive together, apply in turn. */
  onProgress: (update: (current: GuideProgress | undefined) => GuideProgress | undefined) => void;
  onClose: () => void;
  levels?: LevelSources;
  openSettings?: (pane: SystemSettingsPane) => void;
  /** Keeps a passed check across restarts; by default beside the settings file. */
  rememberHeard?: (source: AudioCheckSource) => void;
  fromSettings?: boolean;
  dependencies?: FeatureStatusDependencies;
  /** Only this test, as a Settings row asks: "Microphone test", with nothing before or after it. */
  test?: 'microphone' | 'computer';
}) {
  const [statuses, setStatuses] = useState<FeatureStatus[]>();
  const [refresh, setRefresh] = useState(0);
  const [extraIndex, setExtraIndex] = useState(0);
  const setup = useSetupActions({ ...props, onFinished: () => setRefresh(value => value + 1) });
  const levels = props.levels ?? DEFAULT_LEVEL_SOURCES;
  const open = props.openSettings ?? openPane;

  useEffect(() => {
    const controller = new AbortController();
    void readFeatureStatuses({ config: props.config, libraryDir: props.libraryDir, signal: controller.signal,
      ...(props.dependencies ? { dependencies: props.dependencies } : {}) })
      .then(next => { if (!controller.signal.aborted) setStatuses(next); })
      .catch(cause => { if (!controller.signal.aborted) setup.failure(cause); });
    return () => controller.abort();
  }, [refresh, props.config]);
  // The plan is made once, so a step that gets done does not vanish from under the person.
  useEffect(() => {
    if (statuses && !props.progress) props.onProgress(current => current ?? { steps: props.test ? [props.test] : planGuide(statuses), at: 0, heard: {} });
  }, [statuses, props.progress]);

  const progress = props.progress;
  const step = progress?.steps[progress.at];
  const status = (id: FeatureId) => statuses?.find(candidate => candidate.id === id);
  const microphone = status('microphone');
  // Listen only once macOS lets the recorder hear; asking comes first.
  const micAllowed = Boolean(microphone && !microphone.action);
  const mic = useMeter(step === 'microphone' && micAllowed && !progress?.heard.microphone ? levels.microphone : undefined, MICROPHONE_PASS);
  const computer = useMeter(step === 'computer' && !progress?.heard.computer ? levels.computer : undefined, COMPUTER_PASS);
  useEffect(() => {
    if (!progress) return;
    if (mic.heard) props.onProgress(current => current && { ...current, heard: { ...current.heard, microphone: true } });
    if (computer.heard) props.onProgress(current => current && { ...current, heard: { ...current.heard, computer: true } });
  }, [mic.heard, computer.heard]);
  // Remembered once each, so Settings still says it works after a restart. Losing that note never fails the step.
  const remember = (source: AudioCheckSource) => {
    try { (props.rememberHeard ?? rememberAudioCheck)(source); } catch { /* The step passed all the same. */ }
  };
  useEffect(() => { if (mic.heard) remember('microphone'); }, [mic.heard]);
  useEffect(() => { if (computer.heard) remember('computer'); }, [computer.heard]);

  // The step's own ✓ says it worked; only a failure needs words underneath.
  const runQuietly = async (action: NonNullable<FeatureStatus['action']>) => {
    if (await setup.run(action)) setup.setMessage(undefined);
  };
  const next = () => {
    if (!progress) return;
    setup.setMessage(undefined);
    if (progress.at >= progress.steps.length - 1) { props.onClose(); return; }
    props.onProgress(current => current && { ...current, at: Math.min(current.steps.length - 1, current.at + 1) });
  };
  const recorder = status('recorder');
  const extras = EXTRAS.map(id => ({ id, label: MENU_LABEL[id], status: status(id) }));
  const latest = useRef({ step, recorder, microphone, micAllowed, extras, extraIndex, mic, computer });
  latest.current = { step, recorder, microphone, micAllowed, extras, extraIndex, mic, computer };

  useInput((input, key) => {
    const { step, recorder, microphone, micAllowed, extras, extraIndex, mic, computer } = latest.current;
    if (setup.busy) { if (key.escape) setup.cancel(); return; }
    // A confirmation stays in the key bar until the next key.
    if (setup.message?.tone === 'done') setup.setMessage(undefined);
    if (key.escape) { props.onClose(); return; }
    if (input === 's' && step !== 'done' && !props.test) { next(); return; }
    if (step === 'recorder') {
      if (!key.return) return;
      if (recorder?.state === 'ok') next();
      else if (recorder?.state === 'off') {
        try { props.onConfigChange?.(updateMeetingConfig({ automation: { mode: 'automatic', enabled: true } })); }
        catch (cause) { setup.failure(cause); }
      } else if (recorder?.action) void runQuietly(recorder.action);
    } else if (step === 'microphone') {
      // The same keys as audio help: o for Sound settings, p for Privacy.
      if (input === 'o') open('sound-input');
      else if (input === 'p') open('microphone-privacy');
      else if (key.return && mic.heard) next();
      else if (key.return && !micAllowed && microphone?.action) void runQuietly(microphone.action);
    } else if (step === 'computer') {
      if (input === 'o') open('sound-output');
      else if (input === 'p') open('audio-recording-privacy');
      else if (key.return && computer.heard) next();
    } else if (step === 'extras') {
      if (key.upArrow || input === 'k') setExtraIndex(value => Math.max(0, value - 1));
      else if (key.downArrow || input === 'j') setExtraIndex(value => Math.min(extras.length, value + 1));
      else if (key.return) {
        const chosen = extras[extraIndex];
        if (!chosen) next();
        else if (chosen.status?.action) void setup.run(chosen.status.action);
      }
    } else if (step === 'done' && key.return) props.onClose();
  });

  const width = props.columns - 2;
  const barWidth = Math.max(10, Math.min(40, width - 2));
  const heard = progress?.heard ?? {};
  const statusLine = (feature?: FeatureStatus) => feature
    ? <Text color={FEATURE_STATE_COLOR[feature.state]} wrap="truncate-end">{FEATURE_STATE_SYMBOL[feature.state]} {feature.summary}</Text> : null;
  const gap = <Box height={1} flexShrink={0} />;
  const meterBody = (meter: Meter, source: 'microphone' | 'computer') => {
    const yours = source === 'microphone';
    if (meter.heard || (yours ? heard.microphone : heard.computer)) return <Text color="green">{yours
      ? '✓ Heard you. Your side of every meeting is recorded.'
      : '✓ Heard your Mac. Other people in calls are recorded.'}</Text>;
    if (meter.problem) return <>
      <Paragraph width={width} color="red" text={meter.problem.message} />
      {meter.problem.kind === 'permission' && <Paragraph width={width} text={yours
        ? 'Turn on Seashell Microphone in Privacy & Security → Microphone.'
        : 'Allow Seashell System Audio in Privacy & Security → Screen & System Audio Recording.'} />}
    </>;
    return <>
      <LevelBar level={meter.level} width={barWidth} heard={false} />
      {gap}
      {!meter.quiet ? <Text dimColor>Listening…</Text> : yours ? <>
        <Paragraph width={width} color="yellow" text={meter.zeros
          ? 'Nothing heard. Your mic may be muted or set to the wrong input.'
          : 'Nothing that sounds like speech yet.'} />
        <Text>1. Check your Mac, headset or call app is not muted.</Text>
        <Text>2. Check the input in Sound settings.</Text>
      </> : <>
        <Paragraph width={width} color="yellow" text="Nothing heard from your Mac yet." />
        <Text>1. Check the volume is up and not muted.</Text>
        <Text>2. Check the output in Sound settings.</Text>
      </>}
    </>;
  };

  const body = !progress || !statuses ? <Text dimColor>Checking what works…</Text>
    : step === 'recorder' ? <>
      <Text bold>Background recorder</Text>
      <Paragraph width={width} text="Records your calls by itself, even with this window closed. It starts when you log in." />
      {gap}
      {statusLine(recorder)}
    </>
    : step === 'microphone' ? <>
      <Text bold>Your microphone</Text>
      {!micAllowed ? <>
        <Paragraph width={width} text='Seashell records your side of a call through "Seashell Microphone". macOS asks once; choose Allow.' />
        {gap}
        {statusLine(microphone)}
      </> : <>
        <Paragraph width={width} text='Say something, like "testing, one, two".' />
        {gap}
        {meterBody(mic, 'microphone')}
      </>}
    </>
    : step === 'computer' ? <>
      <Text bold>Computer audio</Text>
      <Paragraph width={width} text="Other people in a call come from your Mac's sound. Play any sound: a video, music or an alert." />
      {gap}
      {meterBody(computer, 'computer')}
    </>
    : step === 'extras' ? <>
      <Text bold>Optional extras</Text>
      <Paragraph width={width} text="Seashell records and transcribes without these. Add any now, or later in Settings." />
      {gap}
      {[...extras, undefined].map((extra, i) => {
        const chosen = i === extraIndex;
        if (!extra) return <Text key="finish" inverse={chosen}>{chosen ? '› ' : '  '}Finish setup</Text>;
        return <Text key={extra.id} inverse={chosen} wrap="truncate-end">{chosen ? '› ' : '  '}
          <Text color={chosen || !extra.status ? undefined : FEATURE_STATE_COLOR[extra.status.state]}>{extra.status ? FEATURE_STATE_SYMBOL[extra.status.state] : ' '}</Text>
          {` ${extra.label.padEnd(19)}`}<Text dimColor={!chosen}>{extra.status?.summary ?? ''}</Text>
        </Text>;
      })}
      {extras[extraIndex]?.status && extras[extraIndex]!.status!.state !== 'ok' && <>
        {gap}
        <Paragraph width={width} dimColor text={extras[extraIndex]!.status!.detail} />
      </>}
    </>
    : <>
      <Text bold>{recorder?.state === 'ok' && heard.microphone ? "You're set." : 'Almost there.'}</Text>
      {gap}
      {[
        ['Background recorder', recorder?.state === 'ok', recorder?.summary ?? 'Not checked'],
        ['Your microphone', Boolean(heard.microphone), heard.microphone ? 'Heard you' : 'Not heard yet'],
        ['Computer audio', Boolean(heard.computer || status('computer-audio')?.state === 'ok'),
          heard.computer ? 'Heard your Mac' : status('computer-audio')?.summary ?? 'Not heard yet'],
      ].map(([label, ok, summary]) => <Text key={label as string} wrap="truncate-end">
        <Text color={ok ? 'green' : 'yellow'}>{ok ? '✓' : '!'}</Text> {(label as string).padEnd(21)}<Text dimColor>{summary as string}</Text>
      </Text>)}
      {gap}
      <Paragraph width={width} text={recorder?.state === 'ok' && heard.microphone
        ? 'Join a call and Seashell records it by itself. Notes are written when it ends.'
        : 'Anything skipped is in Settings. Press , in the app, or run this guide again from there.'} />
    </>;

  // Started from Settings, Esc goes back there; on a first run it goes back to the app and leaves setup for later.
  // A test on its own is done once it hears something; there is nothing to skip to.
  const skip: Hint[] = props.test ? [] : [['s', 'skip']];
  const meterHints = (meter: Meter, done: boolean): Hint[] => done ? [['Enter', props.test ? 'done' : 'next'], ['Esc', 'back']]
    : [['o', 'Sound settings'], ...(meter.problem?.kind === 'permission' ? [['p', 'Privacy'] as Hint] : []), ...skip, ['Esc', 'back']];
  const hints: Hint[] = !progress ? [['Esc', 'back']]
    : step === 'recorder' ? [['Enter', recorder?.state === 'ok' ? 'next' : recorder?.state === 'off' ? 'turn on' : 'start it'], ['s', 'skip'], ['Esc', 'back']]
    : step === 'microphone' ? !micAllowed ? [['Enter', 'allow'], ...skip, ['Esc', 'back']] : meterHints(mic, Boolean(mic.heard || heard.microphone))
    : step === 'computer' ? meterHints(computer, Boolean(computer.heard || heard.computer))
    : step === 'extras' ? [['Enter', extraIndex < extras.length ? 'set up' : 'finish'], ['s', 'skip'], ['↑↓', 'choose'], ['Esc', 'back']]
    : [['Enter', 'done']];
  const counted = progress?.steps.filter(candidate => candidate !== 'done') ?? [];
  const place = step && step !== 'done' && !props.test ? `Step ${counted.indexOf(step) + 1} of ${counted.length}` : '';
  const name = props.test === 'microphone' ? 'Microphone test' : props.test === 'computer' ? 'Computer audio test' : 'Guided setup';

  return <Box flexDirection="column" paddingX={1} {...(props.rows ? { height: props.rows } : {})} overflow="hidden">
    <ScreenTitle name={name} status={place ? { text: place } : undefined} />
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {body}
      {setup.message && setup.message.tone !== 'done' && <Box marginTop={1} flexShrink={0}>
        <Paragraph width={width} color={setup.message.tone === 'failed' ? 'red' : 'yellow'} text={setup.message.text} /></Box>}
    </Box>
    {setup.busy ? <Prompt text="◐ Working…" dimColor hints={[['Esc', 'cancel']]} columns={width} />
      : setup.message?.tone === 'done' ? <Toast text={setup.message.text} columns={width} />
      : <KeyBar hints={hints} columns={width} help={false} />}
  </Box>;
}
