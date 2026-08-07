import type {
  StructuredTranscript,
  TranscriptFormat,
  TranscriptSegment,
} from './transcript-types.ts';

export interface TranscriptRenderOptions {
  timestamps?: boolean;
  speakers?: boolean;
}

interface CueOptions {
  maxCharacters: number;
  maxDuration: number;
  maxGap: number;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function validSegments(document: StructuredTranscript): TranscriptSegment[] {
  return document.transcript
    .filter((segment) => (
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.start >= 0 &&
      segment.end >= segment.start &&
      segment.text.trim().length > 0
    ))
    .map((segment) => {
      const start = roundMilliseconds(segment.start);
      return {
        ...segment,
        start,
        end: Math.max(start + 0.001, roundMilliseconds(segment.end)),
        text: segment.text.trim(),
      };
    })
    .toSorted((a, b) => a.start - b.start || a.end - b.end);
}

export function speakerLabel(
  document: StructuredTranscript,
  speakerId: string | undefined,
): string | undefined {
  if (!speakerId) return undefined;
  return document.speakers.find((speaker) => speaker.id === speakerId)?.label || speakerId;
}

export function coalesceTranscriptSegments(
  document: StructuredTranscript,
  options: CueOptions = {
    maxCharacters: 120,
    maxDuration: 8,
    maxGap: 1.25,
  },
): TranscriptSegment[] {
  const result: TranscriptSegment[] = [];

  for (const segment of validSegments(document)) {
    const previous = result.at(-1);
    const combinedText = previous ? `${previous.text} ${segment.text}` : segment.text;
    const canMerge = previous !== undefined &&
      previous.speaker === segment.speaker &&
      segment.start - previous.end <= options.maxGap &&
      segment.end - previous.start <= options.maxDuration &&
      combinedText.length <= options.maxCharacters;

    if (canMerge) {
      previous.end = Math.max(previous.end, segment.end);
      previous.text = combinedText;
    } else {
      result.push({ ...segment });
    }
  }

  return result;
}

export function formatClock(seconds: number, separator = '.'): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const second = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minute = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return [
    String(hour).padStart(2, '0'),
    String(minute).padStart(2, '0'),
    String(second).padStart(2, '0'),
  ].join(':') + separator + String(milliseconds).padStart(3, '0');
}

export function renderText(
  document: StructuredTranscript,
  options: TranscriptRenderOptions = {},
): string {
  const segments = options.timestamps || options.speakers
    ? coalesceTranscriptSegments(document)
    : validSegments(document);

  if (!options.timestamps && !options.speakers) {
    return segments.map((segment) => segment.text).join(' ').replace(/\s+/gu, ' ').trim();
  }

  return segments.map((segment) => {
    const prefix: string[] = [];
    if (options.timestamps) prefix.push(`[${formatClock(segment.start)}]`);
    if (options.speakers) {
      const label = speakerLabel(document, segment.speaker);
      if (label) prefix.push(`${label}:`);
    }
    return `${prefix.join(' ')}${prefix.length ? ' ' : ''}${segment.text}`;
  }).join('\n');
}

function subtitleCues(document: StructuredTranscript): TranscriptSegment[] {
  return coalesceTranscriptSegments(document, {
    maxCharacters: 84,
    maxDuration: 7,
    maxGap: 1,
  });
}

function subtitleText(
  document: StructuredTranscript,
  segment: TranscriptSegment,
  includeSpeakers: boolean,
): string {
  const text = segment.text.replaceAll('-->', '→');
  if (!includeSpeakers) return text;
  const label = speakerLabel(document, segment.speaker);
  return label ? `[${label}] ${text}` : text;
}

export function renderSrt(
  document: StructuredTranscript,
  options: TranscriptRenderOptions = {},
): string {
  return subtitleCues(document).map((segment, index) => [
    String(index + 1),
    `${formatClock(segment.start, ',')} --> ${formatClock(segment.end, ',')}`,
    subtitleText(document, segment, options.speakers ?? true),
  ].join('\n')).join('\n\n') + (document.transcript.length ? '\n' : '');
}

export function renderVtt(
  document: StructuredTranscript,
  options: TranscriptRenderOptions = {},
): string {
  const body = subtitleCues(document).map((segment) => [
    `${formatClock(segment.start)} --> ${formatClock(segment.end)}`,
    subtitleText(document, segment, options.speakers ?? true),
  ].join('\n')).join('\n\n');
  return `WEBVTT\n\n${body}${body ? '\n' : ''}`;
}

export function renderTranscript(
  document: StructuredTranscript,
  format: TranscriptFormat,
  options: TranscriptRenderOptions = {},
): string {
  switch (format) {
    case 'text':
      return renderText(document, options);
    case 'json':
      return JSON.stringify(document, null, 2);
    case 'srt':
      return renderSrt(document, options);
    case 'vtt':
      return renderVtt(document, options);
  }
}
