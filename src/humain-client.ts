import { installedHumainCli, requireHumainNode } from './humain-install.ts';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  beginManagedProcessSession,
  trackChildProcess,
  trackTempDirectory,
} from './process-lifecycle.ts';

/**
 * extract runs one owner-written extractor over a finished meeting. brief
 * prepares the owner for an upcoming meeting from past ones; draft writes a
 * follow-up email or Slack message from one meeting. Both need revision 4.
 */
export type HumainMeetingAction = 'observe' | 'reconcile' | 'chat' | 'extract' | 'brief' | 'draft';
export type HumainBackend = 'codex' | 'claude-code' | 'openrouter' | 'local-openai';

export interface HumainMeetingRoute {
  effort?: ModelEffort;
  backend: HumainBackend;
  model: string;
  maxOutputTokens?: number;
  maxBudgetMicrousd?: number;
  maxCostMicrousd?: number;
}

export interface HumainMeetingResult {
  runId: string;
  compiledRunId: string;
  status: 'succeeded';
  output: unknown;
  receipt: unknown;
}

export interface HumainTranscriptionRoute {
  readonly model: string;
  readonly upstreamProvider?: string;
  readonly maxCostMicrousd?: number;
  /** Explicit durable consent to upload audio through the configured route. */
  readonly uploadConsent: true;
}

export interface HumainTranscriptSegment {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface HumainTranscriptionResult extends HumainMeetingResult {
  readonly output: {
    readonly segments: readonly HumainTranscriptSegment[];
    readonly provider: { readonly boundary: 'remote'; readonly model: string };
  };
}

interface HumainExecutable {
  command: string;
  prefix: string[];
  cwd?: string;
}

function configuredHumainExecutable(env: NodeJS.ProcessEnv): HumainExecutable | undefined {
  const configured = env.HUMAIN_CLI?.trim();
  if (!configured) return undefined;
  const path = resolve(configured);
  if (!existsSync(path)) throw new Error(`HUMAIN_CLI does not exist: ${path}`);
  return path.endsWith('.js')
    ? { command: 'node', prefix: [path], cwd: dirname(dirname(path)) }
    : { command: path, prefix: [] };
}

export function resolveHumainExecutable(
  env: NodeJS.ProcessEnv = process.env,
): HumainExecutable {
  env = { ...process.env, ...env };
  const configured = configuredHumainExecutable(env);
  if (configured) return configured;
  const packaged = installedHumainCli(env);
  if (packaged) return { command: 'node', prefix: [packaged], cwd: dirname(dirname(packaged)) };
  const installed = Bun.which('humain', { PATH: env.PATH ?? '' });
  if (installed) return { command: installed, prefix: [] };
  throw new Error(
    'Humain is not available. Run seashell ai install <humain-package.tgz>, or install its CLI.',
  );
}

function parseResult(stdout: string): HumainMeetingResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Humain returned malformed JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Humain returned an invalid result');
  }
  const result = value as Record<string, unknown>;
  if (
    result.status !== 'succeeded' ||
    typeof result.runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(result.runId) ||
    typeof result.compiledRunId !== 'string' || !result.compiledRunId.trim()
  ) {
    throw new Error(`Humain meeting run did not succeed${
      typeof result.status === 'string' ? ` (${result.status})` : ''
    }`);
  }
  // Humain owns idempotency: a successful replay returns the original run ID,
  // even if this invocation proposed a different ID. Bind to its receipt.
  const receipt = result.receipt as Record<string, unknown> | undefined;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      receipt.runId !== result.runId || receipt.compiledRunId !== result.compiledRunId ||
      receipt.status !== 'succeeded') {
    throw new Error('Humain result does not match its durable run receipt');
  }
  return result as unknown as HumainMeetingResult;
}

function parseTranscriptionResult(stdout: string, model: string): HumainTranscriptionResult {
  const result = parseResult(stdout);
  const output = result.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Humain transcription returned no artifact');
  }
  const artifact = output as Record<string, unknown>;
  if (!Array.isArray(artifact.segments) || !artifact.provider ||
      typeof artifact.provider !== 'object' || Array.isArray(artifact.provider) ||
      (artifact.provider as Record<string, unknown>).boundary !== 'remote') {
    throw new Error('Humain transcription artifact is incompatible');
  }
  if ((artifact.provider as Record<string, unknown>).model !== model) {
    throw new Error('Humain transcription returned a different model');
  }
  const ids = new Set<string>();
  for (const [index, raw] of artifact.segments.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Humain transcription segment ${index} is invalid`);
    }
    const segment = raw as Record<string, unknown>;
    if (typeof segment.id !== 'string' || !segment.id.trim() || ids.has(segment.id) ||
        typeof segment.text !== 'string' || !segment.text.trim() ||
        !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) ||
        Number(segment.startMs) < 0 || Number(segment.endMs) < Number(segment.startMs)) {
      throw new Error(`Humain transcription segment ${index} is invalid`);
    }
    ids.add(segment.id as string);
  }
  return result as HumainTranscriptionResult;
}

export interface HumainRunOptions {
  readonly storeDir: string;
  readonly runId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onStatus?: (message: string) => void;
}

/** Bound every CLI call, including a stuck provider or a child ignoring SIGTERM. */
async function runHumainCommand(
  args: string[], options: Omit<HumainRunOptions, 'storeDir' | 'runId'>, maxOutputBytes: number,
): Promise<string> {
  if (options.signal?.aborted) throw new Error('Humain run was cancelled before start');
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid Humain timeout');
  const executable = resolveHumainExecutable(options.env);
  const endManagedSession = beginManagedProcessSession();
  try {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(executable.command, [...executable.prefix, ...args], {
        ...(executable.cwd === undefined ? {} : { cwd: executable.cwd }),
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const untrack = trackChildProcess(child);
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let failure: Error | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        escalation ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2_000);
        escalation.unref();
      };
      const timeout = setTimeout(() => stop(new Error('Humain run timed out')), timeoutMs);
      timeout.unref();
      const onAbort = () => stop(new Error('Humain run was cancelled'));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (data: string) => {
        outputBytes += Buffer.byteLength(data);
        if (outputBytes > maxOutputBytes) stop(new Error('Humain output exceeded its size limit'));
        else stdout += data;
      });
      child.stderr?.on('data', (data: string) => { stderr = (stderr + data).slice(-32_000); });
      child.once('error', (error) => { failure ??= new Error(`Could not start Humain: ${error.message}`); });
      // close follows error for failed spawns and drains both output streams.
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        untrack();
        options.signal?.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Humain failed: ${
          stderr.trim() || (signal ? `signal ${signal}` : `exit ${code}`)
        }`));
        else resolvePromise(stdout);
      });
    });
  } finally {
    endManagedSession();
  }
}

export async function runHumainTranscription(
  audioFile: string,
  route: HumainTranscriptionRoute,
  options: HumainRunOptions,
): Promise<HumainTranscriptionResult> {
  if (route.uploadConsent !== true) throw new Error('Cloud transcription requires explicit uploadConsent');
  if (typeof route.model !== 'string' || !route.model.trim()) throw new Error('Cloud transcription requires an exact model');
  const stdout = await runHumainCommand([
    'transcribe', resolve(audioFile), '--provider', 'openrouter', '--model', route.model,
    ...(route.upstreamProvider === undefined ? [] : ['--upstream-provider', route.upstreamProvider]),
    ...(route.maxCostMicrousd === undefined ? [] : ['--max-cost-microusd', String(route.maxCostMicrousd)]),
    '--approve-upload', '--store', resolve(options.storeDir), '--run-id', options.runId,
  ], options, 32_000_000);
  return parseTranscriptionResult(stdout, route.model);
}

export async function runHumainMeeting(
  action: HumainMeetingAction,
  request: unknown,
  options: HumainRunOptions,
): Promise<HumainMeetingResult> {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'seashell-humain-'));
  const stopTrackingTemp = trackTempDirectory(tempDirectory);
  try {
    const requestPath = join(tempDirectory, 'request.json');
    writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    options.onStatus?.(`Humain ${action}…`);
    const stdout = await runHumainCommand([
      'meeting', action, requestPath, '--store', resolve(options.storeDir), '--run-id', options.runId,
    ], options, 4_000_000);
    return parseResult(stdout);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
    stopTrackingTemp();
  }
}

export function humainRouteRequest(route: HumainMeetingRoute) {
  return {
    ...(route.effort === undefined ? {} : { effort: route.effort }),
    backend: route.backend,
    model: route.model,
    ...(route.maxOutputTokens === undefined ? {} : { maxOutputTokens: route.maxOutputTokens }),
    ...(route.maxBudgetMicrousd === undefined
      ? {}
      : { maxBudgetMicrousd: route.maxBudgetMicrousd }),
    ...(route.maxCostMicrousd === undefined
      ? {}
      : { maxCostMicrousd: route.maxCostMicrousd }),
  };
}

/** Read-only provider discovery using the same installed engine as meeting calls. */
export async function discoverHumainProviders(env?: NodeJS.ProcessEnv, options: { signal?: AbortSignal } = {}): Promise<{
  integrations: { id: string; ready: boolean; detail: string; nextStep?: string }[];
}> {
  const stdout = await runHumainCommand(['setup', '--json'], { env, signal: options.signal, timeoutMs: 45_000 }, 1_000_000);
  const value = JSON.parse(stdout);
  if (!value || !Array.isArray(value.integrations) || value.integrations.some((item: any) =>
    !item || typeof item.id !== 'string' || typeof item.ready !== 'boolean' || typeof item.detail !== 'string' ||
    (item.nextStep !== undefined && typeof item.nextStep !== 'string'))) {
    throw new Error('Humain returned incompatible provider discovery data');
  }
  return value;
}

export const MODEL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = typeof MODEL_EFFORTS[number];
export interface HumainModelOption {
  id: string;
  name: string;
  description: string;
  efforts: ModelEffort[];
  defaultEffort?: ModelEffort;
  isDefault?: boolean;
}

/** Catalog metadata only; never submit a prompt to discover a model. */
export async function discoverHumainModels(backend: HumainBackend, options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<HumainModelOption[]> {
  const stdout = await runHumainCommand(['models', 'list', '--provider', backend, '--limit', '100', '--json'],
    { env: options.env, signal: options.signal, timeoutMs: 25_000 }, 2_000_000);
  const value = JSON.parse(stdout);
  const rows = backend === 'local-openai' ? (Array.isArray(value?.modelIds) ? value.modelIds.map((id: unknown) => ({ id })) : undefined) : value?.models;
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error('Humain returned an incompatible model catalog. Update Humain or enter a custom model.');
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500);
  const seen = new Set<string>();
  return rows.flatMap((row: any) => {
    if (typeof row?.id !== 'string' || !row.id.trim() || row.id.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(row.id) || seen.has(row.id)) return [];
    seen.add(row.id);
    const native = backend === 'codex' || backend === 'claude-code';
    const efforts = native && Array.isArray(row.efforts) ? row.efforts.filter((e: ModelEffort) => MODEL_EFFORTS.includes(e)) : [];
    return [{ id: row.id, name: typeof row.name === 'string' ? clean(row.name) : row.id,
      description: typeof row.description === 'string' ? clean(row.description) : '', efforts,
      ...(efforts.includes(row.defaultEffort) ? { defaultEffort: row.defaultEffort } : {}), isDefault: row.isDefault === true }];
  });
}

/** Why a route could not answer, in Humain's terms. */
export type HumainRouteFailureKind = 'not-signed-in' | 'model-missing' | 'timeout' | 'provider-error';

export interface HumainRouteProbe {
  ok: boolean;
  backend: HumainBackend;
  model: string;
  latencyMs?: number;
  failure?: { kind: HumainRouteFailureKind; message: string };
}

const ROUTE_FAILURE_KINDS: readonly HumainRouteFailureKind[] = ['not-signed-in', 'model-missing', 'timeout', 'provider-error'];

/** The probe sends Humain's own fixed, harmless prompt; never any meeting text. */
export function humainRouteProbeArgs(route: HumainMeetingRoute, timeoutMs: number): string[] {
  return ['doctor', 'route', '--backend', route.backend, '--model', route.model,
    ...(route.effort === undefined ? [] : ['--effort', route.effort]), '--timeout-ms', String(timeoutMs)];
}

/** An engine from before a command prints its usage instead of running it. */
export function olderHumainEngine(message: string): boolean {
  return /usage: humain|unknown (?:command|subcommand|option)|is not supported/iu.test(message);
}

/** What to do about an engine too old for something, in the words every surface uses. */
export const NEWER_ENGINE = 'Install a newer AI engine: seashell ai install <humain-package.tgz>';

/** The meeting actions an engine lists in its usage line: "humain meeting observe|reconcile|chat|extract <request.json>". */
export function parseMeetingActions(message: string): ReadonlySet<string> | undefined {
  const listed = /humain meeting ((?:[a-z-]+\|)+[a-z-]+)/iu.exec(message)?.[1];
  return listed ? new Set(listed.toLowerCase().split('|')) : undefined;
}

/** Reads the installed engine's meeting actions; undefined when it cannot say. */
export type MeetingEngineCheck = () => Promise<ReadonlySet<string> | undefined>;

const engineActions = new Map<string, ReadonlySet<string> | undefined>();

/**
 * The meeting actions the installed engine knows, from the usage line in its
 * own script. Running it would say the same, but the engine checks every
 * provider first, which takes many seconds; reading the file takes none, and
 * no prompt is sent. Read once per engine file.
 */
export const meetingEngineActions: MeetingEngineCheck = async (env: NodeJS.ProcessEnv = process.env) => {
  let script: string;
  try {
    const executable = resolveHumainExecutable(env);
    script = executable.prefix[0] ?? executable.command;
  } catch { return undefined; }
  try {
    const { mtimeMs, size } = statSync(script);
    const key = `${script}:${mtimeMs}:${size}`;
    if (!engineActions.has(key)) {
      engineActions.set(key, size <= 64 * 1024 * 1024 ? parseMeetingActions(readFileSync(script, 'latin1')) : undefined);
    }
    return engineActions.get(key);
  } catch { return undefined; }
};

/**
 * Revision 4 brought briefs, drafts, the owner's notes and vocabulary together,
 * so an engine whose usage lists no brief has none of them. An engine that
 * cannot say is taken to be current: what it refuses, it refuses plainly.
 */
export async function olderThanRevision4(check: MeetingEngineCheck): Promise<boolean> {
  const actions = await check().catch(() => undefined);
  return actions !== undefined && !actions.has('brief');
}

export function parseHumainRouteProbe(stdout: string, route: HumainMeetingRoute): HumainRouteProbe {
  let value: any;
  try { value = JSON.parse(stdout); } catch { throw new Error('Humain returned malformed JSON'); }
  const failure = value?.failure;
  if (!value || typeof value.ok !== 'boolean' || value.backend !== route.backend || value.model !== route.model ||
      (value.latencyMs !== undefined && (!Number.isFinite(value.latencyMs) || value.latencyMs < 0)) ||
      (failure !== undefined && (!ROUTE_FAILURE_KINDS.includes(failure?.kind) || typeof failure?.message !== 'string')) ||
      (!value.ok && failure === undefined)) {
    throw new Error('Humain returned an incompatible connection test result');
  }
  return {
    ok: value.ok, backend: route.backend, model: route.model,
    ...(value.latencyMs === undefined ? {} : { latencyMs: Math.round(value.latencyMs) }),
    ...(failure === undefined ? {} : { failure: { kind: failure.kind, message: failure.message.slice(0, 500) } }),
  };
}

/**
 * One tiny fixed prompt through one route. A failure is a result, never a
 * throw. Humain stops waiting at `timeoutMs`; the process gets a little longer
 * so Humain can say so itself.
 */
export async function probeHumainRoute(
  route: HumainMeetingRoute,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HumainRouteProbe> {
  const timeoutMs = Math.min(300_000, Math.max(1_000, options.timeoutMs ?? 60_000));
  try {
    const stdout = await runHumainCommand(humainRouteProbeArgs(route, timeoutMs), { ...options, timeoutMs: timeoutMs + 15_000 }, 100_000);
    return parseHumainRouteProbe(stdout, route);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, backend: route.backend, model: route.model, failure: message === 'Humain run timed out'
      ? { kind: 'timeout', message: `Humain itself did not answer within ${Math.round(timeoutMs / 1000) + 15} seconds.` }
      : olderHumainEngine(message)
        ? { kind: 'provider-error', message: 'This Humain version cannot test connections yet. Install a newer engine: seashell ai install <humain-package.tgz>' }
        : { kind: 'provider-error', message: message.slice(0, 500) } };
  }
}

export type MeetingAiRole = 'observer' | 'reconciliation' | 'chat';

export interface MeetingAiRouteTest {
  roles: MeetingAiRole[];
  backend: HumainBackend;
  model: string;
  ok: boolean;
  latencyMs?: number;
  failure?: { kind: HumainRouteFailureKind | 'engine-missing'; message: string };
  /** One plain sentence for the person: what is wrong and what to do. */
  reason?: string;
}

export interface MeetingAiTest {
  ok: boolean;
  engine: { ready: boolean; detail?: string };
  routes: MeetingAiRouteTest[];
}

const PROVIDER_NAMES: Record<HumainBackend, string> = {
  codex: 'Codex', 'claude-code': 'Claude Code', openrouter: 'OpenRouter', 'local-openai': 'Your local model server',
};

function plainReason(kind: NonNullable<MeetingAiRouteTest['failure']>['kind'],
  route: { backend: HumainBackend; model: string }, message: string): string {
  const provider = PROVIDER_NAMES[route.backend];
  const detail = message.trim() ? ` ${message.trim()}` : '';
  switch (kind) {
    case 'engine-missing': return message;
    case 'not-signed-in': return `${provider} is not signed in.${detail}`;
    case 'model-missing': return `${provider} does not offer the model "${route.model}". Choose another in Settings (,) or with seashell ai setup.${detail}`;
    case 'timeout': return `${provider} did not answer in time.${detail}`;
    default: return `${provider} could not answer.${detail}`;
  }
}

/**
 * Check every meeting AI route that is in use: the engine first, then one
 * fixed prompt per distinct provider and model. Roles sharing a route share
 * one test. `mode` decides whether live analysis and final notes are in use.
 */
export async function testMeetingAi(
  routes: Partial<Record<MeetingAiRole, HumainMeetingRoute>>,
  options: {
    mode?: 'streaming' | 'post-session' | 'hybrid';
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Seams for tests: no engine is started and no prompt is sent. */
    checkEngine?: () => void;
    probe?: typeof probeHumainRoute;
  } = {},
): Promise<MeetingAiTest> {
  const mode = options.mode ?? 'hybrid';
  const inUse: MeetingAiRole[] = [
    ...(mode !== 'post-session' ? ['observer' as const] : []),
    ...(mode !== 'streaming' ? ['reconciliation' as const] : []),
    'chat',
  ];
  const distinct = new Map<string, { route: HumainMeetingRoute; roles: MeetingAiRole[] }>();
  for (const role of inUse) {
    const route = routes[role];
    if (!route) continue;
    const key = JSON.stringify([route.backend, route.model, route.effort ?? null]);
    const entry = distinct.get(key) ?? { route, roles: [] };
    entry.roles.push(role);
    distinct.set(key, entry);
  }
  try {
    if (options.checkEngine) options.checkEngine();
    else { resolveHumainExecutable(options.env); requireHumainNode({ ...process.env, ...options.env }); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, engine: { ready: false, detail: message }, routes: [...distinct.values()].map(({ route, roles }) => ({
      roles, backend: route.backend, model: route.model, ok: false,
      failure: { kind: 'engine-missing', message }, reason: message,
    })) };
  }
  const probe = options.probe ?? probeHumainRoute;
  const results: MeetingAiRouteTest[] = [];
  for (const { route, roles } of distinct.values()) {
    const result = await probe(route, { env: options.env, signal: options.signal, timeoutMs: options.timeoutMs });
    results.push({ roles, backend: route.backend, model: route.model, ok: result.ok,
      ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      ...(result.failure ? { failure: result.failure, reason: plainReason(result.failure.kind, route, result.failure.message) } : {}) });
  }
  return { ok: results.length > 0 && results.every((result) => result.ok), engine: { ready: true }, routes: results };
}
