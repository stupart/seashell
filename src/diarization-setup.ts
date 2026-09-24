import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { beginManagedProcessSession, trackChildProcess, terminateManagedChild } from './process-lifecycle.ts';
import { DIARIZATION_ROOT, diarizationEnvironment, fileStamp, modelArtifacts } from './diarization-environment.ts';

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

async function run(command: string, args: string[], options: { interactive?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYANNOTE_METRICS_ENABLED: '0', HOMEBREW_NO_AUTO_UPDATE: '1' } });
    const untrack = trackChildProcess(child);
    let output = '', timedOut = false;
    const abort = () => { void terminateManagedChild(child); };
    const deadline = setTimeout(() => { timedOut = true; abort(); }, 20 * 60_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(deadline); untrack(); options.signal?.removeEventListener('abort', abort); };
    child.stdout?.on('data', (chunk) => { output = (output + chunk.toString()).slice(-32_000); });
    // Third-party exceptions can contain authenticated URLs. Never render them in the TUI/JSON.
    child.stderr?.resume();
    child.once('error', () => { cleanup(); reject(new Error('Could not start speaker setup. Check your Python/uv installation.')); });
    child.once('close', (code) => {
      cleanup();
      if (options.signal?.aborted) reject(new Error('Speaker setup cancelled. You can retry later.'));
      else if (timedOut) reject(new Error('Speaker setup timed out. Check your connection and retry.'));
      else if (code === 0) resolve(output);
      else reject(new Error('Speaker setup could not finish. Check your connection and Python dependencies, then retry seashell setup --speakers.'));
    });
  });
}

export interface SpeakerSetupResult {
  ready: boolean;
  stage: string;
  detail: string;
  model: string;
  modelUrl?: string;
  loginCommand?: string;
  nextStep?: string;
}

export async function setupDiarization(options: { login: boolean; check: boolean; signal?: AbortSignal; onStatus?: (message: string) => void }): Promise<SpeakerSetupResult> {
  const environment = diarizationEnvironment();
  mkdirSync(environment.dataRoot, { recursive: true, mode: 0o700 });
  const lock = join(environment.dataRoot, 'speaker-setup.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lock, 'utf8'));
    try { if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid setup lock'); process.kill(pid, 0); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') {
        rmSync(lock); return setupDiarization(options);
      }
    }
    throw new Error('Speaker setup is already running. Wait for it to finish, then retry.');
  }
  const endSession = beginManagedProcessSession();
  const status = options.onStatus ?? ((message: string) => process.stderr.write(`${message}\n`));
  const invoke = (command: string, args: string[], interactive = false) => run(command, args, { interactive, signal: options.signal });
  try {
    options.signal?.throwIfAborted();
    rmSync(environment.verificationPath, { force: true });
    let uv = Bun.which('uv');
    const brew = Bun.which('brew');
    if (!options.check && !environment.configuredPython && !uv && brew) {
      status('Installing uv to manage the optional speaker Python environment…');
      await invoke(brew, ['install', 'uv']);
      uv = Bun.which('uv');
    }
    if (!existsSync(environment.python) && !Bun.which(environment.python)) {
      if (environment.configuredPython) throw new Error('The configured speaker Python was not found. Check SEASHELL_DIARIZATION_PYTHON.');
      if (options.check) throw new Error('Speaker dependencies are not installed. Run seashell setup --speakers.');
      status('Installing optional local speaker separation…');
      if (uv) await invoke(uv, ['venv', '--python', '3.12', dirname(dirname(environment.managedPython))]);
      else {
        const python = Bun.which('python3.12') || Bun.which('python3');
        if (!python) throw new Error('Install uv (brew install uv), then run seashell setup --speakers again.');
        await invoke(python, ['-c', 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 14) else 1)']);
        await invoke(python, ['-m', 'venv', dirname(dirname(environment.managedPython))]);
      }
    }
    if (!options.check && environment.python === environment.managedPython) {
      status('Installing speaker dependencies · the first download can take several minutes…');
      if (uv) await invoke(uv, ['pip', 'install', '--python', environment.python, '-r', environment.requirements]);
      else await invoke(environment.python, ['-m', 'pip', 'install', '-r', environment.requirements]);
    }
    const modelUrl = environment.model.startsWith('/') ? undefined : `https://huggingface.co/${environment.model}`;
    const hf = join(dirname(Bun.which(environment.python) || environment.python), 'hf');
    const loginCommand = `${shellQuote(hf)} auth login --no-add-to-git-credential`;
    if (options.login) {
      if (!process.stdin.isTTY) throw new Error('Login needs an interactive terminal. Run seashell setup --speakers --login there.');
      status(`Accept model access in your browser first: ${modelUrl ?? environment.model}\nHugging Face stores the login locally; Sea Shell does not store your token.`);
      await invoke(hf, ['auth', 'login', '--no-add-to-git-credential'], true);
    }
    status(options.check ? 'Checking cached speaker model offline…' : 'Downloading and verifying speaker model…');
    const result = JSON.parse(await invoke(environment.python, [
      join(DIARIZATION_ROOT, 'scripts', 'check-diarization.py'), '--model', environment.model,
      ...(options.check ? [] : ['--download']),
    ])) as { ready: boolean; stage: string; detail: string };
    if (typeof result.ready !== 'boolean' || typeof result.detail !== 'string' || typeof result.stage !== 'string') {
      throw new Error('Speaker verification returned an invalid result. Run setup again.');
    }
    if (result.ready) {
      const artifacts = modelArtifacts(environment.modelCache);
      if (!artifacts.length) throw new Error('Speaker model files are missing. Run setup again.');
      const target = environment.verificationPath;
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 2, artifacts,
        pythonStamp: fileStamp(Bun.which(environment.python) || environment.python),
        modelStamp: fileStamp(environment.modelCache), checkedAt: new Date().toISOString() }), { mode: 0o600 });
      renameSync(temporary, target);
    }
    return { ...result, model: environment.model, modelUrl,
      ...(result.ready ? {} : { loginCommand, nextStep: options.check
        ? 'Run seashell setup --speakers to complete setup.'
        : 'Accept model access, sign in locally, then run seashell setup --speakers again.' }) };
  } finally { endSession(); rmSync(lock, { force: true }); }
}
