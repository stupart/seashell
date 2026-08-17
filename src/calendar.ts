import { execFile, spawnSync } from 'child_process';
import type { MeetingCalendarEvent } from './meeting-artifact.ts';

export type MeetingCapturePolicy = 'off' | 'ask' | 'selected-calendars' | 'all';

export interface CalendarSuggestionOptions {
  policy: MeetingCapturePolicy;
  selectedCalendars?: string[];
  leadMinutes?: number;
  graceMinutes?: number;
  now?: Date;
}

interface CalendarProcessError extends Error {
  readonly code?: string | number | null;
  readonly killed?: boolean;
}

function calendarReadFailure(error: CalendarProcessError, stderr = ''): Error {
  const detail = stderr.trim().split('\n').find((line) => line.trim());
  const normalized = `${error.code ?? ''} ${error.message} ${detail ?? ''}`.toLocaleLowerCase();
  if (error.code === 'ETIMEDOUT' || error.killed || normalized.includes('timed out')) {
    return new Error(
      'Calendar did not respond. Open Calendar once, then allow the app running Sea Shell in System Settings → Privacy & Security → Calendars. Audio-based meeting detection still works without Calendar.',
    );
  }
  if (normalized.includes('not authorized') || normalized.includes('not permitted') ||
      normalized.includes('denied') || normalized.includes('-1743')) {
    return new Error(
      'Calendar access is off. Allow the app running Sea Shell in System Settings → Privacy & Security → Calendars, or keep using audio-only meeting detection.',
    );
  }
  return new Error(
    `Could not read macOS Calendar${detail ? `: ${detail.slice(0, 240)}` : ''}. Audio-based meeting detection is still available.`,
  );
}

function parseCalendarEvent(value: unknown, index: number): MeetingCalendarEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Calendar event ${index} is invalid`);
  }
  const event = value as Record<string, unknown>;
  const required = ['provider', 'eventId', 'title', 'startAt', 'endAt'] as const;
  for (const field of required) {
    if (typeof event[field] !== 'string' || !(event[field] as string).trim()) {
      throw new Error(`Calendar event ${index} ${field} is invalid`);
    }
  }
  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  return {
    provider: event.provider as string,
    eventId: event.eventId as string,
    ...(typeof event.calendar === 'string' ? { calendar: event.calendar } : {}),
    title: event.title as string,
    startAt: event.startAt as string,
    endAt: event.endAt as string,
    ...(typeof event.location === 'string' && event.location
      ? { location: event.location }
      : {}),
    ...(typeof event.joinUrl === 'string' && event.joinUrl
      ? { joinUrl: event.joinUrl }
      : {}),
    attendees: attendees.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const attendee = raw as Record<string, unknown>;
      if (typeof attendee.name !== 'string' || !attendee.name.trim()) return [];
      return [{
        name: attendee.name.trim(),
        ...(typeof attendee.email === 'string' ? { email: attendee.email } : {}),
        ...(typeof attendee.response === 'string' ? { response: attendee.response } : {}),
      }];
    }),
  };
}

export function parseCalendarEvents(value: unknown): MeetingCalendarEvent[] {
  if (!Array.isArray(value)) throw new Error('Calendar provider must return an array');
  return value.map(parseCalendarEvent);
}

export function suggestCalendarMeeting(
  events: MeetingCalendarEvent[],
  options: CalendarSuggestionOptions,
): MeetingCalendarEvent | undefined {
  if (options.policy === 'off') return undefined;
  const now = (options.now ?? new Date()).getTime();
  const lead = Math.max(0, options.leadMinutes ?? 5) * 60_000;
  const grace = Math.max(0, options.graceMinutes ?? 10) * 60_000;
  const selected = new Set((options.selectedCalendars ?? []).map((name) => name.toLocaleLowerCase()));
  return events
    .filter((event) => {
      const start = Date.parse(event.startAt);
      const end = Date.parse(event.endAt);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      if (start > now + lead || end < now - grace) return false;
      if (options.policy !== 'selected-calendars') return true;
      return event.calendar !== undefined && selected.has(event.calendar.toLocaleLowerCase());
    })
    .toSorted((a, b) => Math.abs(Date.parse(a.startAt) - now) - Math.abs(Date.parse(b.startAt) - now))[0];
}

/**
 * Read a small time window from macOS Calendar. The adapter is opt-in because
 * the first call can trigger the system Calendar permission prompt.
 */
export function readMacCalendarEvents(
  options: { leadMinutes?: number; lookbackMinutes?: number } = {},
): MeetingCalendarEvent[] {
  const leadMinutes = Math.max(5, options.leadMinutes ?? 15);
  const lookbackMinutes = Math.max(0, options.lookbackMinutes ?? 10);
  const script = `
    ObjC.import('Foundation');
    const app = Application('Calendar');
    const now = new Date();
    const from = new Date(now.getTime() - ${lookbackMinutes} * 60000);
    const to = new Date(now.getTime() + ${leadMinutes} * 60000);
    const rows = [];
    for (const calendar of app.calendars()) {
      const calendarName = calendar.name();
      for (const event of calendar.events.whose({
        _and: [
          { startDate: { _lessThanEquals: to } },
          { endDate: { _greaterThanEquals: from } }
        ]
      })()) {
        let url = '';
        try { url = event.url() || ''; } catch (_) {}
        let location = '';
        try { location = event.location() || ''; } catch (_) {}
        rows.push({
          provider: 'macos-calendar',
          eventId: String(event.uid()),
          calendar: String(calendarName),
          title: String(event.summary() || 'Meeting'),
          startAt: event.startDate().toISOString(),
          endAt: event.endDate().toISOString(),
          location: String(location),
          joinUrl: String(url),
          attendees: []
        });
      }
    }
    JSON.stringify(rows);
  `;
  const result = spawnSync('osascript', ['-l', 'JavaScript', '-e', script], {
    encoding: 'utf8',
    timeout: 8_000,
    maxBuffer: 1_000_000,
  });
  if (result.error || result.status !== 0) {
    throw calendarReadFailure(
      result.error ?? Object.assign(new Error(`exit ${result.status}`), { code: result.status }),
      result.stderr ?? '',
    );
  }
  try {
    return parseCalendarEvents(JSON.parse(result.stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse macOS Calendar events: ${message}`);
  }
}

/** Non-blocking form for live UI and background watcher loops. */
export function readMacCalendarEventsAsync(
  options: { leadMinutes?: number; lookbackMinutes?: number; signal?: AbortSignal } = {},
): Promise<MeetingCalendarEvent[]> {
  const leadMinutes = Math.max(5, options.leadMinutes ?? 15);
  const lookbackMinutes = Math.max(0, options.lookbackMinutes ?? 10);
  const script = `
    ObjC.import('Foundation');
    const app = Application('Calendar');
    const now = new Date();
    const from = new Date(now.getTime() - ${lookbackMinutes} * 60000);
    const to = new Date(now.getTime() + ${leadMinutes} * 60000);
    const rows = [];
    for (const calendar of app.calendars()) {
      const calendarName = calendar.name();
      for (const event of calendar.events.whose({
        _and: [
          { startDate: { _lessThanEquals: to } },
          { endDate: { _greaterThanEquals: from } }
        ]
      })()) {
        let url = '';
        try { url = event.url() || ''; } catch (_) {}
        let location = '';
        try { location = event.location() || ''; } catch (_) {}
        const attendees = [];
        try {
          for (const person of event.attendees()) {
            let name = '';
            let email = '';
            let response = '';
            try { name = person.displayName() || person.name() || ''; } catch (_) {}
            try { email = person.email() || ''; } catch (_) {}
            try { response = String(person.participationStatus() || ''); } catch (_) {}
            if (name) attendees.push({ name: String(name), email: String(email), response });
          }
        } catch (_) {}
        rows.push({
          provider: 'macos-calendar',
          eventId: String(event.uid()),
          calendar: String(calendarName),
          title: String(event.summary() || 'Meeting'),
          startAt: event.startDate().toISOString(),
          endAt: event.endDate().toISOString(),
          location: String(location),
          joinUrl: String(url),
          attendees
        });
      }
    }
    JSON.stringify(rows);
  `;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], {
      encoding: 'utf8',
      timeout: 8_000,
      maxBuffer: 1_000_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (error, stdout, stderr) => {
      if (error) {
        reject(calendarReadFailure(error, stderr));
        return;
      }
      try {
        resolve(parseCalendarEvents(JSON.parse(stdout)));
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        reject(new Error(`Could not parse macOS Calendar events: ${message}`));
      }
    });
  });
}
