import { spawnSync } from 'child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { defaultConfigPath } from './config.ts';

/**
 * The secret that signs the owner's answers to automation dialogs, so a file
 * written by anything else cannot pass for a yes. It lives in the login
 * Keychain as a generic password named for Seashell, which a process that can
 * only write files cannot read. Without the Keychain it is a 0600 file beside
 * the approvals, and Seashell says so.
 */

export const APPROVAL_KEYCHAIN_SERVICE = 'Seashell automation approvals';
const KEYCHAIN_ACCOUNT = 'signing-key';
const KEY = /^[0-9a-f]{64}$/u;

export interface ApprovalKey {
  readonly key: Buffer;
  readonly store: 'keychain' | 'file';
  /** Why the Keychain was not used, when it should have been. */
  readonly note?: string;
}

/** Runs /usr/bin/security; tests stand in for it. */
export type KeychainCommand = (args: readonly string[]) => { status: number | null; stdout: string };

const security: KeychainCommand = (args) => {
  const result = spawnSync('/usr/bin/security', args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
};

/**
 * Seashell's own settings folder keeps its key in the Keychain; another one (a
 * test, a second setup) in a file beside it. Tests turn the Keychain off for
 * the whole process, so no test ever reaches the real one.
 */
function keychainFor(env: NodeJS.ProcessEnv): KeychainCommand | undefined {
  return process.platform === 'darwin' && process.env.SEASHELL_APPROVAL_KEYCHAIN !== 'off'
    && dirname(defaultConfigPath(env)) === dirname(defaultConfigPath({})) ? security : undefined;
}

function fromKeychain(keychain: KeychainCommand): Buffer | { failed: string } {
  const find = () => keychain(['find-generic-password', '-s', APPROVAL_KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']);
  let found = find();
  // 44: no such item yet. Make one; if another Seashell made it first, adding fails and reading gets theirs.
  if (found.status === 44) {
    keychain(['add-generic-password', '-s', APPROVAL_KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT,
      '-l', APPROVAL_KEYCHAIN_SERVICE, '-j', 'Signs your answers to Seashell automation dialogs.', '-w', randomBytes(32).toString('hex')]);
    found = find();
  }
  const value = found.stdout.trim();
  if (found.status === 0 && KEY.test(value)) return Buffer.from(value, 'hex');
  return { failed: found.status === null ? 'it did not answer' : found.status === 0 ? 'its key was not one Seashell made' : `security exited ${found.status}` };
}

function fromFile(path: string): Buffer {
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (KEY.test(value)) return Buffer.from(value, 'hex');
  } catch { /* Not made yet. */ }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Another Seashell made it first; a damaged one is replaced, which only means asking again.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!KEY.test(readFileSync(path, 'utf8').trim())) writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  }
  return Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
}

const cached = new Map<string, ApprovalKey>();

/** The signing key for the approvals at `approvalsPath`. */
export function approvalKey(approvalsPath: string, env: NodeJS.ProcessEnv = process.env, keychain = keychainFor(env)): ApprovalKey {
  const real = keychain === security;
  const known = real ? cached.get(approvalsPath) : undefined;
  if (known) return known;
  const file = join(dirname(approvalsPath), 'automation-approvals.key');
  let result: ApprovalKey;
  if (keychain) {
    const key = fromKeychain(keychain);
    result = Buffer.isBuffer(key) ? { key, store: 'keychain' }
      : { key: fromFile(file), store: 'file', note: `The Keychain was not available (${key.failed}), so automation approvals are signed with ${file}.` };
  } else {
    result = { key: fromFile(file), store: 'file' };
  }
  // A Keychain that failed is tried again next time rather than remembered.
  if (real && result.store === 'keychain') cached.set(approvalsPath, result);
  return Object.freeze(result);
}

export function signApproval(key: Buffer, approval: string, decision: string): string {
  return createHmac('sha256', key).update(`seashell-automation-approval/1\n${approval}\n${decision}`).digest('hex');
}

export function validApproval(key: Buffer, approval: string, decision: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/u.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signApproval(key, approval, decision), 'hex'));
}
