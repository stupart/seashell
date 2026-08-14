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
  const configured = configuredHumainExecutable(env);
  if (configured) return configured;
  const installed = Bun.which('humain');
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
    typeof result.runId !== 'string' ||
    typeof result.compiledRunId !== 'string'
  ) {
    throw new Error(`Humain meeting run did not succeed${
      typeof result.status === 'string' ? ` (${result.status})` : ''
    }`);
  }
  return result as unknown as HumainMeetingResult;
}

function parseTranscriptionResult(stdout: string): HumainTranscriptionResult {
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
  for (const [index, raw] of artifact.segments.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Humain transcription segment ${index} is invalid`);
    }
    const segment = raw as Record<string, unknown>;
    if (typeof segment.text !== 'string' || !segment.text.trim() ||
        !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) ||
        Number(segment.startMs) < 0 || Number(segment.endMs) < Number(segment.startMs)) {
      throw new Error(`Humain transcription segment ${index} is invalid`);
    }
  }
  return result as HumainTranscriptionResult;
}

export async function runHumainTranscription(
  audioFile: string,
  route: HumainTranscriptionRoute,
  options: {
    readonly storeDir: string;
    readonly runId: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
  },
): Promise<HumainTranscriptionResult> {
  const executable = resolveHumainExecutable(options.env);
  if (options.signal?.aborted) throw new Error('Humain transcription was cancelled before start');
  const endManagedSession = beginManagedProcessSession();
  try {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(executable.command, [
        ...executable.prefix,
        'transcribe',
        resolve(audioFile),
        '--provider',
        'openrouter',
        '--model',
        route.model,
        ...(route.upstreamProvider === undefined
          ? []
          : ['--upstream-provider', route.upstreamProvider]),
        ...(route.maxCostMicrousd === undefined
          ? []
          : ['--max-cost-microusd', String(route.maxCostMicrousd)]),
        '--approve-upload',
        '--store',
        options.storeDir,
        '--run-id',
        options.runId,
      ], {
        ...(executable.cwd === undefined ? {} : { cwd: executable.cwd }),
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stopTrackingChild = trackChildProcess(child);
      let stdout = '';
      let stderr = '';
      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        escalation ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2_000);
        escalation.unref();
      };
      const onAbort = () => stop();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (data: Buffer) => { stdout = (stdout + data.toString()).slice(-32_000_000); });
      child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-32_000); });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        stopTrackingChild();
        options.signal?.removeEventListener('abort', onAbort);
        reject(new Error(`Could not start Humain transcription: ${error.message}`));
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (escalation) clearTimeout(escalation);
        stopTrackingChild();
        options.signal?.removeEventListener('abort', onAbort);
        if (options.signal?.aborted) {
          reject(new Error('Humain transcription was cancelled'));
        } else if (code !== 0) {
          reject(new Error(`Humain transcription failed: ${
            stderr.trim() || stdout.trim() || (signal ? `signal ${signal}` : `exit ${code}`)
          }`));
        } else {
          try { resolvePromise(parseTranscriptionResult(stdout)); } catch (error) { reject(error); }
        }
      });
    });
  } finally {
    endManagedSession();
  }
}

export async function runHumainMeeting(
  action: HumainMeetingAction,
  request: unknown,
  options: {
    storeDir: string;
    runId: string;
    env?: NodeJS.ProcessEnv;
    onStatus?: (message: string) => void;
  },
): Promise<HumainMeetingResult> {
  const executable = resolveHumainExecutable(options.env);
  const endManagedSession = beginManagedProcessSession();
  const tempDirectory = mkdtempSync(join(tmpdir(), 'seashell-humain-'));
  const stopTrackingTemp = trackTempDirectory(tempDirectory);
  const requestPath = join(tempDirectory, 'request.json');
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  options.onStatus?.(`Humain ${action}…`);

  try {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(executable.command, [
        ...executable.prefix,
        'meeting',
        action,
        requestPath,
        '--store',
        options.storeDir,
        '--run-id',
        options.runId,
      ], {
        ...(executable.cwd === undefined ? {} : { cwd: executable.cwd }),
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stopTrackingChild = trackChildProcess(child);
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout?.on('data', (data) => {
        stdout = (stdout + data.toString()).slice(-4_000_000);
      });
      child.stderr?.on('data', (data) => {
        stderr = (stderr + data.toString()).slice(-32_000);
      });
      child.on('error', (error) => {
        stopTrackingChild();
        if (settled) return;
        settled = true;
        reject(new Error(`Could not start Humain: ${error.message}`));
      });
      child.on('close', (code, signal) => {
        stopTrackingChild();
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || (signal ? `signal ${signal}` : `exit ${code}`);
          reject(new Error(`Humain ${action} failed: ${detail}`));
          return;
        }
        try {
          resolvePromise(parseResult(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
    stopTrackingTemp();
    endManagedSession();
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
