import { spawnSync } from 'child_process';

export interface UpdateProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type UpdateCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => UpdateProcessResult;

export type SelfUpdateStatus = 'up-to-date' | 'update-available' | 'updated' | 'ahead';

export interface SelfUpdateResult {
  status: SelfUpdateStatus;
  branch: string;
  upstream: string;
  previousSha: string;
  latestSha: string;
}

export interface SelfUpdateOptions {
  projectRoot: string;
  check?: boolean;
  runner?: UpdateCommandRunner;
}

const defaultRunner: UpdateCommandRunner = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
};

function run(
  runner: UpdateCommandRunner,
  cwd: string,
  command: string,
  args: string[],
  description: string,
): string {
  const result = runner(command, args, cwd);
  if (result.error || result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message;
    throw new Error(`${description}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function tryRun(
  runner: UpdateCommandRunner,
  cwd: string,
  command: string,
  args: string[],
): UpdateProcessResult {
  return runner(command, args, cwd);
}

/**
 * Update a Git-based Sea Shell installation without replacing local history.
 * Only a clean, fast-forward update is allowed; dependencies are refreshed
 * from the committed lockfile after the new revision is checked out.
 */
export function updateRepository(options: SelfUpdateOptions): SelfUpdateResult {
  const runner = options.runner ?? defaultRunner;
  const repositoryRoot = run(
    runner,
    options.projectRoot,
    'git',
    ['rev-parse', '--show-toplevel'],
    'Sea Shell is not installed from a Git checkout',
  );
  const branch = run(
    runner,
    repositoryRoot,
    'git',
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    'Cannot update from a detached Git revision',
  );

  const configuredRemote = tryRun(
    runner,
    repositoryRoot,
    'git',
    ['config', '--get', `branch.${branch}.remote`],
  );
  const configuredMerge = tryRun(
    runner,
    repositoryRoot,
    'git',
    ['config', '--get', `branch.${branch}.merge`],
  );
  const remote = configuredRemote.status === 0 && configuredRemote.stdout.trim()
    ? configuredRemote.stdout.trim()
    : 'origin';
  const remoteBranch = configuredMerge.status === 0 && configuredMerge.stdout.trim()
    ? configuredMerge.stdout.trim().replace(/^refs\/heads\//, '')
    : branch;
  if (remote === '.') {
    throw new Error('Cannot update a branch whose upstream is another local branch');
  }
  const upstream = `${remote}/${remoteBranch}`;

  run(
    runner,
    repositoryRoot,
    'git',
    ['fetch', '--quiet', remote],
    `Could not fetch ${remote}`,
  );
  const previousSha = run(
    runner,
    repositoryRoot,
    'git',
    ['rev-parse', 'HEAD'],
    'Could not read the installed revision',
  );
  const latestSha = run(
    runner,
    repositoryRoot,
    'git',
    ['rev-parse', '--verify', `${upstream}^{commit}`],
    `No remote branch named ${upstream}; publish or select a tracked branch first`,
  );

  const common = { branch, upstream, previousSha, latestSha };
  if (previousSha === latestSha) return { status: 'up-to-date', ...common };

  const canFastForward = tryRun(
    runner,
    repositoryRoot,
    'git',
    ['merge-base', '--is-ancestor', previousSha, latestSha],
  );
  if (canFastForward.status !== 0) {
    const remoteIsBehind = tryRun(
      runner,
      repositoryRoot,
      'git',
      ['merge-base', '--is-ancestor', latestSha, previousSha],
    );
    if (remoteIsBehind.status === 0) return { status: 'ahead', ...common };
    throw new Error(
      `${branch} and ${upstream} have diverged; Sea Shell will not merge or discard local work`,
    );
  }
  if (options.check) return { status: 'update-available', ...common };

  const trackedChanges = run(
    runner,
    repositoryRoot,
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    'Could not inspect the working tree',
  );
  if (trackedChanges) {
    throw new Error('Refusing to update because tracked files have local changes');
  }

  run(
    runner,
    repositoryRoot,
    'git',
    ['merge', '--ff-only', upstream],
    `Could not fast-forward ${branch}`,
  );
  run(
    runner,
    repositoryRoot,
    'bun',
    ['install', '--frozen-lockfile'],
    'Sea Shell updated, but dependency installation failed; run bun install --frozen-lockfile',
  );

  return { status: 'updated', ...common };
}

export function formatSelfUpdateResult(result: SelfUpdateResult): string {
  const previous = result.previousSha.slice(0, 7);
  const latest = result.latestSha.slice(0, 7);
  switch (result.status) {
    case 'up-to-date':
      return `Sea Shell is up to date on ${result.branch} (${latest}).`;
    case 'update-available':
      return `Update available on ${result.upstream}: ${previous} → ${latest}. Run seashell update.`;
    case 'updated':
      return `Updated Sea Shell on ${result.branch}: ${previous} → ${latest}.`;
    case 'ahead':
      return `${result.branch} is ahead of ${result.upstream}; there is no remote update to apply.`;
  }
}
