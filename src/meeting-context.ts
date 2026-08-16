import { readFileSync, statSync } from 'fs';
import { basename, resolve } from 'path';
import type { MeetingCalendarEvent } from './meeting-artifact.ts';

const MAX_CONTEXT_FILE_BYTES = 512 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 2 * 1024 * 1024;

export interface MeetingContextDocument {
  readonly name: string;
  readonly content: string;
}

/** Load an explicit, bounded allow-list of context files; Sea Shell never scans nearby folders. */
export function loadMeetingContextFiles(paths: readonly string[] = []): MeetingContextDocument[] {
  let total = 0;
  return paths.map((configuredPath) => {
    const path = resolve(configuredPath);
    const metadata = statSync(path);
    if (!metadata.isFile()) throw new Error(`Meeting context is not a file: ${path}`);
    if (metadata.size > MAX_CONTEXT_FILE_BYTES) {
      throw new Error(`Meeting context file exceeds 512 KiB: ${path}`);
    }
    total += metadata.size;
    if (total > MAX_CONTEXT_TOTAL_BYTES) {
      throw new Error('Meeting context files exceed the 2 MiB total limit');
    }
    return Object.freeze({
      name: basename(path),
      content: readFileSync(path, 'utf8'),
    });
  });
}

export function buildMeetingContext(
  paths: readonly string[] | undefined,
  calendar?: MeetingCalendarEvent,
): Record<string, unknown> {
  return {
    calendar: calendar ?? null,
    attendees: calendar?.attendees ?? [],
    documents: loadMeetingContextFiles(paths),
  };
}
