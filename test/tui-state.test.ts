import { describe, expect, test } from 'bun:test';
import {
  filterLibraryEntries,
  formatCompactDuration,
  formatLibraryEntryMeta,
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

  test('switches from two panes to a compact single-pane layout', () => {
    expect(tuiLayout(99, 24).compact).toBe(true);
    expect(tuiLayout(100, 24).compact).toBe(false);
    expect(tuiLayout(120, 36)).toMatchObject({
      compact: false,
      sidebarWidth: 33,
      visibleTranscriptRows: 27,
      visibleLibraryItems: 12,
    });
    expect(tuiLayout(80, 24)).toMatchObject({
      compact: true,
      sidebarWidth: 76,
      visibleTranscriptRows: 15,
      visibleLibraryItems: 6,
    });
  });

  test('formats scannable library metadata without noisy precision', () => {
    expect(formatCompactDuration(260)).toBe('4m20s');
    expect(formatCompactDuration(3660)).toBe('1h01m');
    const metadata = formatLibraryEntryMeta({
      id: 'one',
      title: 'Product interview',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
      duration: 260,
      sourceFilename: 'meeting.MP4',
      speakerCount: 2,
      segmentCount: 10,
      directory: '/tmp/one',
    });
    expect(metadata).toContain('4m20s');
    expect(metadata).toContain('2 speakers');
    expect(formatLibraryEntryMeta({
      id: 'one',
      title: 'Product interview',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
      duration: 260,
      sourceFilename: 'meeting.MP4',
      speakerCount: 2,
      segmentCount: 10,
      directory: '/tmp/one',
    }, true)).toContain('2spk');
  });
});
