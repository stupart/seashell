import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface RuntimeHostOptions {
  /** Private, persistent directory; inject a temporary directory in tests. */
  readonly hostDirectory?: string;
  /** Bun currently running Seashell, including its original code signature. */
  readonly runtimeSource?: string;
  readonly runner?: typeof spawnSync;
  readonly platform?: NodeJS.Platform;
}

export interface RuntimeHostStatus {
  readonly path: string;
  readonly ready: boolean;
  readonly detail: string;
}

function runtimeDirectory(options: RuntimeHostOptions): string {
  return resolve(options.hostDirectory ?? join(homedir(), 'Library', 'Application Support', 'Sea Shell', 'Runtime'));
}

export function meetingRuntimeHostPath(options: RuntimeHostOptions = {}): string {
  // A recognizable, permanent executable name; the copied binary's signing
  // identifier remains Bun's original "bun", independently of this basename.
  return join(runtimeDirectory(options), 'Seashell Background');
}

/** macOS lists this name under Privacy & Security → Microphone. */
export function microphoneRuntimeHelperPath(options: RuntimeHostOptions = {}): string {
  return join(runtimeDirectory(options), 'Seashell Microphone');
}

function existing(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}

function assertOwned(path: string, directory: boolean, privateMode: boolean): void {
  const value = lstatSync(path);
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile())) {
    throw new Error(`The Seashell background host ${directory ? 'directory' : 'file'} must not be a symbolic link: ${path}`);
  }
  if (process.getuid && value.uid !== process.getuid()) throw new Error(`The Seashell background host must belong to your user: ${path}`);
  if (!directory && value.nlink !== 1) throw new Error(`The Seashell background host must be an independent file: ${path}`);
  if (privateMode && (value.mode & 0o077) !== 0) throw new Error(`The Seashell background host must have private permissions: ${path}`);
  if (!directory && (value.mode & 0o100) === 0) throw new Error(`The Seashell background host is not executable: ${path}`);
}

function verifySignedBun(path: string, options: RuntimeHostOptions): void {
  const runner = options.runner ?? spawnSync;
  const verify = runner('/usr/bin/codesign', ['--verify', '--strict', path], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 8192,
  });
  if (verify.error || verify.status !== 0) throw new Error('The Bun runtime has an invalid or missing macOS code signature. Reinstall the official Bun runtime, then try again.');
  const identity = runner('/usr/bin/codesign', ['--display', '--verbose=2', path], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 8192,
  });
  // An ad-hoc signature identifies the current binary's hash, so replacing it
  // would lose the very permission identity this stable host is meant to keep.
  // Preserve Bun's existing developer signature; never invent or re-sign one.
  const output = `${identity.stdout ?? ''}\n${identity.stderr ?? ''}`;
  if (identity.error || identity.status !== 0 || !/^Identifier=bun$/mu.test(output) ||
      !/^TeamIdentifier=(?!not set$)[A-Z0-9]+$/mu.test(output) ||
      !/^Authority=Developer ID Application:/mu.test(output)) {
    throw new Error('The background host requires a developer-signed Bun runtime. Reinstall the official Bun runtime, then try again.');
  }
}

/** Read only: checks never install, replace, repair permissions or prompt. */
export function inspectMeetingRuntimeHost(options: RuntimeHostOptions = {}): RuntimeHostStatus {
  const path = meetingRuntimeHostPath(options);
  if ((options.platform ?? process.platform) !== 'darwin') return { path, ready: false, detail: 'The Seashell background host requires macOS.' };
  try {
    const directory = runtimeDirectory(options);
    if (!existing(directory) || !existing(path)) return {
      path, ready: false, detail: 'The stable Seashell background host is not installed. Run seashell meeting speakers setup to prepare it.',
    };
    assertOwned(directory, true, true);
    assertOwned(path, false, true);
    verifySignedBun(path, options);
    return { path, ready: true, detail: 'The stable Seashell background host is ready.' };
  } catch (error) {
    return { path, ready: false, detail: error instanceof Error ? error.message : 'Could not inspect the Seashell background host.' };
  }
}

function digest(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}

/** Explicit setup/enable only. Copy bytes to a stable private path, retaining
 * Bun's developer signature across package-manager upgrades. Atomic replacement
 * leaves an already-running watcher on its existing executable until restarted. */
export function prepareMeetingRuntimeHost(options: RuntimeHostOptions = {}): string {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('The Seashell background host requires macOS.');
  const path = meetingRuntimeHostPath(options);
  const directory = runtimeDirectory(options);
  const source = realpathSync(options.runtimeSource ?? process.execPath);
  const sourceInfo = statSync(source);
  if (!sourceInfo.isFile() || (sourceInfo.mode & 0o111) === 0) throw new Error('The Bun runtime source is not an executable file.');
  verifySignedBun(source, options);
  if (existing(directory)) assertOwned(directory, true, false);
  else mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existing(path)) {
    assertOwned(path, false, false);
    if (statSync(path).size === sourceInfo.size && digest(path) === digest(source)) {
      chmodSync(path, 0o700);
      return path;
    }
  }
  const temporary = join(directory, `.seashell-background-${randomUUID()}.tmp`);
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o700);
    verifySignedBun(temporary, options);
    // Recheck before rename so an unexpected symlink is never accepted as an
    // existing host. rename itself replaces an entry rather than following it.
    if (existing(path)) assertOwned(path, false, false);
    renameSync(temporary, path);
    return path;
  } finally { rmSync(temporary, { force: true }); }
}

/** The microphone helper answers for its own Microphone permission, which
 * macOS ties to its path and code hash. Keep one stable copy so a package
 * upgrade asks again only when the helper itself actually changed. */
export function prepareMicrophoneRuntimeHelper(source: string, options: RuntimeHostOptions = {}): string {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('The Seashell microphone helper requires macOS.');
  const path = microphoneRuntimeHelperPath(options);
  const directory = runtimeDirectory(options);
  const resolvedSource = realpathSync(source);
  const sourceInfo = statSync(resolvedSource);
  if (!sourceInfo.isFile() || (sourceInfo.mode & 0o111) === 0) throw new Error('The microphone helper is not an executable file.');
  if (existing(directory)) assertOwned(directory, true, false);
  else mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existing(path)) {
    assertOwned(path, false, false);
    if (statSync(path).size === sourceInfo.size && digest(path) === digest(resolvedSource)) return path;
  }
  const temporary = join(directory, `.seashell-microphone-${randomUUID()}.tmp`);
  try {
    copyFileSync(resolvedSource, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o700);
    if (existing(path)) assertOwned(path, false, false);
    renameSync(temporary, path);
    return path;
  } finally { rmSync(temporary, { force: true }); }
}
