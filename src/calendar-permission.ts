import { CALENDAR_HELPER } from './calendar.ts';
import { helperPermission, type HelperPermissionOptions, type HelperPermissionStatus } from './helper-permission.ts';
import { CALENDAR_RUNTIME_HELPER } from './runtime-host.ts';

const DETAILS = {
  authorized: 'Seashell Calendar can read your calendar to name meetings and list attendees.',
  notDetermined: 'macOS has not asked yet. Run seashell meeting calendar setup and choose Allow.',
  denied: 'Calendar access is off for Seashell Calendar. Turn it on in System Settings → Privacy & Security → Calendars.',
  writeOnly: 'Seashell Calendar can only add events. Choose Full Access in System Settings → Privacy & Security → Calendars.',
  restricted: 'This Mac restricts calendar access (for example by a device-management profile).',
  unavailable: 'The Seashell calendar helper is missing. Reinstall or run bash scripts/build-native.sh.',
};

export function calendarPermission(options: HelperPermissionOptions = {}): Promise<HelperPermissionStatus> {
  return helperPermission(options.helperPath ?? CALENDAR_HELPER, CALENDAR_RUNTIME_HELPER, DETAILS, options);
}
