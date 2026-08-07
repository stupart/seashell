import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';

export interface SeashellConfig {
  libraryDir?: string;
  saveByDefault?: boolean;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SEASHELL_CONFIG || join(
    homedir(),
    'Library',
    'Application Support',
    'Sea Shell',
    'config.json',
  );
}

export function loadConfig(path = defaultConfigPath()): SeashellConfig {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Sea Shell config at ${path}: ${message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Sea Shell config at ${path} must be a JSON object`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.libraryDir !== undefined && typeof candidate.libraryDir !== 'string') {
    throw new Error('Sea Shell config libraryDir must be a string');
  }
  if (candidate.saveByDefault !== undefined && typeof candidate.saveByDefault !== 'boolean') {
    throw new Error('Sea Shell config saveByDefault must be a boolean');
  }
  return {
    ...(typeof candidate.libraryDir === 'string' ? { libraryDir: candidate.libraryDir } : {}),
    ...(typeof candidate.saveByDefault === 'boolean'
      ? { saveByDefault: candidate.saveByDefault }
      : {}),
  };
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function resolveLibraryDir(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  config: SeashellConfig = loadConfig(),
): string {
  const configured = override || env.SEASHELL_LIBRARY_DIR || config.libraryDir || join(
    homedir(),
    'Documents',
    'Sea Shell',
    'Transcripts',
  );
  const expanded = expandHome(configured);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function resolveSaveByDefault(config: SeashellConfig = loadConfig()): boolean {
  return config.saveByDefault ?? true;
}
