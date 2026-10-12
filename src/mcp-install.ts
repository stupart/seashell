import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MEETINGS_SKILL = join(PROJECT_ROOT, 'skills', 'seashell-meetings', 'SKILL.md');

export interface McpClientInstall {
  readonly client: 'claude-code' | 'codex';
  readonly status: 'installed' | 'already-installed' | 'not-found' | 'failed';
  readonly detail: string;
}

export interface MeetingsMcpInstallResult {
  readonly command: readonly string[];
  readonly clients: readonly McpClientInstall[];
  readonly skills: readonly string[];
}

export interface MeetingsMcpInstallOptions {
  readonly runner?: typeof spawnSync;
  readonly which?: (command: string) => string | null;
  readonly home?: string;
  readonly skillSource?: string;
}

/** How agents start the server: the installed `seashell`, else this checkout. */
export function meetingsMcpCommand(which: (command: string) => string | null = Bun.which): string[] {
  const installed = which('seashell');
  return installed ? [installed, 'mcp'] : [process.execPath, 'run', join(PROJECT_ROOT, 'src', 'cli.tsx'), 'mcp'];
}

/**
 * Register the read-only meetings server with Claude Code and Codex at user
 * scope, using each tool's own `mcp add`, and install the usage skill. Running
 * it again leaves existing registrations alone.
 */
export function installMeetingsMcp(options: MeetingsMcpInstallOptions = {}): MeetingsMcpInstallResult {
  const runner = options.runner ?? spawnSync;
  const which = options.which ?? Bun.which;
  const home = options.home ?? homedir();
  const command = meetingsMcpCommand(which);
  const clients: McpClientInstall[] = [];
  for (const [client, binary, add] of [
    ['claude-code', 'claude', ['mcp', 'add', '--scope', 'user', 'seashell', '--', ...command]],
    ['codex', 'codex', ['mcp', 'add', 'seashell', '--', ...command]],
  ] as const) {
    const path = which(binary);
    if (!path) { clients.push({ client, status: 'not-found', detail: `${binary} is not installed` }); continue; }
    const existing = runner(path, ['mcp', 'get', 'seashell'], { encoding: 'utf8', timeout: 20_000 });
    if (existing.status === 0) { clients.push({ client, status: 'already-installed', detail: `${binary} already has the seashell server` }); continue; }
    const added = runner(path, [...add], { encoding: 'utf8', timeout: 20_000 });
    clients.push(added.status === 0
      ? { client, status: 'installed', detail: `Added to ${binary} (user scope)` }
      : { client, status: 'failed', detail: String(added.stderr || added.stdout || added.error?.message || `exit ${added.status}`).trim().slice(0, 300) });
  }
  const skill = readFileSync(options.skillSource ?? MEETINGS_SKILL, 'utf8');
  const skills: string[] = [];
  for (const root of [join(home, '.claude'), join(home, '.codex')]) {
    if (!existsSync(root)) continue;
    const target = join(root, 'skills', 'seashell-meetings', 'SKILL.md');
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target) || readFileSync(target, 'utf8') !== skill) writeFileSync(target, skill);
    skills.push(target);
  }
  return { command, clients, skills };
}
