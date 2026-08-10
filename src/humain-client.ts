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
