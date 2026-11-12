import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AutomaticMeetingWatchService, type AutomaticMeetingWatchEvent } from '../src/automatic-meeting-watch.ts';
import { readBriefAttempts, readComingUp, readNextMeeting, type Brief, type makeBrief } from '../src/briefs.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { loadMeetingArtifact } from '../src/meeting-artifact.ts';
import { NoBriefHistoryError } from '../src/briefs.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
const briefs = process.env.SEASHELL_BRIEFS_DIR;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.SEASHELL_BRIEFS_DIR = briefs;
});

/** A library of its own, with its own Briefs folder beside it, as a real install has. */
function folder(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  process.env.SEASHELL_BRIEFS_DIR = join(root, 'Briefs');
  return join(root, 'Transcripts');
}

test('a note typed in a terminal during a recording lands in its bundle, timed when typed, and in the saved meeting', async () => {
  const root = folder('seashell-watch-notes-');
  let now = Date.parse('2026-11-10T15:00:00Z');
  const commands: Array<'start' | 'stop' | undefined> = ['start'];
  const notes: Array<Array<{ text: string; createdAtUnixMs: number }>> = [];
  const events: AutomaticMeetingWatchEvent[] = [];
  const service = new AutomaticMeetingWatchService({
    config: { libraryDir: root, meeting: { automation: { confirmationPolls: 1, endGraceSeconds: 20, resumeWindowSeconds: 0 } } },
    onEvent: (event) => events.push(event),
    dependencies: {
      now: () => new Date(now),
      readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: now, supported: true, inputProcesses: [] }),
      consumeCommand: () => commands.shift(),
      consumeNotes: () => notes.shift() ?? [],
      startCapture: (capture) => {
        const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'by-hand', startedAtUnixMs: capture.startedAt!.getTime(),
          createdAt: capture.startedAt!.toISOString() });
        return { store, sessionId: 'by-hand', manifestPath: store.manifestPath, async stop() { return store.setStatus('captured', 'test'); } };
      },
      finalizeCapture: async () => createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'Hello.' }], speakers: [] },
        { id: 'by-hand', now: new Date('2026-11-10T15:00:00Z'), title: 'Recording' }),
    },
  });
  try {
    expect((await service.pollOnce()).kind).toBe('start');
    // Typed at 2:05 and read on the poll after; the note keeps the time it was typed.
    now += 130_000;
    notes.push([{ text: 'Dana sounded unsure', createdAtUnixMs: Date.parse('2026-11-10T15:02:05Z') }]);
    // A note just before stopping is still part of the recording.
    notes.push([{ text: 'Last thing before stop', createdAtUnixMs: Date.parse('2026-11-10T15:02:10Z') }]);
    await service.pollOnce();
    commands.push('stop');
    now += 3_000;
    await service.pollOnce();
  } finally { await service.shutdown(); }
  expect(loadMeetingArtifact(root, 'by-hand')?.ownerNotes?.map((note) => [note.at, note.text]))
    .toEqual([[125, 'Dana sounded unsure'], [130, 'Last thing before stop']]);
  // With nothing recording, a stray note is not kept anywhere, and says so.
  notes.push([{ text: 'Too late', createdAtUnixMs: now }]);
  const idle = new AutomaticMeetingWatchService({ config: { libraryDir: root }, onEvent: (event) => events.push(event),
    dependencies: { now: () => new Date(now), readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: now, supported: true, inputProcesses: [] }),
      consumeCommand: () => undefined, consumeNotes: () => notes.shift() ?? [] } });
  await idle.pollOnce();
  await idle.shutdown();
  expect(events.some((event) => event.type === 'watch.warning' && event.message.includes('nothing recording'))).toBe(true);
});

function briefWatch(root: string, makeBriefFake: typeof makeBrief, at = '2026-11-20T14:44:00Z') {
  let now = Date.parse(at);
  const notified: string[] = [];
  const events: AutomaticMeetingWatchEvent[] = [];
  const service = new AutomaticMeetingWatchService({
    config: { libraryDir: root, meeting: { backend: 'codex', model: 'fixture', mode: 'post-session',
      calendar: { enabled: true, policy: 'ask' } } },
    onEvent: (event) => events.push(event),
    dependencies: {
      now: () => new Date(now),
      readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: now, supported: true, inputProcesses: [] }),
      readCalendar: async () => [{ provider: 'macos-eventkit', eventId: 'weekly', title: 'Weekly sync', calendar: 'sam@example.com',
        startAt: '2026-11-20T15:00:00Z', endAt: '2026-11-20T15:30:00Z', attendees: [] }],
      consumeCommand: () => undefined,
      consumeNotes: () => [],
      makeBrief: makeBriefFake,
      notify: (message) => notified.push(message),
    },
  });
  return { service, notified, events, tick: (ms: number) => { now += ms; } };
}

const settle = () => Bun.sleep(20);

test('about 15 minutes before a meeting with history the recorder writes a brief and says so once', async () => {
  const root = folder('seashell-watch-briefs-');
  const made: string[] = [];
  const fake = (async (_library: string, upcoming: { title: string }) => {
    made.push(upcoming.title);
    return { path: '/briefs/Weekly sync.md' } as Brief;
  }) as unknown as typeof makeBrief;
  const { service, notified, events, tick } = briefWatch(root, fake);
  try {
    // 16 minutes ahead: the calendar is read, the next meeting is published, no brief yet.
    await service.pollOnce(); await settle();
    expect(readNextMeeting(root, new Date('2026-11-20T14:44:00Z'))?.upcoming.title).toBe('Weekly sync');
    await service.pollOnce(); await settle();
    expect(made).toEqual([]);
    // 14 minutes ahead: one brief, one notification, however often it polls.
    tick(2 * 60_000);
    for (let poll = 0; poll < 4; poll += 1) { await service.pollOnce(); await settle(); }
  } finally { await service.shutdown(); }
  expect(made).toEqual(['Weekly sync']);
  expect(notified).toEqual(['Brief ready for Weekly sync']);
  expect(events.filter((event) => event.type === 'brief.ready')).toHaveLength(1);
});

test('a meeting with no history gets no brief and no notification, and is not tried again', async () => {
  const root = folder('seashell-watch-no-brief-');
  let tries = 0;
  const fake = (async (_library: string, upcoming: { title: string }) => { tries += 1; throw new NoBriefHistoryError(upcoming.title); }) as unknown as typeof makeBrief;
  const { service, notified, events } = briefWatch(root, fake, '2026-11-20T14:50:00Z');
  try {
    for (let poll = 0; poll < 4; poll += 1) { await service.pollOnce(); await settle(); }
  } finally { await service.shutdown(); }
  expect(tries).toBe(1);
  expect(notified).toEqual([]);
  expect(events.some((event) => event.type === 'watch.warning')).toBe(false);
  expect(Object.values(readBriefAttempts(root))).toEqual([expect.objectContaining({ outcome: 'no-history' })]);
});

test('briefs turned off, or no AI chosen, means the recorder never writes one', async () => {
  const root = folder('seashell-watch-briefs-off-');
  let tries = 0;
  const fake = (async () => { tries += 1; return {} as Brief; }) as unknown as typeof makeBrief;
  for (const meeting of [{ backend: 'codex' as const, model: 'fixture', briefs: { enabled: false } }, {}]) {
    const service = new AutomaticMeetingWatchService({
      config: { libraryDir: root, meeting: { ...meeting, calendar: { enabled: true, policy: 'ask' } } },
      dependencies: {
        now: () => new Date('2026-11-20T14:50:00Z'),
        readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: 0, supported: true, inputProcesses: [] }),
        readCalendar: async () => [{ provider: 'macos-eventkit', eventId: 'weekly', title: 'Weekly sync', startAt: '2026-11-20T15:00:00Z',
          endAt: '2026-11-20T15:30:00Z', attendees: [] }],
        consumeCommand: () => undefined, consumeNotes: () => [], makeBrief: fake,
      },
    });
    for (let poll = 0; poll < 3; poll += 1) { await service.pollOnce(); await settle(); }
    await service.shutdown();
  }
  expect(tries).toBe(0);
});

test('the recorder tells the app about tomorrow morning too: every meeting in the next 36 hours, the nearest first', async () => {
  const root = folder('seashell-watch-coming-up-');
  const at = '2026-11-20T22:00:00Z';
  const now = Date.parse(at);
  const reads: number[] = [];
  const event = (id: string, title: string, start: string) => ({ provider: 'macos-eventkit', eventId: id, title, attendees: [],
    startAt: start, endAt: new Date(Date.parse(start) + 30 * 60_000).toISOString() });
  const service = new AutomaticMeetingWatchService({
    config: { libraryDir: root, meeting: { backend: 'codex', model: 'fixture', mode: 'post-session', calendar: { enabled: true, policy: 'ask' } } },
    dependencies: {
      now: () => new Date(now),
      readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: now, supported: true, inputProcesses: [] }),
      readCalendar: async (options: { leadMinutes?: number }) => {
        reads.push(options.leadMinutes ?? 0);
        // Out of order, as a calendar may give them; one is already over.
        return [event('lunch', 'Lunch with Sam', '2026-11-21T12:30:00Z'), event('acme', 'Acme check-in', '2026-11-21T10:00:00Z'),
          event('done', 'Earlier', '2026-11-20T20:00:00Z')];
      },
      consumeCommand: () => undefined, consumeNotes: () => [],
      makeBrief: (async () => { throw new Error('not due'); }) as unknown as typeof makeBrief, notify: () => {},
    },
  } as never);
  try { await service.pollOnce(); await settle(); } finally { await service.shutdown(); }
  expect(reads).toContain(36 * 60);
  expect(readComingUp(root, new Date(now)).map((meeting) => meeting.upcoming.title)).toEqual(['Acme check-in', 'Lunch with Sam']);
  // An app from before the list still reads the nearest one where it always was.
  expect(readNextMeeting(root, new Date(now))?.upcoming.title).toBe('Acme check-in');
});
