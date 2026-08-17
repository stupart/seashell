import { existsSync } from 'fs';
import { defaultConfigPath, loadConfig, updateMeetingConfig, type SeashellConfig } from './config.ts';
import {
  enableMeetingLaunchAtLogin,
  type LaunchAtLoginStatus,
} from './launch-at-login.ts';

export interface FirstInstallResult {
  readonly initialized: boolean;
  readonly configPath: string;
  readonly config: SeashellConfig;
  readonly launchAtLogin: 'enabled' | 'disabled' | 'preserved' | 'unavailable';
  readonly launchStatus?: LaunchAtLoginStatus;
  readonly warning?: string;
}

export interface FirstInstallOptions {
  readonly configPath?: string;
  readonly enableAutostart?: boolean;
  readonly enableLaunch?: typeof enableMeetingLaunchAtLogin;
}

/**
 * Seed privacy-preserving defaults exactly once. Existing configuration is a
 * user decision and is therefore never rewritten or used to re-enable a login
 * agent during a reinstall.
 */
export function initializeFirstInstall(
  options: FirstInstallOptions = {},
): FirstInstallResult {
  const configPath = options.configPath ?? defaultConfigPath();
  if (existsSync(configPath)) {
    return Object.freeze({
      initialized: false,
      configPath,
      config: loadConfig(configPath),
      launchAtLogin: 'preserved' as const,
    });
  }

  const shouldEnableAutostart = options.enableAutostart !== false;
  const config = updateMeetingConfig({
    calendar: { enabled: true, policy: 'ask' },
    automation: {
      enabled: true,
      mode: 'automatic',
      browserWithoutCalendar: 'ask',
      launchAtLogin: shouldEnableAutostart,
    },
  }, configPath);

  if (!shouldEnableAutostart) {
    return Object.freeze({
      initialized: true,
      configPath,
      config,
      launchAtLogin: 'disabled' as const,
    });
  }

  try {
    const launchStatus = (options.enableLaunch ?? enableMeetingLaunchAtLogin)();
    return Object.freeze({
      initialized: true,
      configPath,
      config,
      launchAtLogin: 'enabled' as const,
      launchStatus,
    });
  } catch (error) {
    return Object.freeze({
      initialized: true,
      configPath,
      config,
      launchAtLogin: 'unavailable' as const,
      warning: error instanceof Error ? error.message : String(error),
    });
  }
}
