import { expect, test } from 'bun:test';
import { suggestCalendarMeeting } from '../src/calendar.ts';

const now = new Date('2026-08-10T14:00:00Z');
const events = [
  {
    provider: 'fixture',
    eventId: 'later',
    calendar: 'Work',
    title: 'Later meeting',
    startAt: '2026-08-10T14:04:00Z',
    endAt: '2026-08-10T14:30:00Z',
    attendees: [],
  },
  {
    provider: 'fixture',
    eventId: 'now',
    calendar: 'Personal',
    title: 'Current meeting',
    startAt: '2026-08-10T13:59:00Z',
    endAt: '2026-08-10T14:20:00Z',
    attendees: [],
  },
];

test('calendar suggestions respect off, ask, and selected-calendar policies', () => {
  expect(suggestCalendarMeeting(events, { policy: 'off', now })).toBeUndefined();
  expect(suggestCalendarMeeting(events, { policy: 'ask', now })?.eventId).toBe('now');
  expect(suggestCalendarMeeting(events, {
    policy: 'selected-calendars',
    selectedCalendars: ['Work'],
    now,
  })?.eventId).toBe('later');
});
