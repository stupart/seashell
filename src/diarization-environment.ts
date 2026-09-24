import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';

export const DIARIZATION_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIARIZATION_MODEL = 'pyannote/speaker-diarization-community-1';
export const SPEAKER_SETUP_COMMAND = 'seashell setup --speakers';

export function diarizationEnvironment() {
  const home = homedir();
  const dataRoot = process.env.SEASHELL_DIARIZATION_HOME || (process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Sea Shell')
    : join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'seashell'));
  const managedPython = join(dataRoot, 'diarization-venv', 'bin', 'python');
  const legacyPython = join(DIARIZATION_ROOT, '.venv-diarization', 'bin', 'python');
  const configuredPython = process.env.SEASHELL_DIARIZATION_PYTHON || process.env.SEASHELL_PYTHON;
  const python = configuredPython || (existsSync(managedPython) ? managedPython
    : existsSync(legacyPython) ? legacyPython : managedPython);
  const model = process.env.SEASHELL_DIARIZATION_MODEL || DEFAULT_DIARIZATION_MODEL;
  const hubRoot = process.env.HF_HUB_CACHE || process.env.HUGGINGFACE_HUB_CACHE || join(
    process.env.HF_HOME || join(home, '.cache', 'huggingface'), 'hub',
  );
  const modelCache = isAbsolute(model) ? model : join(hubRoot, `models--${model.replaceAll('/', '--')}`);
  const requirements = join(DIARIZATION_ROOT, 'scripts', 'requirements-diarization.txt');
  const key = createHash('sha256').update(JSON.stringify({ python, model, hubRoot,
    requirements: readFileSync(requirements, 'utf8') })).digest('hex');
  return { dataRoot, managedPython, python, configuredPython, model, modelCache, requirements,
    verificationPath: join(dataRoot, 'diarization-checks', `${key}.json`) };
}

export function resolveDiarizationPython(provided?: string): string {
  if (provided) return provided;
  const environment = diarizationEnvironment();
  if (environment.configuredPython || existsSync(environment.python)) return environment.python;
  // Preserve the explicit batch workflow for manually installed system Python packages.
  return 'python3';
}

export function fileStamp(path: string): string | null {
  try { const stat = statSync(path); return `${stat.size}:${stat.mtimeMs}:${stat.mode}`; } catch { return null; }
}

export function diarizationStatus() {
  const environment = diarizationEnvironment();
  const python = Bun.which(environment.python) || environment.python;
  let ready = false;
  try {
    const receipt = JSON.parse(readFileSync(environment.verificationPath, 'utf8'));
    ready = receipt.version === 2 && receipt.pythonStamp !== null && receipt.modelStamp !== null &&
      receipt.pythonStamp === fileStamp(python) && receipt.modelStamp === fileStamp(environment.modelCache) &&
      Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0 &&
      receipt.artifacts.every((entry: { path: string; stamp: string }) =>
        typeof entry.path === 'string' && typeof entry.stamp === 'string' && fileStamp(entry.path) === entry.stamp);
  } catch { /* Missing or obsolete verification is setup required, never a successful model check. */ }
  return { ready, python, model: environment.model,
    nextStep: ready ? undefined : `Identify speakers: run ${SPEAKER_SETUP_COMMAND}. Recording works without it.` };
}

/** Record individual cached files as well as the root: deleted weights invalidate readiness. */
export function modelArtifacts(root: string): Array<{ path: string; stamp: string }> {
  const files: Array<{ path: string; stamp: string }> = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (files.length > 10_000) throw new Error('Speaker model cache has too many files to verify.');
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const stamp = fileStamp(child);
        if (stamp !== null) files.push({ path: child, stamp });
      }
    }
  };
  visit(root);
  return files;
}
