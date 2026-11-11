import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { finalizeCaptureTranscript } from '../src/capture-finalizer.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { remoteVoiceCeiling } from '../src/diarize.ts';
import { calendarEventIsThisCall } from '../src/meeting-automation.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import { createMeetingArtifact, type MeetingCalendarEvent } from '../src/meeting-artifact.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';
import type { TranscribeMediaOptions } from '../src/transcription-service.ts';

const invite = (responses: string[], extra: Array<{ name: string; email: string }> = []): MeetingCalendarEvent => ({
  provider: 'macos-eventkit', eventId: 'e1', title: 'Weekly sync', startAt: '2026-11-10T15:00:00Z', endAt: '2026-11-10T15:30:00Z',
  attendees: [
    ...responses.map((response, index) => ({ name: `Person ${index + 1}`, email: `person${index + 1}@example.com`, response })),
    ...extra,
  ],
});

test('the ceiling is everyone invited who has not declined, minus Tyler, plus one spare seat', () => {
  expect(remoteVoiceCeiling(invite(['accepted', 'accepted']).attendees)).toBe(2);
  expect(remoteVoiceCeiling(invite(['accepted', 'accepted', 'declined', 'pending', 'tentative']).attendees)).toBe(4);
  // Nobody but Tyler, or no list at all, says nothing about the other side.
  expect(remoteVoiceCeiling(invite(['accepted']).attendees)).toBeUndefined();
  expect(remoteVoiceCeiling([])).toBeUndefined();
  // A room can seat several people behind one invite.
  expect(remoteVoiceCeiling(invite(['accepted', 'accepted'], [{ name: 'Room 4', email: 'c_123@resource.calendar.google.com' }]).attendees))
    .toBeUndefined();
});

function systemCapture(root: string): CaptureSessionStore {
  const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'hinted', startedAtUnixMs: 1 });
  const pcm = Buffer.alloc(32_000);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(Math.round(3000 * Math.sin(offset / 6)), offset);
  const source = join(root, 'system.wav');
  writeFileSync(source, pcmS16leToWav(pcm));
  store.commitChunk({ sourcePath: source, trackId: 'system-audio', startSeconds: 0, endSeconds: 1, audible: true });
  return store;
}

async function separationOptions(manifestPath: string, attendees?: MeetingCalendarEvent['attendees']): Promise<TranscribeMediaOptions> {
  let seen: TranscribeMediaOptions | undefined;
  await finalizeCaptureTranscript(manifestPath, {
    diarizeSystemAudio: true, strictSpeakers: true, ...(attendees ? { attendees } : {}),
    systemDiarizer: async (_path, options) => {
      seen = options;
      return { speakers: [{ id: 'A', label: 'A' }], transcript: [{ start: 0.1, end: 0.9, speaker: 'A', text: 'Hello there.' }] };
    },
  });
  return seen!;
}

test('the finalizer gives separation the invite as a ceiling, and nothing without one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-count-hint-'));
  try {
    const store = systemCapture(root);
    expect((await separationOptions(store.manifestPath, invite(['accepted', 'accepted', 'accepted', 'declined']).attendees)).maxSpeakers).toBe(3);
    expect((await separationOptions(store.manifestPath)).maxSpeakers).toBeUndefined();
    expect((await separationOptions(store.manifestPath, invite(['accepted']).attendees)).maxSpeakers).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('separating a saved meeting again reads its invite from meeting.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-count-hint-saved-'));
  try {
    const store = systemCapture(root);
    const meeting = join(root, '2026-11-10', 'weekly-sync--hinted');
    store.attachTo(meeting);
    const record = createTranscriptRecord({ transcript: [], speakers: [] }, { id: 'hinted', title: 'Weekly sync' });
    writeFileSync(join(meeting, 'meeting.json'), JSON.stringify(createMeetingArtifact(record, {
      calendar: invite(Array.from({ length: 11 }, () => 'accepted')),
    })));
    // Ten people besides Tyler: past Nemotron 3's eight slots, so the helper uses community-1.
    expect((await separationOptions(join(meeting, 'capture', 'manifest.json'))).maxSpeakers).toBe(11);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only an event proven to be the call may cap its voices: its Meet code, or its app\'s link and a start within 10 minutes', () => {
  const startedAt = Date.parse('2026-11-10T15:04:00Z');
  const event = (overrides: Partial<MeetingCalendarEvent>) => ({ ...invite(['accepted', 'accepted']), ...overrides });
  const zoom = (calendar: MeetingCalendarEvent) => ({ id: 'audio:zoom', bundleId: 'us.zoom.xos', kind: 'dedicated' as const, calendar });
  const chrome = (calendar: MeetingCalendarEvent) => ({ id: 'audio:chrome', bundleId: 'com.google.Chrome', kind: 'browser' as const, calendar });
  const slack = (calendar: MeetingCalendarEvent) => ({ id: 'audio:slack', bundleId: 'com.tinyspeck.slackmacgap', kind: 'ambiguous' as const, calendar });
  const joined = (calendar: MeetingCalendarEvent) => ({ id: 'meet:chrome:/abc-defg-hij', bundleId: 'com.google.Chrome', kind: 'browser' as const, calendar });

  expect(calendarEventIsThisCall(zoom(event({ joinUrl: 'https://us02web.zoom.us/j/123?pwd=x' })), startedAt)).toBe(true);
  expect(calendarEventIsThisCall(zoom(event({ location: 'Zoom: https://zoom.us/j/123' })), startedAt)).toBe(true);
  // The nearest event, with nothing tying it to the call.
  expect(calendarEventIsThisCall(zoom(event({})), startedAt)).toBe(false);
  // Another service's link, or a look-alike host.
  expect(calendarEventIsThisCall(zoom(event({ joinUrl: 'https://teams.microsoft.com/l/meetup-join/1' })), startedAt)).toBe(false);
  expect(calendarEventIsThisCall(zoom(event({ joinUrl: 'https://notzoom.us/j/123' })), startedAt)).toBe(false);
  // The right link, but the event started 11 minutes from the recording.
  expect(calendarEventIsThisCall(zoom(event({ joinUrl: 'https://zoom.us/j/1', startAt: '2026-11-10T14:53:00Z' })), startedAt)).toBe(false);
  // A browser can run any video call; Slack's calls have no link to match.
  expect(calendarEventIsThisCall(chrome(event({ joinUrl: 'https://meet.google.com/xyz-abcd-efg' })), startedAt)).toBe(true);
  expect(calendarEventIsThisCall(slack(event({ joinUrl: 'https://zoom.us/j/1' })), startedAt)).toBe(false);
  // A joined Meet call is proven by its code alone, however late it was joined.
  expect(calendarEventIsThisCall(joined(event({ joinUrl: 'https://meet.google.com/abc-defg-hij', startAt: '2026-11-10T14:00:00Z' })), startedAt)).toBe(true);
  expect(calendarEventIsThisCall(joined(event({ joinUrl: 'https://meet.google.com/xyz-abcd-efg' })), startedAt)).toBe(false);
  expect(calendarEventIsThisCall({ ...zoom(event({})), calendar: undefined }, startedAt)).toBe(false);
});
