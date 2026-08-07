export interface TimedTranscriptUnit {
  start: number;
  end: number;
  text: string;
  /** Known source-channel role, when a stereo file was split before ASR. */
  role?: string;
  /** DTW timing point used for speaker assignment when available. */
  anchor?: number;
}

export interface DiarizationTurn {
  start: number;
  end: number;
  speaker: string;
  role?: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  /** Stable diarization cluster ID. Human-readable names live in speakers. */
  speaker?: string;
  text: string;
}

export interface Speaker {
  id: string;
  label: string;
}

export interface ActionItem {
  owner: string;
  task: string;
}

export interface TranscriptInsights {
  summary?: string;
  decisions?: string[];
  action_items?: ActionItem[];
}

export interface StructuredTranscript extends TranscriptInsights {
  transcript: TranscriptSegment[];
  speakers: Speaker[];
}

export interface TranscriptSource {
  path?: string;
  filename: string;
  duration?: number;
  format?: string;
  audioStreamIndex?: number;
  channels?: number;
}

/** Canonical, durable representation used by renderers and the library. */
export interface TranscriptRecord extends StructuredTranscript {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  source: TranscriptSource;
}

export type TranscriptFormat = 'text' | 'json' | 'srt' | 'vtt';
