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
  speaker: string;
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
