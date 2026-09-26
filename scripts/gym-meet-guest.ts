#!/usr/bin/env bun
/** Optional real-Meet fixture. CDP is confined to a fresh, owned test browser. */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MeetGuestOptions { url: string; audio: string; name: string; seconds: number; allowLobby: boolean }
export const HELP = `Optional Google Meet guest gym (visible isolated Chrome; macOS)
Usage: bun scripts/gym-meet-guest.ts --url https://meet.google.com/abc-defg-hij --audio /path/to/test.wav [--name "Seashell Test Speaker"] [--seconds 60] [--allow-lobby]
Use a test room you own that permits anonymous guests. The WAV loops into the
meeting microphone; no physical microphone is used. Camera is disabled before
joining. Controls: m mute, u unmute, q leave/quit. Session limit: 5–300 seconds.
This does not start Seashell or prove speaker attribution. No login or extension.
--allow-lobby permits Ask to join; the host must admit the guest within 90s of startup.
`;

export function validateMeetTestUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || url.port ||
      url.username || url.password || url.search || url.hash || !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/u.test(url.pathname)) {
    throw new Error('--url must be a plain https://meet.google.com/abc-defg-hij test-room URL without query, fragment, or credentials');
  }
  return `https://meet.google.com${url.pathname.replace(/\/$/u, '')}`;
}

export function parseMeetGuestOptions(args: string[]): MeetGuestOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!['--url', '--audio', '--name', '--seconds', '--allow-lobby'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    if (flag === '--allow-lobby') { values.set(flag, 'true'); continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  if (!values.get('--url') || !values.get('--audio')) throw new Error('--url and --audio are required; use --help');
  const name = values.get('--name') ?? 'Seashell Test Speaker';
  if (!name.trim() || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error('--name must contain 1–80 printable characters');
  const seconds = Number(values.get('--seconds') ?? '60');
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) throw new Error('--seconds must be an integer from 5 to 300');
  return { url: validateMeetTestUrl(values.get('--url')!), audio: resolve(values.get('--audio')!), name: name.trim(), seconds, allowLobby: values.has('--allow-lobby') };
}

export function validateDebuggerEndpoint(raw: string, port: number, kind: 'browser' | 'page'): string {
  const url = new URL(raw);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port ||
      url.username || url.password || url.search || url.hash || !new RegExp(`^/devtools/${kind}/[A-Za-z0-9-]+$`, 'u').test(url.pathname)) {
    throw new Error('Refusing a debugger endpoint outside the isolated loopback browser');
  }
  return url.toString();
}

interface PendingCall { resolve: (value: any) => void; reject: (cause: Error) => void; timeout: ReturnType<typeof setTimeout> }
export class CdpClient {
  private nextId = 0;
  private pending = new Map<number, PendingCall>();
  private closed = false;
  constructor(private socket: Pick<WebSocket, 'send' | 'close' | 'addEventListener'>) {
    socket.addEventListener('message', (event: MessageEvent) => {
      let message: any;
      try { message = JSON.parse(String(event.data)); } catch { this.close(); return; }
      if (!message || typeof message !== 'object') { this.close(); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timeout);
      message.error ? request.reject(new Error(`Browser command failed: ${message.error.message ?? 'unknown error'}`)) : request.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending());
    socket.addEventListener('error', () => this.rejectPending());
  }
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Isolated browser disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timeout = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Browser command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timeout); this.pending.delete(id); reject(new Error('Isolated browser disconnected')); }
    });
  }
  private rejectPending() {
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Isolated browser disconnected')); }
    this.pending.clear();
  }
  close() { this.rejectPending(); this.socket.close(); }
}

async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Isolated browser debugger connection timed out')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Isolated browser debugger could not connect')); }, { once: true });
  });
  return new CdpClient(socket);
}

function audioInjection(wav: Buffer): string {
  return `(() => {
    if (!navigator.mediaDevices) return;
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let media;
    async function audio() {
      if (!media) media = (async () => {
        const ctx = new AudioContext({sampleRate:48000}); window.__seashellGuestAudio = ctx;
        const bytes = Uint8Array.from(atob(${JSON.stringify(wav.toString('base64'))}), c => c.charCodeAt(0));
        const buffer = await ctx.decodeAudioData(bytes.buffer);
        const dest = ctx.createMediaStreamDestination(), player = ctx.createBufferSource();
        player.buffer = buffer; player.loop = true; player.connect(dest); player.start();
        await ctx.resume(); return dest.stream;
      })().catch(error => { window.__seashellGuestAudioFailed = true; throw error; });
      return (await media).getAudioTracks()[0].clone();
    }
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints?.audio) return native(constraints);
      const stream = constraints.video ? await native({video:constraints.video}) : new MediaStream();
      stream.addTrack(await audio()); return stream;
    };
  })();`;
}

const stateExpression = `(() => {
  const buttons = [...document.querySelectorAll('button')];
  const label = button => button.getAttribute('aria-label') || '';
  const has = text => buttons.some(button => label(button).startsWith(text));
  const body = document.body?.innerText || '';
  return { joined: has('Leave call'), nameInput: !!document.querySelector('input[placeholder="Your name"]'),
    cameraOn: has('Turn off camera'), cameraOff: has('Turn on camera'), muted: has('Turn on microphone'),
    microphoneOn: has('Turn off microphone'), joinNow: buttons.some(button => button.innerText.trim() === 'Join now'),
    admissionRequired: buttons.some(button => button.innerText.trim() === 'Ask to join'),
    awaitingAdmission: /Asking to be let in|Asking to join|Wait until someone lets you in|Waiting for the host to let you in/i.test(body),
    rejected: /You can't join this video call|You cannot join this video call|Couldn't join|could not join|meeting code.*(invalid|expired)/i.test(body),
    signIn: /Sign in to join this (call|meeting)/i.test(body),
    audioState: window.__seashellGuestAudio?.state, audioFailed: !!window.__seashellGuestAudioFailed };
})()`;
interface GuestState { joined: boolean; nameInput: boolean; cameraOn: boolean; cameraOff: boolean; muted: boolean; microphoneOn: boolean; joinNow: boolean; admissionRequired: boolean; awaitingAdmission: boolean; rejected: boolean; signIn: boolean; audioState?: string; audioFailed: boolean }
async function evaluate<T>(page: CdpClient, expression: string): Promise<T> {
  const response = await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (response.exceptionDetails) throw new Error('The isolated Meet page could not complete the requested test action');
  return response.result?.value as T;
}
async function clickLabel(page: CdpClient, label: string): Promise<boolean> {
  return evaluate(page, `(() => { const button = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').startsWith(${JSON.stringify(label)})); if (!button || button.disabled) return false; button.click(); return true; })()`);
}
function checkState(state: GuestState, allowLobby = false): void {
  if (state.rejected) throw new Error('Google Meet rejected this guest. Use a test room you own that allows anonymous guests; no browser security settings were changed');
  if (state.signIn) throw new Error('This room requires sign-in. The isolated guest never uses your account; allow anonymous guests in a test room');
  if (state.admissionRequired && !allowLobby) throw new Error('This room requires a join request. Use --allow-lobby for manual host admission in your test room, or allow anonymous Join now access');
  if (state.audioFailed) throw new Error('Chrome could not decode the supplied WAV fixture');
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('Guest test cancelled');
  await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new Error('Guest test cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

async function stopOwnedBrowser(browser?: ChildProcess, client?: CdpClient): Promise<boolean> {
  if (!browser || !browser.pid) return true;
  const group = -browser.pid;
  const groupAlive = () => { try { process.kill(group, 0); return true; } catch { return false; } };
  try { await client?.call('Browser.close', {}, 1500); } catch { /* Chrome can close before replying. */ }
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (groupAlive() && Date.now() < deadline) await Bun.sleep(50);
  };
  await wait(1500);
  if (groupAlive()) {
    // The child owns a detached process group and fresh profile. Never match by app name.
    try { process.kill(group, 'SIGTERM'); } catch { /* Already exited. */ }
    await wait(1500);
  }
  if (groupAlive()) {
    try { process.kill(group, 'SIGKILL'); } catch { /* Already exited. */ }
    await wait(1000);
  }
  return !groupAlive();
}

export async function runMeetGuest(options: MeetGuestOptions): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('The live Meet guest gym currently requires macOS');
  const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')].find(existsSync);
  if (!chrome) throw new Error('Install Google Chrome before running the optional live guest gym');
  const audioInfo = statSync(options.audio);
  if (!audioInfo.isFile() || audioInfo.size < 44 || audioInfo.size > 24 * 1024 * 1024) {
    throw new Error('--audio must be a RIFF WAV fixture between 44 bytes and 24 MiB');
  }
  const wav = readFileSync(options.audio);
  if (wav.length < 44 || wav.length > 24 * 1024 * 1024 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('--audio must be a RIFF WAV fixture between 44 bytes and 24 MiB');
  }
  const work = mkdtempSync(join(tmpdir(), 'seashell-meet-guest-')); chmodSync(work, 0o700);
  const profile = join(work, 'profile'); mkdirSync(profile, { mode: 0o700 });
  const logRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '.gym-results', 'meet-guest');
  mkdirSync(logRoot, { recursive: true, mode: 0o700 });
  const logs = mkdtempSync(join(logRoot, 'run-')); chmodSync(logs, 0o700);
  const logFd = openSync(join(logs, 'chrome.log'), 'wx', 0o600);
  let logOpen = true;
  let browser: ChildProcess | undefined, browserClient: CdpClient | undefined, page: CdpClient | undefined;
  let joined = false, outcome = 'failed', failure: string | undefined;
  const abort = new AbortController(), startedAt = new Date().toISOString();
  let stopReason: 'user' | 'deadline' | 'browser' | undefined;
  const stop = () => { stopReason ??= 'user'; abort.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const previousRaw = process.stdin.isRaw ?? false;
  let controls: ((input: string) => void) | undefined;
  const absoluteDeadline = setTimeout(() => { stopReason = 'deadline'; failure = 'Guest test deadline expired'; stop(); }, 90_000 + options.seconds * 1000);
  try {
    browser = spawn(chrome, ['--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-crash-reporter', '--lang=en-US', '--mute-audio',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'],
      { detached: true, stdio: ['ignore', logFd, logFd] });
    closeSync(logFd); logOpen = false;
    let browserError: Error | undefined;
    browser.on('error', error => { browserError = error; failure = `Chrome could not start: ${error.message}`; stopReason = 'browser'; stop(); });
    const setupDeadline = Date.now() + 90_000;
    const activePort = join(profile, 'DevToolsActivePort');
    while (!existsSync(activePort)) {
      if (browserError) throw browserError;
      if (browser.exitCode !== null || browser.signalCode !== null) throw new Error('Isolated Chrome exited before its debugger became ready');
      if (Date.now() > setupDeadline) throw new Error('Isolated Chrome startup timed out');
      await pause(100, abort.signal);
    }
    const [rawPort, browserPath] = readFileSync(activePort, 'utf8').trim().split('\n');
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath) throw new Error('Invalid isolated Chrome debugger port file');
    browserClient = await connectCdp(validateDebuggerEndpoint(`ws://127.0.0.1:${port}${browserPath}`, port, 'browser'));
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]), redirect: 'error' });
    if (!response.ok) throw new Error('Isolated Chrome did not expose a test page');
    const pages = await response.json() as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
    const target = pages.find(value => value.type === 'page' && value.url === 'about:blank');
    if (!target?.webSocketDebuggerUrl) throw new Error('Fresh isolated Chrome test page was not found');
    page = await connectCdp(validateDebuggerEndpoint(target.webSocketDebuggerUrl, port, 'page'));
    await page.call('Page.enable');
    await page.call('Page.addScriptToEvaluateOnNewDocument', { source: audioInjection(wav) });
    await page.call('Page.navigate', { url: options.url });
    console.log('Isolated guest opened. Preparing fixture audio and disabling its camera…');
    let nameFilled = false, joinClicked = false;
    while (!joined) {
      if (Date.now() > setupDeadline) throw new Error(options.allowLobby
        ? 'Meet setup timed out after 90s. The host must admit the named test guest before this deadline; check the visible guest window'
        : 'Meet setup timed out. Check the visible guest window and use an anonymous-access test room with English controls');
      await evaluate(page, 'window.__seashellGuestAudio?.resume(); true');
      const state = await evaluate<GuestState>(page, stateExpression); checkState(state, options.allowLobby);
      if (state.joined && !state.awaitingAdmission) { joined = true; break; }
      if (state.nameInput && !nameFilled) {
        nameFilled = await evaluate(page, `(() => { const input = document.querySelector('input[placeholder="Your name"]'); if (!input) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(options.name)}); input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); return input.value === ${JSON.stringify(options.name)}; })()`);
      }
      if (state.cameraOn) await clickLabel(page, 'Turn off camera');
      const joinLabel = state.joinNow ? 'Join now' : options.allowLobby && state.admissionRequired ? 'Ask to join' : undefined;
      if (!joinClicked && nameFilled && state.cameraOff && joinLabel && state.audioState === 'running') {
        joinClicked = await evaluate(page, `(() => { if (![...document.querySelectorAll('button')].some(b => (b.getAttribute('aria-label') || '').startsWith('Turn on camera'))) return false; const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(joinLabel)}); if (!button || button.disabled) return false; button.click(); return true; })()`);
        if (joinClicked && joinLabel === 'Ask to join') console.log(`Admission requested for ${options.name}. The host must admit this guest; startup timeout is 90s.`);
      }
      await pause(250, abort.signal);
    }
    console.log(`Guest joined as ${options.name}; camera off, fixture speech looping for at most ${options.seconds}s. m mute · u unmute · q leave`);
    const sessionDeadline = Date.now() + options.seconds * 1000;
    let actions = Promise.resolve();
    controls = input => {
      for (const key of input.toLowerCase()) {
        if (key === 'q' || key === '\u0003') { stop(); return; }
        if (key !== 'm' && key !== 'u') continue;
        actions = actions.then(async () => {
          if (abort.signal.aborted || !page) return;
          const state = await evaluate<GuestState>(page, stateExpression);
          if (!state.joined) { stop(); return; }
          const mute = key === 'm';
          if ((mute && !state.muted) || (!mute && !state.microphoneOn)) await clickLabel(page, mute ? 'Turn off microphone' : 'Turn on microphone');
          await evaluate(page, 'window.__seashellGuestAudio?.resume(); true');
          const checked = await evaluate<GuestState>(page, stateExpression);
          console.log(mute ? (checked.muted ? 'Guest muted.' : 'Mute not confirmed; check guest window.') : (checked.microphoneOn ? 'Guest unmuted.' : 'Unmute not confirmed; check guest window.'));
        }).catch(error => { failure = error instanceof Error ? error.message : String(error); stop(); });
      }
    };
    process.stdin.setEncoding('utf8');
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', controls); process.stdin.resume();
    while (Date.now() < sessionDeadline && !abort.signal.aborted) {
      const state = await evaluate<GuestState>(page, stateExpression); checkState(state);
      if (!state.joined) throw new Error('Guest left or was removed before the test completed');
      await pause(500, abort.signal).catch(error => { if (!abort.signal.aborted) throw error; });
    }
    await actions;
    if (failure) throw new Error(failure);
    outcome = abort.signal.aborted ? 'stopped' : 'completed';
  } catch (error) {
    if (abort.signal.aborted && stopReason === 'user' && !failure) outcome = 'stopped';
    else { failure ??= error instanceof Error ? error.message : String(error); throw new Error(failure); }
  } finally {
    if (logOpen) closeSync(logFd);
    clearTimeout(absoluteDeadline);
    if (controls) process.stdin.removeListener('data', controls);
    if (process.stdin.isTTY) process.stdin.setRawMode(previousRaw);
    process.stdin.pause();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (joined && page) { try { await clickLabel(page, 'Leave call'); } catch { /* Browser.close also leaves. */ } }
    const cleaned = await stopOwnedBrowser(browser, browserClient);
    page?.close(); browserClient?.close();
    if (cleaned) rmSync(work, { recursive: true, force: true });
    else { outcome = 'failed'; failure ??= `Could not stop the isolated browser process group; private profile retained at ${work}`; }
    writeFileSync(join(logs, 'result.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), joined, outcome, seconds: options.seconds, ...(failure ? { error: failure } : {}) }, null, 2) + '\n', { mode: 0o600 });
    console.log(`Guest ${outcome}. Private diagnostics: ${logs}`);
    if (!cleaned) throw new Error(failure);
  }
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).includes('--help')) console.log(HELP);
    else await runMeetGuest(parseMeetGuestOptions(process.argv.slice(2)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
