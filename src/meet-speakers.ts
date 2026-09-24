import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
export interface MeetProbe { state: 'connected' | 'idle' | 'permission' | 'ambiguous' | 'unavailable'; detail: string; snapshot?: MeetSnapshot; browser?: MeetBrowser }
export interface MeetSample { at: number; meeting: string; speaker?: Speaker; browser?: MeetBrowser }
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_GAP = 1.75;

// Read-only DOM adapter. Meet has no stable public DOM contract. These known
// indicators are deliberately not auto-learned from changing CSS classes.
// Selector evidence: Vexa gmeet-speakers.ts (see docs/meet-speakers.md).
export const MEET_SPEAKER_SCRIPT = `(() => {
  if (location.origin !== 'https://meet.google.com' || !/^\\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(location.pathname)) return null;
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const joined = [...document.querySelectorAll('button, [role="button"]')].some(el =>
    /leave call/i.test(el.getAttribute('aria-label') || '') ||
    [...el.querySelectorAll('i, span')].some(icon => icon.textContent.trim() === 'call_end'));
  const self = document.querySelector('[data-self-name]');
  const selfId = self?.closest('[data-participant-id]')?.getAttribute('data-participant-id');
  const participants = [];
  for (const tile of document.querySelectorAll('[data-participant-id]')) {
    if (!visible(tile) || participants.length >= 100) continue;
    const marker = tile.matches('[data-self-name]') ? tile : tile.querySelector('[data-self-name]');
    const id = tile.getAttribute('data-participant-id');
    const name = (marker?.getAttribute('data-self-name') || tile.querySelector('span.notranslate')?.textContent || '').trim();
    if (!id || name.length > 100) continue;
    const speaking = ['Oaajhc', 'HX2H7', 'wEsLMd', 'OgVli'].some(cls =>
      tile.classList.contains(cls) || [...tile.querySelectorAll('.' + cls)].some(visible));
    participants.push({id, name, self: Boolean(marker || id === selfId), speaking});
  }
  return JSON.stringify({meeting: location.pathname, joined, participants});
})()`;

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

export function meetPermissionHelp(browser: MeetBrowserMode): string {
  if (browser === 'auto') return 'Chrome and Safari are detected automatically. Join a call and check the connection for browser-specific permission instructions.';
  return browser === 'chrome'
    ? 'Chrome: View → Developer → Allow JavaScript from Apple Events. Also allow your terminal to control Chrome in macOS Privacy & Security → Automation.'
    : 'Safari: Settings → Advanced → Show features for web developers; Develop → Allow JavaScript from Apple Events. Also allow your terminal to control Safari in macOS Privacy & Security → Automation.';
}

function appleString(value: string): string { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`; }

// Filter landing/help pages before requesting JavaScript access in that browser.
export const MEET_CALL_URL_GUARD = `on isMeetCall(candidateURL)
 if candidateURL does not start with "https://meet.google.com/" then return false
 if (length of candidateURL) < 36 then return false
 set code to text 25 thru 36 of candidateURL
 repeat with i from 1 to 12
  set c to character i of code
  if i is 4 or i is 9 then
   if c is not "-" then return false
  else
   if "abcdefghijklmnopqrstuvwxyz" does not contain c then return false
  end if
 end repeat
 if (length of candidateURL) > 36 then
  if character 37 of candidateURL is not "?" and character 37 of candidateURL is not "#" then return false
 end if
 return true
end isMeetCall`;

/** Only inspect existing Meet tabs; never launch a browser. */
async function probeMeetBrowser(browser: MeetBrowser, signal?: AbortSignal): Promise<MeetProbe> {
  if (process.platform !== 'darwin') return { state: 'unavailable', detail: 'Meet names currently require macOS.' };
  const app = browser === 'chrome' ? 'Google Chrome' : 'Safari';
  // Check without loading an application dictionary: on Safari-only Macs,
  // compiling a Chrome AppleScript can otherwise ask the user to locate Chrome.
  const running = await new Promise<boolean | undefined>((resolve) => {
    execFile('/usr/bin/pgrep', ['-x', app], { timeout: 500, maxBuffer: 16 * 1024, signal },
      (error, stdout) => resolve(!error ? Boolean(stdout.trim()) : error.code === 1 ? false : undefined));
  });
  if (signal?.aborted) return { state: 'unavailable', detail: 'Meet connection check cancelled.' };
  if (running === undefined) return { state: 'unavailable', detail: `Could not check whether ${app} is running; names are paused.` };
  if (!running) return { state: 'idle', detail: `Join a Google Meet call in ${app} to check speaker names.` };
  const command = browser === 'chrome' ? `execute t javascript ${appleString(MEET_SPEAKER_SCRIPT)}`
    : `do JavaScript ${appleString(MEET_SPEAKER_SCRIPT)} in t`;
  const script = `${MEET_CALL_URL_GUARD}
with timeout of 2 seconds
if application "${app}" is not running then return ""
set output to ""
set countRead to 0
tell application "${app}"
 repeat with w in windows
  repeat with t in tabs of w
   if my isMeetCall(URL of t) then
    set countRead to countRead + 1
    if countRead > 8 then return "TOO_MANY_TABS"
    set value to ${command}
    if value is not missing value then set output to output & value & linefeed
   end if
  end repeat
 end repeat
end tell
return output
end timeout`;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/osascript', ['-e', script], { timeout: 2500, maxBuffer: 256 * 1024, signal },
        (error, output) => error ? reject(error) : resolve(output));
    });
    if (stdout.includes('TOO_MANY_TABS')) return { state: 'ambiguous', detail: 'Too many Meet tabs; keep only the call you want to record open.' };
    const snapshots: MeetSnapshot[] = [];
    for (const line of stdout.split('\n').filter(line => line.trim() && line.trim() !== 'null')) {
      const snapshot = parseMeetSnapshot(JSON.parse(line));
      if (!snapshot) return { state: 'unavailable', detail: 'Meet page layout is unsupported; using audio source labels.' };
      if (snapshot.joined) snapshots.push(snapshot);
    }
    if (snapshots.length > 1) return { state: 'ambiguous', detail: 'More than one joined Meet tab; names paused until only one remains.' };
    const snapshot = snapshots[0];
    if (!snapshot) return { state: 'idle', detail: 'Join a Google Meet call to check speaker names.' };
    if (!snapshot.participants.length) return { state: 'unavailable', snapshot, detail: 'Meet tiles not readable. Show participant tiles; source labels remain available.' };
    const active = snapshot.participants.filter(p => !p.self && p.speaking);
    return { state: 'connected', snapshot, detail: active.length === 1 && active[0]!.name
      ? `Meet hint: ${active[0]!.name}` : active.length > 1 ? 'Meet connected · overlapping speakers'
        : `Meet connected · ${snapshot.participants.length} visible participants · waiting for speaker signal` };
  } catch (error) {
    const message = String(error);
    return /JavaScript|Apple Events|not authorized|not allowed|-1743/iu.test(message)
      ? { state: 'permission', detail: meetPermissionHelp(browser) }
      : { state: 'unavailable', detail: 'Meet reader unavailable; audio recording continues. Check the connection in [V] Speakers.' };
  }
}

/** Check both browsers concurrently. An unreadable second browser is not proof
 * that it has no call; fail closed instead of attaching its mixed audio to a name. */
export async function probeMeetSpeakers(
  mode: MeetBrowserMode,
  signal?: AbortSignal,
  read: (browser: MeetBrowser, signal?: AbortSignal) => Promise<MeetProbe> = probeMeetBrowser,
): Promise<MeetProbe> {
  if (signal?.aborted) return { state: 'unavailable', detail: 'Meet connection check cancelled.' };
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

function sampleAt(snapshot: MeetSnapshot | undefined, at: number, browser?: MeetBrowser): MeetSample {
  const remote = snapshot?.participants.filter(p => p.speaking && !p.self) ?? [];
  const one = remote.length === 1 && remote[0]!.name ? remote[0] : undefined;
  return { at, meeting: snapshot?.meeting ?? '', ...(snapshot && browser ? { browser } : {}), ...(one ? { speaker: {
    id: `MEET_${createHash('sha256').update(`${snapshot!.meeting}\0${one.id}`).digest('hex').slice(0, 20)}`,
    label: one.name,
  } } : {}) };
}

/** Only bridge adjacent, matching observations; never carry names across gaps,
 * overlap, pause, a changed call, or a browser failure. */
export function meetSpeakerForSegment(samples: readonly MeetSample[], segment: Pick<TranscriptSegment, 'start' | 'end'>): Speaker | undefined {
  if (!Number.isFinite(segment.start) || segment.end <= segment.start) return;
  let matched: Speaker | undefined;
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
        a.meeting !== b.meeting || a.browser !== b.browser || a.speaker.id !== b.speaker.id || a.speaker.label !== b.speaker.label) return;
    if (matched && matched.id !== a.speaker.id) return;
    matched = a.speaker; coverage += overlap;
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
      samples.push({ at: raw.at, meeting: raw.meeting, ...(raw.browser ? { browser: raw.browser } : {}),
        ...(raw.speaker ? { speaker: { id: raw.speaker.id, label: raw.speaker.label } } : {}) });
      if (samples.length > 100_000) return [];
    }
    return samples;
  } catch { return []; } // A damaged optional sidecar must not lose the audio transcript.
}

export interface MeetSpeakerReader { stop(): void; speakerFor(segment: TranscriptSegment): Speaker | undefined }
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
    try { write(sampleAt(snapshot, (end - origin) / 1000, probe.browser)); }
    catch { stop(); probe = { state: 'unavailable', detail: 'Meet evidence could not be saved; audio recording continues.' }; }
    options.onStatus?.(probe);
    if (!stopped) { timer = setTimeout(poll, probe.state === 'connected' ? options.pollMs ?? 500 : 5000); timer.unref(); }
  };
  if (!stopped) void poll();
  return { stop, speakerFor: segment => segment.speaker === 'SYSTEM' ? meetSpeakerForSegment(samples, segment) : undefined };
}
