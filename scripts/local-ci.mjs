#!/usr/bin/env node
// Dependency-free local CI. Both projects keep this runner identical.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync, openSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2).filter(a => a !== '--'));
const supported = new Set(['--help', '--quick', '--matrix', '--verify', '--install-hook']);
if ([...args].some(a => !supported.has(a))) throw new Error('Unknown option. Run node scripts/local-ci.mjs --help');
if (args.has('--help')) {
  console.log('Local CI: [--quick | --matrix | --verify | --install-hook]\nDefault: full checks on this Node runtime. --matrix: Humain full checks on Node 22.13.1 and 26.9.0.\n--quick: development checks, never qualifies for the push gate.\n--verify: check saved full result against current source/runtime.\n--install-hook: install a repository pre-push verification hook (refuses existing hooks).\nPrivate logs and reports: .ci-results/<run>/; latest pointer: .ci-results/latest.json');
  process.exit(0);
}
if (args.size > 1) throw new Error('Choose one local CI option at a time');
if (process.platform === 'win32') throw new Error('Local CI currently supports macOS and Linux process groups');
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const engine = metadata.name === '@humain/engine';
const label = engine ? 'Humain' : 'Seashell';
if (!engine && process.platform !== 'darwin') throw new Error('Full Seashell CI requires macOS for native capture helpers');
const major = Number(process.versions.node.split('.')[0]);
if (major < 22 || (major === 22 && Number(process.versions.node.split('.')[1]) < 13)) throw new Error('Node 22.13+ is required');
const state = join(root, '.ci-results');
mkdirSync(state, { recursive: true, mode: 0o700 });
const git = (...argv) => {
  const p = spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (p.status !== 0) throw new Error(`git ${argv[0]} failed: ${p.stderr}`);
  return p.stdout;
};
function fingerprint() {
  const hash = createHash('sha256');
  const paths = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))].sort();
  for (const path of paths) {
    hash.update(path + '\0');
    try {
      const stat = lstatSync(join(root, path));
      hash.update(String(stat.mode & 0o777) + '\0');
      hash.update(stat.isSymbolicLink() ? readlinkSync(join(root, path)) : readFileSync(join(root, path)));
    } catch (e) { if (e.code !== 'ENOENT') throw e; hash.update('<deleted>'); }
    hash.update('\0');
  }
  return hash.digest('hex');
}
function version(binary) {
  const p = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return p.status === 0 ? p.stdout.trim().split('\n')[0] : 'missing';
}
const runtimes = { node: process.version, platform: process.platform, arch: process.arch,
  ...(engine ? {} : { bun: version('bun'), ffmpeg: version('ffmpeg'), python: version('python3'), swift: version('swift') }) };
const latestPath = join(state, 'latest.json');
if (args.has('--verify')) {
  let report;
  try { report = JSON.parse(readFileSync(latestPath, 'utf8')); } catch {}
  if (!report || report.status !== 'passed' || report.profile === 'quick' || Boolean(git('status', '--porcelain').trim()) || report.fingerprint !== fingerprint() || JSON.stringify(report.runtimes) !== JSON.stringify(runtimes)) {
    console.error('No passing full local CI receipt for this source and runtime. Run ' + (engine ? 'npm run ci' : 'bun run ci') + '.');
    process.exit(1);
  }
  console.log(`PASS local CI verified: ${report.output}/report.md`); process.exit(0);
}
if (args.has('--install-hook')) {
  const hooks = git('config', '--default', '', '--get', 'core.hooksPath').trim();
  if (hooks) throw new Error('An existing core.hooksPath is configured. Add the documented verification command to that hook manually.');
}
const output = join(state, `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
if (args.has('--install-hook')) {
  const hooksPath = resolve(root, git('rev-parse', '--git-path', 'hooks').trim());
  mkdirSync(hooksPath, { recursive: true });
  const hook = join(hooksPath, 'pre-push');
  const contents = `#!/bin/sh\n# local-ci-verification\nset -eu\ncd "$(git rev-parse --show-toplevel)"\nwhile read -r local_ref local_sha remote_ref remote_sha; do\n  case "$local_sha" in 0000000000000000000000000000000000000000) continue ;; esac\n  if [ "$(git rev-parse "$local_sha^{commit}")" != "$(git rev-parse HEAD)" ]; then\n    echo 'Local CI: push the tested current checkout separately.' >&2\n    exit 1\n  fi\ndone\nexec node scripts/local-ci.mjs --verify\n`;
  if (existsSync(hook)) {
    if (readFileSync(hook, 'utf8') === contents) { console.log('Local CI hook already installed'); process.exit(0); }
    throw new Error('Existing pre-push hook preserved. Add node scripts/local-ci.mjs --verify to it manually.');
  }
  writeFileSync(hook, contents, { mode: 0o755, flag: 'wx' });
  console.log(`Installed ${hook}`); process.exit(0);
}
const lockPath = join(state, 'running.json');
if (existsSync(lockPath)) {
  const previous = JSON.parse(readFileSync(lockPath, 'utf8'));
  let alive = true;
  try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  if (alive) throw new Error(`Local CI is already running as PID ${previous.pid}; inspect ${previous.output}`);
  unlinkSync(lockPath);
}
writeFileSync(lockPath, JSON.stringify({pid:process.pid,output}), {mode:0o600,flag:'wx'});
mkdirSync(output, { recursive: true, mode: 0o700 });
const before = fingerprint();
const report = { schemaVersion: 1, project: label, runId: randomUUID(), createdAt: new Date().toISOString(),
  revision: git('rev-parse', 'HEAD').trim(), dirty: Boolean(git('status', '--porcelain').trim()), fingerprint: before,
  profile: args.has('--quick') ? 'quick' : args.has('--matrix') ? 'matrix' : 'full', runtimes, output,
  status: 'running', steps: [], limits: engine ? 'This host only; Linux, other architectures, and live providers are not certified.' : 'This Mac architecture; no real-device, diarization-model, Intel, or cloud-provider certification.' };
let active;
let cancelled;
function save() {
  writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(output, 'report.md'), [`# ${label} local CI`, '', `Status: ${report.status}; profile: ${report.profile}`,
    `Revision: ${report.revision}${report.dirty ? ' (working changes)' : ''}`, `Source SHA-256: ${report.fingerprint}`,
    `Runtime: ${JSON.stringify(runtimes)}`, '', ...report.steps.map(s => `- ${s.status.toUpperCase()} ${s.name} (${Math.round(s.durationMs / 1000)}s)${s.error ? ': ' + s.error : ''}`), '', report.limits, '', ...(report.error ? [report.error, ''] : []), 'Logs are adjacent. Generated evidence is ignored by Git.', ''].join('\n'), { mode: 0o600 });
}
function stop(signal) { cancelled = signal; active?.stop(`Interrupted by ${signal}`); }
const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
async function command(name, argv, timeoutMs = 180000, extraEnv = {}) {
  if (cancelled) throw new Error(`Interrupted by ${cancelled}`);
  console.log(`[${label}] ${name}…`);
  const start = Date.now();
  const out = openSync(join(output, `${name}.stdout.log`), 'w', 0o600);
  const err = openSync(join(output, `${name}.stderr.log`), 'w', 0o600);
  let error;
  const result = await new Promise(resolveResult => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root, detached: true,
      env: { ...process.env, ...extraEnv, CI: '1' }, stdio: ['ignore', out, err] });
    let escalation;
    const killGroup = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
    const halt = reason => { if (error) return; error = reason; killGroup('SIGTERM'); escalation = setTimeout(() => killGroup('SIGKILL'), 2000); };
    active = { stop: halt };
    const deadline = setTimeout(() => halt(`Timed out after ${timeoutMs / 1000}s`), timeoutMs);
    const heartbeat = setInterval(() => console.log(`[${label}] ${name}: ${Math.round((Date.now() - start) / 1000)}s; logs in ${output}`), 60000);
    child.once('error', cause => { error = cause.message; });
    child.once('close', code => {
      clearTimeout(deadline); clearInterval(heartbeat);
      if (escalation) { clearTimeout(escalation); killGroup('SIGKILL'); }
      active = undefined; resolveResult(code);
    });
  });
  closeSync(out); closeSync(err);
  const step = { name, command: argv, status: result === 0 && !error ? 'passed' : 'failed', durationMs: Date.now() - start,
    ...(result === 0 && !error ? {} : { error: error ?? `Exited ${result}; inspect ${name}.stderr.log` }) };
  report.steps.push(step); save();
  if (step.status !== 'passed') throw new Error(step.error);
  return readFileSync(join(output, `${name}.stdout.log`), 'utf8');
}
try {
  save();
  if (existsSync(join(root, 'scripts/local-ci.test.mjs'))) await command('runner-tests', [process.execPath, '--test', 'scripts/local-ci.test.mjs']);
  if (engine) {
    await command('install', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    await command('typecheck', ['npm', 'run', 'check']);
    await command('build', ['npm', 'run', 'build']);
    const nodes = [];
    if (args.has('--matrix')) {
      for (const desired of ['22.13.1', '26.9.0']) {
        const exe = process.versions.node === desired ? process.execPath : (await command(`runtime-${desired}`, ['npx', '--yes', `--package=node@${desired}`, 'node', '-p', 'process.execPath'])).trim();
        if (!existsSync(exe) || version(exe) !== `v${desired}`) throw new Error(`Could not provision Node ${desired}`);
        nodes.push(exe);
      }
    } else nodes.push(process.execPath);
    const tests = readdirSync(join(root, 'test')).filter(f => f.endsWith('.test.ts')).sort().map(f => `test/${f}`);
    for (const node of nodes) {
      const id = version(node).replaceAll('.', '-');
      const env = { PATH: `${dirname(node)}:${process.env.PATH ?? ''}` };
      if (args.has('--quick')) {
        const focused = ['app', 'native-models', 'integrations', 'meeting', 'structured-output', 'run-spec'].map(f => `test/${f}.test.ts`).filter(f => existsSync(join(root, f)));
        await command(`tests-quick-${id}`, [node, '--experimental-strip-types', '--test', ...focused], 300000, env);
      } else {
        await command(`tests-full-${id}`, [node, '--experimental-strip-types', '--test', '--test-concurrency=4', ...tests], 7200000, env);
        await command(`package-${id}`, [node, 'scripts/package-smoke.mjs'], 1800000, env);
        if (existsSync(join(root, 'scripts/app-package-smoke.mjs'))) await command(`app-package-${id}`, [node, 'scripts/app-package-smoke.mjs'], 180000, env);
        if (existsSync(join(root, 'scripts/app-soak.mjs'))) await command(`app-soak-${id}`, [node, '--expose-gc', 'scripts/app-soak.mjs', join(output, `soak-${id}.json`)], 180000, env);
      }
    }
  } else {
    if (args.has('--matrix')) throw new Error('--matrix is for Humain; Seashell uses Bun and macOS native helpers');
    await command('install', ['bun', 'install', '--frozen-lockfile']);
    await command('gym', ['bun', 'run', 'gym', '--', ...(args.has('--quick') ? [] : ['--native', '--capture-soak', '--meeting-soak'])], 900000);
  }
  if (fingerprint() !== before) throw new Error('Source changed during CI; result cannot qualify the current tree. Run again.');
  report.status = 'passed';
} catch (error) { report.status = cancelled ? 'cancelled' : 'failed'; report.error = String(error); console.error(String(error)); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString(); save();
  const temp = join(state, `.latest-${process.pid}.json`);
  writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, latestPath);
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  unlinkSync(lockPath);
  console.log(`${report.status.toUpperCase()}: ${join(output, 'report.md')}`);
}
