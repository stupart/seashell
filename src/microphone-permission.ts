import { MICROPHONE_HELPER } from './live-microphone.ts';
import { helperPermission, type HelperAuthorization, type HelperPermissionOptions, type HelperPermissionStatus } from './helper-permission.ts';
import { MICROPHONE_RUNTIME_HELPER } from './runtime-host.ts';

export type MicrophoneAuthorization = HelperAuthorization;
export type MicrophonePermissionStatus = HelperPermissionStatus;
export type MicrophonePermissionOptions = HelperPermissionOptions;

const DETAILS = {
  authorized: 'Seashell Microphone can record your side of meetings, including in the background.',
  notDetermined: 'macOS has not asked yet. Run seashell meeting microphone setup and choose Allow.',
  denied: 'Microphone access is off for Seashell Microphone. Turn it on in System Settings → Privacy & Security → Microphone.',
  restricted: 'This Mac restricts microphone access (for example by a device-management profile).',
  unknown: 'macOS reported an unknown microphone permission state.',
  unavailable: 'The Seashell microphone helper is missing. Reinstall or run bash scripts/build-native.sh.',
};

export function microphonePermission(options: MicrophonePermissionOptions = {}): Promise<MicrophonePermissionStatus> {
  return helperPermission(options.helperPath ?? MICROPHONE_HELPER, MICROPHONE_RUNTIME_HELPER, DETAILS, options);
}
