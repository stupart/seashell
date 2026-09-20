import { expect, test } from 'bun:test';
import {
  updateRepository,
  type UpdateCommandRunner,
  type UpdateProcessResult,
} from '../src/self-update.ts';

const OLD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function fakeRunner(options: {
  dirty?: boolean;
  remoteBehind?: boolean;
  current?: boolean;
  repairFails?: boolean;
} = {}): { runner: UpdateCommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: UpdateCommandRunner = (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push(key);
    const success = (stdout = ''): UpdateProcessResult => ({ status: 0, stdout, stderr: '' });
    if (key === 'git rev-parse --show-toplevel') return success('/repo\n');
    if (key === 'git symbolic-ref --quiet --short HEAD') return success('main\n');
    if (key === 'git config --get branch.main.remote') return success('origin\n');
    if (key === 'git config --get branch.main.merge') return success('refs/heads/main\n');
    if (key === 'git fetch --quiet origin') return success();
    if (key === 'git rev-parse HEAD') return success(options.current ? NEW_SHA : OLD_SHA);
    if (key === 'git rev-parse --verify origin/main^{commit}') return success(NEW_SHA);
    if (key === `git merge-base --is-ancestor ${OLD_SHA} ${NEW_SHA}`) {
      return { status: options.remoteBehind ? 1 : 0, stdout: '', stderr: '' };
    }
    if (key === `git merge-base --is-ancestor ${NEW_SHA} ${OLD_SHA}`) {
      return { status: options.remoteBehind ? 0 : 1, stdout: '', stderr: '' };
    }
    if (key === 'git status --porcelain --untracked-files=no') {
      return success(options.dirty ? ' M src/cli.tsx\n' : '');
    }
    if (key === 'git merge --ff-only origin/main') return success();
    if (key === 'bash install.sh --repair') return options.repairFails
      ? { status: 1, stdout: '', stderr: 'build failed' } : success();
    return { status: 1, stdout: '', stderr: `Unexpected command: ${key}` };
  };
  return { runner, calls };
}

test('update check reports a fast-forward without modifying the checkout', () => {
  const fake = fakeRunner();
  expect(updateRepository({ projectRoot: '/repo', check: true, runner: fake.runner })).toEqual({
    status: 'update-available',
    branch: 'main',
    upstream: 'origin/main',
    previousSha: OLD_SHA,
    latestSha: NEW_SHA,
  });
  expect(fake.calls).not.toContain('git merge --ff-only origin/main');
  expect(fake.calls).not.toContain('bash install.sh --repair');
});

test('update refuses tracked changes before merging', () => {
  const fake = fakeRunner({ dirty: true });
  expect(() => updateRepository({ projectRoot: '/repo', runner: fake.runner }))
    .toThrow('tracked files have local changes');
  expect(fake.calls).not.toContain('git merge --ff-only origin/main');
});

test('update fast-forwards and repairs native helpers, models, and locked dependencies', () => {
  const fake = fakeRunner();
  expect(updateRepository({ projectRoot: '/repo', runner: fake.runner }).status).toBe('updated');
  expect(fake.calls).toContain('git merge --ff-only origin/main');
  expect(fake.calls).toContain('bash install.sh --repair');
});

test('a local branch ahead of its remote is preserved', () => {
  const fake = fakeRunner({ remoteBehind: true });
  expect(updateRepository({ projectRoot: '/repo', runner: fake.runner }).status).toBe('ahead');
  expect(fake.calls).not.toContain('git merge --ff-only origin/main');
});


test('rerunning an update repairs a failed install even when already at the remote revision', () => {
  const failed = fakeRunner({ repairFails: true });
  expect(() => updateRepository({ projectRoot: '/repo', runner: failed.runner }))
    .toThrow('rerun seashell update');
  const retry = fakeRunner({ current: true });
  expect(updateRepository({ projectRoot: '/repo', runner: retry.runner }).status).toBe('up-to-date');
  expect(retry.calls).toContain('bash install.sh --repair');
  const check = fakeRunner({ current: true });
  updateRepository({ projectRoot: '/repo', check: true, runner: check.runner });
  expect(check.calls).not.toContain('bash install.sh --repair');
});
