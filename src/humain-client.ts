import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  beginManagedProcessSession,
  trackChildProcess,
  trackTempDirectory,
} from './process-lifecycle.ts';

export type HumainMeetingAction = 'observe' | 'reconcile' | 'chat';
export type HumainBackend = 'codex' | 'claude-code' | 'openrouter';

export interface HumainMeetingRoute {
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
  const installed = Bun.which('humain', { PATH: env.PATH ?? '' });
  if (installed) return { command: installed, prefix: [] };
  const developmentCli = join(homedir(), 'Developer', 'humain-engine', 'dist', 'cli.js');
  if (existsSync(developmentCli)) {
    return {
      command: 'node',
      prefix: [developmentCli],
      cwd: dirname(dirname(developmentCli)),
    };
  }
  throw new Error(
    'Humain is not available. Install its CLI or set HUMAIN_CLI to humain-engine/dist/cli.js.',
  );
}

function parseResult(stdout: string, runId: string): HumainMeetingResult {
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
    result.runId !== runId ||
    typeof result.compiledRunId !== 'string' || !result.compiledRunId.trim()
  ) {
    throw new Error(`Humain meeting run did not succeed${
      typeof result.status === 'string' ? ` (${result.status})` : ''
    }`);
  }
  return result as unknown as HumainMeetingResult;
}

function parseTranscriptionResult(stdout: string, runId: string, model: string): HumainTranscriptionResult {
  const result = parseResult(stdout, runId);
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
  args: string[], options: HumainRunOptions, maxOutputBytes: number,
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
  return parseTranscriptionResult(stdout, options.runId, route.model);
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
    return parseResult(stdout, options.runId);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
    stopTrackingTemp();
  }
}

export function humainRouteRequest(route: HumainMeetingRoute) {
  return {
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
