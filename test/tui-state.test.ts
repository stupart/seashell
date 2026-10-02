import { describe, expect, test } from 'bun:test';
import {
  filterLibraryEntries,
  meetingEntryLabel,
  formatTuiClock,
  moveSelection,
  moveTranscriptScroll,
  speakerColorIndex,
  tuiLayout,
} from '../src/tui-state.ts';

describe('TUI navigation state', () => {
  test('clamps sidebar selection and transcript scrolling', () => {
    expect(moveSelection(0, -1, 4)).toBe(0);
    expect(moveSelection(2, 1, 4)).toBe(3);
    expect(moveSelection(3, 1, 4)).toBe(3);
    expect(moveTranscriptScroll(0, 5, 20, 8)).toBe(5);
    expect(moveTranscriptScroll(10, 10, 20, 8)).toBe(12);
  });

  test('filters library navigation without mutating the canonical list', () => {
    const entries = [{
      id: 'one',
      title: 'Product interview',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
      sourceFilename: 'meeting.MP4',
      speakerCount: 2,
      segmentCount: 10,
      kind: 'transcript' as const,
      directory: '/tmp/one',
    }];
    expect(filterLibraryEntries(entries, 'mp4')).toEqual(entries);
    expect(filterLibraryEntries(entries, 'missing')).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  test('assigns stable speaker colors', () => {
    expect(speakerColorIndex('SPEAKER_00')).toBe(speakerColorIndex('SPEAKER_00'));
    expect(speakerColorIndex('SPEAKER_00')).toBeGreaterThanOrEqual(0);
    expect(speakerColorIndex('SPEAKER_00')).toBeLessThan(6);
  });

  test('formats a compact media-relative clock for the terminal', () => {
    expect(formatTuiClock(4.9)).toBe('00:04');
    expect(formatTuiClock(65)).toBe('01:05');
    expect(formatTuiClock(3_661)).toBe('1:01:01');
  });

  test('keeps the history drawer beside the transcript until space gets tight', () => {
    expect(tuiLayout(71, 24).compact).toBe(true);
    expect(tuiLayout(72, 24).compact).toBe(false);
    expect(tuiLayout(120, 36)).toMatchObject({
      compact: false,
      sidebarWidth: 33,
      visibleTranscriptRows: 27,
      visibleLibraryItems: 24,
    });
    expect(tuiLayout(80, 24)).toMatchObject({
      compact: false,
      sidebarWidth: 24,
      visibleTranscriptRows: 15,
      visibleLibraryItems: 12,
    });
    expect(tuiLayout(60, 24)).toMatchObject({
      compact: true,
      sidebarWidth: 56,
    });
  });
});

test('meeting rows lead with day, time and length so same-titled meetings differ', () => {
  const entry = (createdAt: string, duration?: number, captureState?: 'recording') => ({
    id: 'm', title: 'Google Meet', createdAt, updatedAt: createdAt, sourceFilename: 'Live capture session',
    speakerCount: 0, segmentCount: 0, kind: 'meeting' as const, directory: '/tmp/m',
    ...(duration === undefined ? {} : { duration }), ...(captureState ? { captureState } : {}),
  });
  const now = new Date(2026, 9, 2, 15, 0);
  const time = (date: Date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const earlier = new Date(2026, 9, 1, 9, 28);
  const today = new Date(2026, 9, 2, 10, 3);
  expect(meetingEntryLabel(entry(earlier.toISOString(), 2_064), now))
    .toBe(`M ${earlier.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time(earlier)} · 34m · Google Meet`);
  expect(meetingEntryLabel(entry(today.toISOString(), 4_400), now)).toBe(`M ${time(today)} · 1h13m · Google Meet`);
  expect(meetingEntryLabel(entry(today.toISOString(), 3_600), now)).toBe(`M ${time(today)} · 1h · Google Meet`);
  expect(meetingEntryLabel(entry(today.toISOString(), 300, 'recording'), now)).toBe(`● ${time(today)} · Google Meet`);
});
