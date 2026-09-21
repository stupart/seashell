import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export function humainInstallDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SEASHELL_HUMAIN_DIR || join(env.HOME || homedir(),
    'Library', 'Application Support', 'Sea Shell', 'intelligence'));
}

/** Resolve only an explicitly installed, content-addressed package. */
export function installedHumainCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = humainInstallDirectory(env);
  const active = join(root, 'active.json');
  if (!existsSync(active)) return undefined;
  const manifest = JSON.parse(readFileSync(active, 'utf8'));
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error('Invalid Humain installation manifest; reinstall with seashell ai install <package.tgz>');
  }
  const cli = join(root, 'versions', manifest.sha256, 'node_modules', '@humain', 'engine', 'dist', 'cli.js');
  if (!existsSync(cli)) throw new Error('Humain installation is incomplete; reinstall with seashell ai install <package.tgz>');
  return cli;
}

export function requireHumainNode(env: NodeJS.ProcessEnv = process.env): { command: string; version: string } {
  const command = Bun.which('node', { PATH: env.PATH ?? '' });
  if (!command) throw new Error('Meeting AI requires Node 22.13 or newer. Run: brew install node');
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', env, timeout: 5_000 });
  const version = result.stdout?.trim() ?? '';
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (result.status !== 0 || !match || Number(match[1]) < 22 ||
    (Number(match[1]) === 22 && Number(match[2]) < 13)) {
    throw new Error(`Meeting AI requires Node 22.13 or newer (found ${version || 'unavailable'}). Run: brew upgrade node`);
  }
  return { command, version };
}

/** Local package installation stays separate from provider selection and credentials. */
export async function installHumainPackage(tarball: string, env: NodeJS.ProcessEnv = process.env) {
  const node = requireHumainNode(env);
  const source = resolve(tarball);
  if (!source.endsWith('.tgz') || !statSync(source).isFile() || statSync(source).size > 256 * 1024 * 1024) {
    throw new Error('Provide a trusted Humain .tgz package smaller than 256 MiB');
  }
  const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
  const root = humainInstallDirectory(env);
  const versions = join(root, 'versions');
  mkdirSync(versions, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(versions, '.install-'));
  const target = join(versions, sha256);
  const activeTemp = join(root, `.active-${randomUUID()}.json`);
  try {
    copyFileSync(source, join(staging, 'engine.tgz'));
    chmodSync(join(staging, 'engine.tgz'), 0o600);
    writeFileSync(join(staging, 'package.json'), JSON.stringify({ private: true, dependencies: {
      '@humain/engine': 'file:./engine.tgz',
    } }), { mode: 0o600 });
    const child = Bun.spawn([process.execPath, 'install', '--production', '--ignore-scripts'], {
      cwd: staging, env, stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    try {
      const [code, , stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`Humain package installation failed: ${stderr.slice(-2000)}`);
    } finally { clearTimeout(timer); }
    const packageRoot = join(staging, 'node_modules', '@humain', 'engine');
    const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    if (metadata.name !== '@humain/engine' || metadata.version !== '0.0.1') {
      throw new Error('This Seashell build supports @humain/engine 0.0.1');
    }
    const probe = spawnSync(node.command, ['--input-type=module', '-e',
      'const h = await import("@humain/engine"); if (typeof h.createHumainApp !== "function" || typeof h.createMeetingReconciliationRunSpec !== "function") process.exit(1);',
    ], { cwd: staging, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
    if (probe.status !== 0 || !existsSync(join(packageRoot, 'dist', 'cli.js'))) {
      throw new Error('Humain package failed its Node/API compatibility check');
    }
    // A previously selected installation keeps working until all checks pass.
    if (!existsSync(target)) renameSync(staging, target);
    else if (!existsSync(join(target, 'node_modules', '@humain', 'engine', 'dist', 'cli.js'))) {
      throw new Error('Existing package directory is incomplete; choose a fresh SEASHELL_HUMAIN_DIR');
    }
    const manifest = { schemaVersion: 1, version: metadata.version as string, sha256 };
    writeFileSync(activeTemp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(activeTemp, join(root, 'active.json'));
    return { ...manifest, cli: installedHumainCli(env)!, node: node.version };
  } finally {
    rmSync(activeTemp, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}
