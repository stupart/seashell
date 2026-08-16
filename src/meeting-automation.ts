import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { MeetingCalendarEvent } from './meeting-artifact.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const MEETING_SIGNALS_HELPER = join(
  PROJECT_ROOT,
  'native',
  'bin',
  'seashell-meeting-signals',
);

export type MeetingApplicationKind = 'dedicated' | 'browser' | 'ambiguous';
export type MeetingAutomationMode = 'off' | 'ask' | 'automatic';
export type BrowserMeetingPolicy = 'off' | 'ask' | 'automatic';

export interface MeetingAutomationConfig {
  enabled?: boolean;
  mode?: MeetingAutomationMode;
  browserWithoutCalendar?: BrowserMeetingPolicy;
  confirmationPolls?: number;
  pollSeconds?: number;
  endGraceSeconds?: number;
  cooldownSeconds?: number;
  maxDurationMinutes?: number;
  launchAtLogin?: boolean;
}

export const DEFAULT_MEETING_AUTOMATION = Object.freeze({
  enabled: true,
  mode: 'automatic' as const,
  browserWithoutCalendar: 'ask' as const,
  confirmationPolls: 2,
  pollSeconds: 3,
  endGraceSeconds: 20,
  cooldownSeconds: 30,
  maxDurationMinutes: 240,
  launchAtLogin: false,
});

export interface AudioInputProcess {
  readonly pid: number;
  readonly bundleId: string;
  readonly name: string;
}

export interface MeetingSignalSnapshot {
  readonly schemaVersion: 1;
  readonly capturedAtUnixMs: number;
  readonly supported: boolean;
  readonly frontmostBundleId?: string;
  readonly inputProcesses: readonly AudioInputProcess[];
}

export interface MeetingCandidate {
  readonly id: string;
  readonly appName: string;
  readonly bundleId: string;
  readonly pid: number;
  readonly kind: MeetingApplicationKind;
  readonly title: string;
  readonly calendar?: MeetingCalendarEvent;
  readonly evidence: readonly ('audio-input-process' | 'calendar' | 'frontmost')[];
  readonly requiresConsent: boolean;
}

interface AppPattern {
  readonly id: string;
  readonly name: string;
  readonly kind: MeetingApplicationKind;
  readonly bundleIds: readonly string[];
}

const APP_PATTERNS: readonly AppPattern[] = Object.freeze([
  {
    id: 'zoom',
    name: 'Zoom',
    kind: 'dedicated',
    bundleIds: ['us.zoom.xos', 'us.zoom.ZoomPhone'],
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    kind: 'dedicated',
    bundleIds: ['com.microsoft.teams2', 'com.microsoft.teams'],
  },
  {
    id: 'webex',
    name: 'Webex',
    kind: 'dedicated',
    bundleIds: ['com.webex.meetingmanager', 'com.cisco.webexmeetingsapp'],
  },
  {
    id: 'facetime',
    name: 'FaceTime',
    kind: 'dedicated',
    bundleIds: ['com.apple.FaceTime', 'com.apple.avconferenced'],
  },
  {
    id: 'slack',
    name: 'Slack',
    kind: 'ambiguous',
    bundleIds: ['com.tinyspeck.slackmacgap'],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    kind: 'ambiguous',
    bundleIds: ['net.whatsapp.WhatsApp'],
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    kind: 'browser',
    bundleIds: ['com.google.Chrome'],
  },
  {
    id: 'safari',
    name: 'Safari',
    kind: 'browser',
    bundleIds: ['com.apple.Safari', 'com.apple.WebKit'],
  },
  {
    id: 'arc',
    name: 'Arc',
    kind: 'browser',
    bundleIds: ['company.thebrowser.Browser'],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    kind: 'browser',
    bundleIds: ['com.microsoft.edgemac'],
  },
  {
    id: 'brave',
    name: 'Brave',
    kind: 'browser',
    bundleIds: ['com.brave.Browser'],
  },
  {
    id: 'firefox',
    name: 'Firefox',
    kind: 'browser',
    bundleIds: ['org.mozilla.firefox'],
  },
]);

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

export function parseMeetingSignalSnapshot(value: unknown): MeetingSignalSnapshot {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.supported !== 'boolean') {
    throw new Error('Meeting signal helper returned an unsupported snapshot');
  }
  if (!Array.isArray(value.inputProcesses)) {
    throw new Error('Meeting signal helper omitted inputProcesses');
  }
  const inputProcesses = value.inputProcesses.map((raw, index): AudioInputProcess => {
    if (!object(raw) || typeof raw.bundleId !== 'string' || !raw.bundleId.trim() ||
        typeof raw.name !== 'string') {
      throw new Error(`Meeting signal input process ${index} is invalid`);
    }
    return Object.freeze({
      pid: safeInteger(raw.pid, `Meeting signal input process ${index} pid`),
      bundleId: raw.bundleId.trim(),
      name: raw.name.trim(),
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    capturedAtUnixMs: safeInteger(value.capturedAtUnixMs, 'Meeting signal capture time'),
    supported: value.supported,
    ...(typeof value.frontmostBundleId === 'string' && value.frontmostBundleId.trim()
      ? { frontmostBundleId: value.frontmostBundleId.trim() }
      : {}),
    inputProcesses: Object.freeze(inputProcesses),
  });
}

export function readMeetingSignalSnapshot(
  helperPath = MEETING_SIGNALS_HELPER,
): MeetingSignalSnapshot {
  const result = spawnSync(helperPath, [], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 256_000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`Could not inspect meeting signals: ${detail}`);
  }
  try {
    return parseMeetingSignalSnapshot(JSON.parse(result.stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse meeting signals: ${message}`);
  }
}

function bundleMatches(actual: string, expected: string): boolean {
  const normalized = actual.toLocaleLowerCase('en-US');
  const prefix = expected.toLocaleLowerCase('en-US');
  return normalized === prefix || normalized.startsWith(`${prefix}.`);
}

function patternFor(bundleId: string): AppPattern | undefined {
  return APP_PATTERNS.find((pattern) => (
    pattern.bundleIds.some((candidate) => bundleMatches(bundleId, candidate))
  ));
}

/** Resolve one audio-backed candidate. Calendar data can strengthen it but can never create it. */
export function resolveMeetingCandidate(
  snapshot: MeetingSignalSnapshot,
  calendar?: MeetingCalendarEvent,
  automation: MeetingAutomationConfig = DEFAULT_MEETING_AUTOMATION,
): MeetingCandidate | undefined {
  if (!snapshot.supported || automation.enabled === false || automation.mode === 'off') return undefined;
  const mapped = snapshot.inputProcesses.flatMap((process) => {
    const pattern = patternFor(process.bundleId);
    return pattern ? [{ process, pattern }] : [];
  });
  const ranked = mapped.toSorted((left, right) => {
    const weight = (kind: MeetingApplicationKind) => kind === 'dedicated' ? 3 : kind === 'browser' ? 2 : 1;
    const frontmost = (bundleId: string) => snapshot.frontmostBundleId &&
      bundleMatches(bundleId, snapshot.frontmostBundleId) ? 1 : 0;
    return weight(right.pattern.kind) - weight(left.pattern.kind) ||
      frontmost(right.process.bundleId) - frontmost(left.process.bundleId) ||
      left.process.pid - right.process.pid;
  });
  const selected = ranked[0];
  if (!selected) return undefined;
  const browserPolicy = automation.browserWithoutCalendar ??
    DEFAULT_MEETING_AUTOMATION.browserWithoutCalendar;
  if (!calendar && selected.pattern.kind === 'browser' && browserPolicy === 'off') return undefined;
  const frontmost = snapshot.frontmostBundleId !== undefined &&
    bundleMatches(selected.process.bundleId, snapshot.frontmostBundleId);
  const requiresConsent = automation.mode === 'ask' || (!calendar && (
    selected.pattern.kind === 'ambiguous' ||
    (selected.pattern.kind === 'browser' && browserPolicy !== 'automatic')
  ));
  return Object.freeze({
    id: `audio:${selected.pattern.id}`,
    appName: selected.pattern.name,
    bundleId: selected.process.bundleId,
    pid: selected.process.pid,
    kind: selected.pattern.kind,
    title: calendar?.title?.trim() || `${selected.pattern.name} meeting`,
    ...(calendar ? { calendar } : {}),
    evidence: Object.freeze([
      'audio-input-process' as const,
      ...(calendar ? ['calendar' as const] : []),
      ...(frontmost ? ['frontmost' as const] : []),
    ]),
    requiresConsent,
  });
}

export type MeetingAutomationPhase =
  | 'watching'
  | 'confirming'
  | 'awaiting-consent'
  | 'recording'
  | 'ending'
  | 'cooldown';

export type MeetingAutomationAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'suggest'; readonly candidate: MeetingCandidate }
  | { readonly kind: 'start'; readonly candidate: MeetingCandidate }
  | { readonly kind: 'finish'; readonly candidate: MeetingCandidate; readonly reason: 'signal-ended' | 'maximum-duration' };

export interface MeetingAutomationState {
  readonly phase: MeetingAutomationPhase;
  readonly candidate?: MeetingCandidate;
  readonly confirmations: number;
  readonly recordingStartedAtUnixMs?: number;
  readonly missingSinceUnixMs?: number;
  readonly cooldownUntilUnixMs?: number;
}

const NONE = Object.freeze({ kind: 'none' as const });

/** Deterministic hysteresis controller; all system reads and side effects stay outside. */
export class MeetingAutomationController {
  #state: MeetingAutomationState = Object.freeze({ phase: 'watching', confirmations: 0 });
  readonly #config: Required<Omit<MeetingAutomationConfig, 'launchAtLogin'>>;

  constructor(config: MeetingAutomationConfig = {}) {
    this.#config = {
      enabled: config.enabled ?? DEFAULT_MEETING_AUTOMATION.enabled,
      mode: config.mode ?? DEFAULT_MEETING_AUTOMATION.mode,
      browserWithoutCalendar: config.browserWithoutCalendar ?? DEFAULT_MEETING_AUTOMATION.browserWithoutCalendar,
      confirmationPolls: config.confirmationPolls ?? DEFAULT_MEETING_AUTOMATION.confirmationPolls,
      pollSeconds: config.pollSeconds ?? DEFAULT_MEETING_AUTOMATION.pollSeconds,
      endGraceSeconds: config.endGraceSeconds ?? DEFAULT_MEETING_AUTOMATION.endGraceSeconds,
      cooldownSeconds: config.cooldownSeconds ?? DEFAULT_MEETING_AUTOMATION.cooldownSeconds,
      maxDurationMinutes: config.maxDurationMinutes ?? DEFAULT_MEETING_AUTOMATION.maxDurationMinutes,
    };
  }

  get state(): MeetingAutomationState {
    return this.#state;
  }

  step(candidate: MeetingCandidate | undefined, nowUnixMs = Date.now()): MeetingAutomationAction {
    if (!this.#config.enabled || this.#config.mode === 'off') {
      this.#state = Object.freeze({ phase: 'watching', confirmations: 0 });
      return NONE;
    }
    if (this.#state.phase === 'cooldown') {
      if (nowUnixMs < (this.#state.cooldownUntilUnixMs ?? 0)) return NONE;
      this.#state = Object.freeze({ phase: 'watching', confirmations: 0 });
    }
    if (this.#state.phase === 'recording' || this.#state.phase === 'ending') {
      const active = candidate?.id === this.#state.candidate?.id;
      const startedAt = this.#state.recordingStartedAtUnixMs ?? nowUnixMs;
      if (nowUnixMs - startedAt >= this.#config.maxDurationMinutes * 60_000) {
        const ending = this.#state.candidate;
        if (!ending) return NONE;
        this.beginCooldown(nowUnixMs);
        return Object.freeze({ kind: 'finish' as const, candidate: ending, reason: 'maximum-duration' as const });
      }
      if (active) {
        this.#state = Object.freeze({
          ...this.#state,
          phase: 'recording',
          candidate,
          missingSinceUnixMs: undefined,
        });
        return NONE;
      }
      const missingSince = this.#state.missingSinceUnixMs ?? nowUnixMs;
      if (nowUnixMs - missingSince < this.#config.endGraceSeconds * 1_000) {
        this.#state = Object.freeze({ ...this.#state, phase: 'ending', missingSinceUnixMs: missingSince });
        return NONE;
      }
      const ending = this.#state.candidate;
      if (!ending) return NONE;
      this.beginCooldown(nowUnixMs);
      return Object.freeze({ kind: 'finish' as const, candidate: ending, reason: 'signal-ended' as const });
    }
    if (this.#state.phase === 'awaiting-consent') {
      if (candidate?.id === this.#state.candidate?.id) {
        this.#state = Object.freeze({ ...this.#state, candidate });
      } else if (!candidate) {
        this.#state = Object.freeze({ phase: 'watching', confirmations: 0 });
      }
      return NONE;
    }
    if (!candidate) {
      this.#state = Object.freeze({ phase: 'watching', confirmations: 0 });
      return NONE;
    }
    const confirmations = this.#state.candidate?.id === candidate.id
      ? this.#state.confirmations + 1
      : 1;
    if (confirmations < this.#config.confirmationPolls) {
      this.#state = Object.freeze({ phase: 'confirming', candidate, confirmations });
      return NONE;
    }
    if (candidate.requiresConsent) {
      this.#state = Object.freeze({ phase: 'awaiting-consent', candidate, confirmations });
      return Object.freeze({ kind: 'suggest' as const, candidate });
    }
    this.#state = Object.freeze({
      phase: 'recording',
      candidate,
      confirmations,
      recordingStartedAtUnixMs: nowUnixMs,
    });
    return Object.freeze({ kind: 'start' as const, candidate });
  }

  approve(nowUnixMs = Date.now()): MeetingCandidate | undefined {
    if (this.#state.phase !== 'awaiting-consent' || !this.#state.candidate) return undefined;
    const candidate = this.#state.candidate;
    this.#state = Object.freeze({
      ...this.#state,
      phase: 'recording',
      recordingStartedAtUnixMs: nowUnixMs,
      missingSinceUnixMs: undefined,
    });
    return candidate;
  }

  decline(nowUnixMs = Date.now()): void {
    this.beginCooldown(nowUnixMs);
  }

  reset(): void {
    this.#state = Object.freeze({ phase: 'watching', confirmations: 0 });
  }

  private beginCooldown(nowUnixMs: number): void {
    this.#state = Object.freeze({
      phase: 'cooldown',
      confirmations: 0,
      cooldownUntilUnixMs: nowUnixMs + this.#config.cooldownSeconds * 1_000,
    });
  }
}
