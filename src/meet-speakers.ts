import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeBackgroundMeetingAccessibility } from './meeting-accessibility-permission.ts';
import type { CaptureSessionStore, CaptureSessionManifest } from './capture-session.ts';
import type { Speaker, TranscriptSegment } from './transcript-types.ts';

export type MeetBrowser = 'chrome' | 'safari';
export type MeetBrowserMode = MeetBrowser | 'auto';
export function meetBrowserMatchesApp(browser: MeetBrowserMode | 'off' | undefined, bundleId?: string): boolean {
  return Boolean(browser && browser !== 'off' && (!bundleId ||
    (browser === 'auto' ? ['com.google.Chrome', 'com.apple.Safari'].includes(bundleId)
      : bundleId === (browser === 'chrome' ? 'com.google.Chrome' : 'com.apple.Safari'))));
}
export interface MeetParticipant { id: string; name: string; self: boolean; speaking: boolean }
export interface MeetSnapshot { meeting: string; joined: boolean; participants: MeetParticipant[] }
export type MeetSpeakerSource = NonNullable<TranscriptSegment['speakerSource']>;
export interface MeetProbe { state: 'connected' | 'idle' | 'permission' | 'ambiguous' | 'unavailable'; detail: string; snapshot?: MeetSnapshot; browser?: MeetBrowser; source?: MeetSpeakerSource; accessibilityTrusted?: boolean; absenceConfirmed?: boolean }
export interface MeetSample { at: number; meeting: string; speaker?: Speaker; browser?: MeetBrowser; source?: MeetSpeakerSource }
export interface MeetSpeaker extends Speaker { source?: MeetSpeakerSource }
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_GAP = 1.75;

export const MEETING_ACCESSIBILITY_HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'bin', 'seashell-meeting-accessibility');
const NATIVE_TIMEOUT_MS = 2500;

function clean(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.length > limit) return undefined;
  const result = value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return result || undefined;
}

export function parseMeetSnapshot(value: unknown): MeetSnapshot | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (typeof v.meeting !== 'string' || !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/u.test(v.meeting) ||
      typeof v.joined !== 'boolean' || !Array.isArray(v.participants) || v.participants.length > 100) return;
  const participants = new Map<string, MeetParticipant>();
  for (const raw of v.participants) {
    if (!raw || typeof raw !== 'object') return;
    const id = clean(raw.id, 512), name = clean(raw.name, 100) ?? '';
    if (!id || typeof raw.name !== 'string' || raw.name.length > 100 || typeof raw.self !== 'boolean' || typeof raw.speaking !== 'boolean') return;
    const previous = participants.get(id);
    if (previous && (previous.name !== name || previous.self !== raw.self)) return;
    participants.set(id, { id, name, self: raw.self, speaking: raw.speaking || previous?.speaking || false });
  }
  return { meeting: v.meeting, joined: v.joined, participants: [...participants.values()] };
}

export function meetPermissionHelp(_browser: MeetBrowserMode): string {
  return 'Enable Accessibility in macOS System Settings → Privacy & Security → Accessibility for Seashell or its launching app. Use [V] Speakers → Connect Google Meet, or seashell meeting speakers setup. No browser developer settings required.';
}

/** Validate the native boundary, including states that must never imply a joined call. */
export function parseMeetAccessibilityProbe(value: unknown): MeetProbe {
  const unavailable: MeetProbe = { state: 'unavailable', detail: 'Meeting Accessibility returned invalid evidence; audio recording continues.' };
  if (!value || typeof value !== 'object') return unavailable;
  const raw = value as Record<string, unknown>;
  if (!['connected', 'idle', 'permission', 'ambiguous', 'unavailable'].includes(String(raw.state))) return unavailable;
  const detail = clean(raw.detail, 2000);
  if (!detail || (raw.browser !== undefined && raw.browser !== 'chrome' && raw.browser !== 'safari') ||
      (raw.accessibilityTrusted !== undefined && typeof raw.accessibilityTrusted !== 'boolean') ||
      (raw.absenceConfirmed !== undefined && typeof raw.absenceConfirmed !== 'boolean')) return unavailable;
  const snapshot = raw.snapshot === undefined ? undefined : parseMeetSnapshot(raw.snapshot);
  if (raw.snapshot !== undefined && !snapshot) return unavailable;
  if ((raw.accessibilityTrusted === false && raw.state !== 'permission') ||
      (raw.state === 'permission' && (raw.accessibilityTrusted === true || raw.absenceConfirmed === true))) return unavailable;
  if (snapshot?.joined && (raw.absenceConfirmed === true || raw.state === 'idle' || raw.state === 'permission' || raw.state === 'ambiguous')) return unavailable;
  if (raw.state === 'connected' && (!snapshot?.joined || !raw.browser)) return unavailable;
  if (snapshot?.joined && !raw.browser) return unavailable;
  return {
    state: raw.state as MeetProbe['state'], detail, source: 'google-meet-accessibility',
    ...(raw.browser ? { browser: raw.browser as MeetBrowser } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(typeof raw.accessibilityTrusted === 'boolean' ? { accessibilityTrusted: raw.accessibilityTrusted } : {}),
    ...(typeof raw.absenceConfirmed === 'boolean' ? { absenceConfirmed: raw.absenceConfirmed } : {}),
  };
}

export interface MeetAccessibilityOptions {
  helperPath?: string;
  requestPermission?: boolean;
}

/** Read native Accessibility metadata only. Background checks never prompt or launch a browser. */
export async function probeMeetAccessibility(mode: MeetBrowserMode, signal?: AbortSignal, options: MeetAccessibilityOptions = {}): Promise<MeetProbe> {
  if (signal?.aborted) return { state: 'unavailable', detail: 'Meet connection check cancelled.' };
  if (process.platform !== 'darwin') return { state: 'unavailable', detail: 'Meeting Accessibility currently requires macOS.' };
  const helper = options.helperPath ?? MEETING_ACCESSIBILITY_HELPER;
  if (!existsSync(helper)) return { state: 'unavailable', detail: 'Meeting Accessibility helper is missing. Run seashell update; source installs can run bash scripts/build-native.sh.' };
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(helper, ['--browser', mode, ...(options.requestPermission ? ['--request-permission'] : [])],
        { timeout: NATIVE_TIMEOUT_MS, maxBuffer: 256 * 1024, signal },
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    if (signal?.aborted) return { state: 'unavailable', detail: 'Meet connection check cancelled.' };
    return parseMeetAccessibilityProbe(JSON.parse(output));
  } catch {
    // Process errors include command text. Never infer a permission denial from it.
    return { state: 'unavailable', detail: signal?.aborted ? 'Meet connection check cancelled.'
      : 'Meeting Accessibility could not be read in time; audio recording continues. Check [V] Speakers.' };
  }
}

/** Explicit connection checks verify the background responsibility chain too;
 * ordinary capture polls use probeMeetSpeakers and never create setup jobs. */
interface MeetConnectionRuntime {
  read?: typeof probeMeetAccessibility;
  background?: typeof probeBackgroundMeetingAccessibility;
  openSettings?: (signal?: AbortSignal) => Promise<void>;
}
export async function checkMeetConnection(mode: MeetBrowserMode, signal?: AbortSignal, runtime: MeetConnectionRuntime = {}): Promise<MeetProbe> {
  const foreground = await (runtime.read ?? probeMeetAccessibility)(mode, signal);
  if (foreground.state === 'permission' || signal?.aborted || foreground.accessibilityTrusted !== true) return foreground;
  const background = await (runtime.background ?? probeBackgroundMeetingAccessibility)({ helperPath: MEETING_ACCESSIBILITY_HELPER, signal });
  if (background.accessibilityTrusted !== true) return {
    ...background, detail: `Background meetings: ${background.detail} Use Connect Google Meet or seashell meeting speakers setup.`,
  };
  return foreground;
}

/** The only permission-prompting entry point; called from an explicit setup action. */
export async function requestMeetAccessibilityPermission(signal?: AbortSignal, runtime: MeetConnectionRuntime = {}): Promise<MeetProbe> {
  const foreground = await (runtime.read ?? probeMeetAccessibility)('auto', signal, { requestPermission: true });
  if ((foreground.state === 'unavailable' && foreground.accessibilityTrusted !== true) || signal?.aborted) return foreground;
  // A permission inherited from a terminal/Codex is not the background host's
  // permission. Explicit setup must request the exact Bun → helper chain too.
  const background = await (runtime.background ?? probeBackgroundMeetingAccessibility)({ helperPath: MEETING_ACCESSIBILITY_HELPER, requestPermission: true, signal });
  const result: MeetProbe = background.accessibilityTrusted !== true
    ? { ...background, detail: `Background meetings: ${background.detail}` } : foreground;
  if (result.state === 'permission' && !signal?.aborted) {
    const openSettings = runtime.openSettings ?? ((signal?: AbortSignal) => new Promise<void>(resolve => {
      execFile('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'],
        { timeout: 2000, signal }, () => resolve());
    }));
    await openSettings(signal);
    return { ...result, detail: `${result.detail} Return to Speakers and choose Check.` };
  }
  if (result.accessibilityTrusted === true) return {
    ...result, detail: 'Accessibility is enabled for this window and background meetings. Join a Google Meet call, then check the connection.',
  };
  return result;
}

/** Check both browsers concurrently. An unreadable second browser is not proof
 * that it has no call; fail closed instead of attaching its mixed audio to a name. */
export async function probeMeetSpeakers(
  mode: MeetBrowserMode,
  signal?: AbortSignal,
  read?: (browser: MeetBrowser, signal?: AbortSignal) => Promise<MeetProbe>,
): Promise<MeetProbe> {
  if (signal?.aborted) return { state: 'unavailable', detail: 'Meet connection check cancelled.' };
  if (!read) return probeMeetAccessibility(mode, signal);
  const browsers: MeetBrowser[] = mode === 'auto' ? ['chrome', 'safari'] : [mode];
  const results = await Promise.all(browsers.map(async browser => {
    try { return { ...await read(browser, signal), browser }; }
    catch { return { state: 'unavailable' as const, browser, detail: `${browser === 'chrome' ? 'Chrome' : 'Safari'} reader unavailable; audio recording continues.` }; }
  }));
  if (signal?.aborted) return { state: 'unavailable', detail: 'Meet connection check cancelled.' };
  const active = results.filter(result => result.snapshot?.joined);
  if (results.some(result => result.state === 'ambiguous') || active.length > 1) return {
    state: 'ambiguous', detail: 'Multiple Meet calls detected. Keep only the call you want to record open; names are paused.',
  };
  const blocked = results.find(result => result.state !== 'idle' && result !== active[0]);
  if (active.length === 1 && !blocked) return {
    ...active[0]!, detail: `${active[0]!.detail} · ${active[0]!.browser === 'chrome' ? 'Chrome' : 'Safari'}`,
  };
  if (blocked) return { ...blocked, snapshot: undefined, detail: active.length
    ? `Meet names paused until the other browser can be checked. ${blocked.detail}` : blocked.detail };
  return { state: 'idle', detail: mode === 'auto'
    ? 'Join a Google Meet call in Chrome or Safari to check speaker names.' : results[0]!.detail };
}

function sampleAt(snapshot: MeetSnapshot | undefined, at: number, browser?: MeetBrowser, source?: MeetSpeakerSource): MeetSample {
  const remote = snapshot?.participants.filter(p => p.speaking && !p.self) ?? [];
  const one = remote.length === 1 && remote[0]!.name ? remote[0] : undefined;
  return { at, meeting: snapshot?.meeting ?? '', ...(source ? { source } : {}), ...(snapshot && browser ? { browser } : {}), ...(one ? { speaker: {
    id: `MEET_${createHash('sha256').update(`${snapshot!.meeting}\0${one.id}`).digest('hex').slice(0, 20)}`,
    label: one.name,
  } } : {}) };
}

/** Only bridge adjacent, matching observations; never carry names across gaps,
 * overlap, pause, a changed call, or a browser failure. */
export function meetSpeakerForSegment(samples: readonly MeetSample[], segment: Pick<TranscriptSegment, 'start' | 'end'>): MeetSpeaker | undefined {
  if (!Number.isFinite(segment.start) || segment.end <= segment.start) return;
  let matched: MeetSpeaker | undefined;
  let coverage = 0;
  // Binary search keeps long final transcripts from becoming quadratic.
  let lo = 0, hi = samples.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid]!.at < segment.start) lo = mid + 1; else hi = mid; }
  for (let i = Math.max(0, lo - 1); i + 1 < samples.length; i++) {
    const a = samples[i]!, b = samples[i + 1]!;
    if (a.at >= segment.end) break;
    if (b.at <= segment.start) continue;
    const overlap = Math.min(segment.end, b.at) - Math.max(segment.start, a.at);
    if (overlap <= 0) continue;
    if (b.at - a.at > MAX_GAP || b.at <= a.at || !a.speaker || !b.speaker ||
        a.meeting !== b.meeting || a.browser !== b.browser || a.source !== b.source || a.speaker.id !== b.speaker.id || a.speaker.label !== b.speaker.label) return;
    if (matched && matched.id !== a.speaker.id) return;
    matched = a.source ? { ...a.speaker, source: a.source } : a.speaker; coverage += overlap;
  }
  return coverage / (segment.end - segment.start) >= 0.9 ? matched : undefined;
}

export function readMeetSamples(manifestPath: string, manifest: CaptureSessionManifest): MeetSample[] {
  const path = join(dirname(manifestPath), 'meet-speakers.jsonl');
  if (!existsSync(path)) return [];
  try {
    if (statSync(path).size > MAX_BYTES) return [];
    const lines = readFileSync(path, 'utf8').split('\n');
    const header = JSON.parse(lines.shift()!);
    if (header.version !== 1 || header.sessionId !== manifest.sessionId || header.origin !== manifest.startedAtUnixMs) return [];
    const samples: MeetSample[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line);
      if (!Number.isFinite(raw.at) || raw.at < 0 || raw.at <= (samples.at(-1)?.at ?? -1) ||
          typeof raw.meeting !== 'string' || (raw.meeting !== '' && !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/u.test(raw.meeting))) return [];
      if (raw.speaker && (!/^MEET_[a-f0-9]{20}$/u.test(raw.speaker.id) || clean(raw.speaker.label, 100) !== raw.speaker.label)) return [];
      if (raw.browser !== undefined && !['chrome', 'safari'].includes(raw.browser)) return [];
      if (raw.source !== undefined && !['google-meet-dom', 'google-meet-accessibility'].includes(raw.source)) return [];
      samples.push({ at: raw.at, meeting: raw.meeting, ...(raw.source ? { source: raw.source } : {}), ...(raw.browser ? { browser: raw.browser } : {}),
        ...(raw.speaker ? { speaker: { id: raw.speaker.id, label: raw.speaker.label } } : {}) });
      if (samples.length > 100_000) return [];
    }
    return samples;
  } catch { return []; } // A damaged optional sidecar must not lose the audio transcript.
}

export interface MeetSpeakerReader { stop(): void; speakerFor(segment: TranscriptSegment): MeetSpeaker | undefined }
export function startMeetSpeakerReader(options: {
  browser: MeetBrowserMode; store: CaptureSessionStore; onStatus?: (probe: MeetProbe) => void;
  probe?: typeof probeMeetSpeakers; now?: () => number; pollMs?: number;
}): MeetSpeakerReader {
  const now = options.now ?? Date.now;
  const path = join(options.store.root, 'meet-speakers.jsonl');
  const origin = options.store.manifest.startedAtUnixMs;
  const samples: MeetSample[] = [];
  let pinned: string | undefined;
  let pinnedBrowser: MeetBrowser | undefined;
  let stopped = false, bytes = 0, count = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const write = (sample: MeetSample) => {
    if (sample.at < 0 || sample.at <= (samples.at(-1)?.at ?? -1)) return;
    const line = JSON.stringify(sample) + '\n';
    bytes += Buffer.byteLength(line); count++;
    if (bytes > MAX_BYTES || count > 100_000) throw new Error('Meet evidence limit reached');
    appendFileSync(path, line, { mode: 0o600 });
    samples.push(sample);
    while (samples.length > 600) samples.shift(); // Five minutes of live hints; full history stays on disk.
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer); controller.abort();
    try { write(sampleAt(undefined, Math.max((now() - origin) / 1000, (samples.at(-1)?.at ?? -1) + 0.001))); } catch {}
  };
  try {
    if (!existsSync(path)) appendFileSync(path, JSON.stringify({ version: 1, sessionId: options.store.manifest.sessionId, origin }) + '\n', { flag: 'wx', mode: 0o600 });
    bytes = statSync(path).size;
    if (bytes > MAX_BYTES) throw new Error('Meet evidence limit reached');
    // Preserve call binding and monotonic time across pause/resume.
    const prior = readMeetSamples(options.store.manifestPath, options.store.manifest);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0]!);
    if (header.sessionId !== options.store.manifest.sessionId || header.origin !== origin || header.version !== 1 ||
        lines.length !== prior.length + 1) throw new Error('Invalid Meet evidence');
    pinned = prior.find(s => s.meeting)?.meeting;
    pinnedBrowser = prior.find(s => s.browser)?.browser;
    count = prior.length; samples.push(...prior.slice(-600));
  } catch {
    stopped = true;
    options.onStatus?.({ state: 'unavailable', detail: 'Could not save Meet speaker evidence; audio recording continues.' });
  }
  const poll = async () => {
    const start = now();
    let probe: MeetProbe;
    try { probe = await (options.probe ?? probeMeetSpeakers)(options.browser, controller.signal); }
    catch { probe = { state: 'unavailable', detail: 'Meet reader unavailable; audio recording continues.' }; }
    if (stopped) return;
    const end = now();
    let snapshot = probe.state === 'connected' && end - start <= 750 ? probe.snapshot : undefined;
    if (probe.state === 'connected' && end - start > 750) probe = {
      state: 'unavailable', detail: 'Meet updates are too slow to match speech; using audio source labels.',
    };
    if (snapshot) {
      pinned ??= snapshot.meeting;
      pinnedBrowser ??= probe.browser;
      if (snapshot.meeting !== pinned || probe.browser !== pinnedBrowser) {
        snapshot = undefined;
        probe = { state: 'ambiguous', detail: 'Meet call or browser changed. Finish this recording before capturing another call’s names.' };
      }
    }
    try { write(sampleAt(snapshot, (end - origin) / 1000, probe.browser, probe.source)); }
    catch { stop(); probe = { state: 'unavailable', detail: 'Meet evidence could not be saved; audio recording continues.' }; }
    options.onStatus?.(probe);
    if (!stopped) { timer = setTimeout(poll, probe.state === 'connected' ? options.pollMs ?? 500 : 5000); timer.unref(); }
  };
  if (!stopped) void poll();
  return { stop, speakerFor: segment => segment.speaker === 'SYSTEM' ? meetSpeakerForSegment(samples, segment) : undefined };
}
