import { spawn } from 'child_process';
import { diarizationStatus, resolveDiarizationPython } from './diarization-environment.ts';
import { helperModelLabel, speakerEngine, speakerEngineArguments, speakersHelper, usesSpeakersHelper, type SpeakerEngine } from './speaker-engine.ts';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { inferenceCommand } from './inference-priority.ts';
import { prepareMedia, type PreparedMedia } from './media-preparation.ts';
import { mergeDiarization } from './merge-diarization.ts';
import {
  beginManagedProcessSession,
  trackChildProcess,
} from './process-lifecycle.ts';
import {
  applySpeakerLabels,
  EvidenceSpeakerLabeler,
  type SpeakerLabeler,
  type SpeakerLabelingEvidence,
} from './speaker-labeling.ts';
import {
  applyTranscriptEnrichment,
  type TranscriptEnricher,
} from './transcript-enrichment.ts';
import type {
  DiarizationTurn,
  Speaker,
  StructuredTranscript,
  TimedTranscriptUnit,
} from './transcript-types.ts';
import { transcribeWithTimestamps } from './whisper-timestamps.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const DIARIZATION_SCRIPT = join(PROJECT_ROOT, 'scripts/diarize.py');

interface ProcessResult {
  stdout: string;
  stderr: string;
}

/** One separated speaker's voice: src/voiceprints.ts recognises people with it. */
export interface SpeakerVoice {
  /** L2-normalised voice embedding. */
  embedding: number[];
  /** Seconds of clean speech it was taken from. */
  seconds: number;
  /** The speaker's turns, so a later rename can check it names the same voice. */
  spans: Array<[number, number]>;
}

interface PythonDiarization {
  turns: DiarizationTurn[];
  speakers: Speaker[];
  /** Which model the helper used: auto picks one per channel. */
  model?: string;
  /** One voice embedding per speaker, from the native helper only. */
  voices?: Map<string, SpeakerVoice>;
}

export interface DiarizeFileOptions {
  /** Overrides the configured engine; `seashell speakers compare` tries one without switching. */
  engine?: SpeakerEngine;
  /**
   * Roles in physical channel order. For a two-channel meeting recording this
   * is normally ["local", "remote"], but callers must verify their routing.
   */
  channelRoles?: string[];
  numSpeakers?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
  audioStreamIndex?: number;
  model?: string;
  pythonPath?: string;
  speakerLabeler?: SpeakerLabeler;
  labelingEvidence?: SpeakerLabelingEvidence;
  enricher?: TranscriptEnricher;
  onWhisperProgress?: (percentage: number) => void;
  onWhisperFallback?: (message: string) => void;
  onDiarizationMessage?: (message: string) => void;
  onMediaStatus?: (message: string) => void;
  /** Each separated speaker's voice and turns, keyed by diarization speaker ID, for src/voiceprints.ts. */
  onVoices?: (voices: ReadonlyMap<string, SpeakerVoice>) => void;
}

async function runProcess(
  command: string,
  args: string[],
  onStderr?: (message: string) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    // Speaker separation runs after the call, at Darwin background priority.
    const run = inferenceCommand(command, args, 'background');
    const proc = spawn(run.command, run.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', PYANNOTE_METRICS_ENABLED: '0' },
    });
    const stopTracking = trackChildProcess(proc);

    let stdout = '';
    let stderr = '';
    let settled = false;

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data) => {
      const message = data.toString();
      stderr = (stderr + message).slice(-16000);
      onStderr?.(message);
    });
    proc.on('error', (error) => {
      stopTracking();
      if (settled) return;
      settled = true;
      reject(new Error(`Could not start ${command}: ${error.message}`));
    });
    proc.on('close', (code) => {
      stopTracking();
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`${command} failed (${code}): ${stderr.trim() || 'no details'}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function splitChannels(
  audio: PreparedMedia,
  channelRoles: string[],
): Promise<Array<{ path: string; role: string }>> {
  const count = audio.selectedAudioStream.channels;
  if (!count) throw new Error(`Could not determine channel count for ${audio.sourcePath}`);
  if (count !== channelRoles.length) {
    throw new Error(
      `--channel-roles listed ${channelRoles.length} roles, but the audio has ${count} channels`,
    );
  }

  const channels: Array<{ path: string; role: string }> = [];
  for (const [index, providedRole] of channelRoles.entries()) {
    const role = providedRole.trim().toLowerCase();
    if (!role) throw new Error('Channel roles cannot be empty');
    const channelPath = join(dirname(audio.path), `channel-${index + 1}.wav`);
    await runProcess('sox', [
      audio.path,
      channelPath,
      'remix',
      String(index + 1),
    ]);
    channels.push({ path: channelPath, role });
  }
  return channels;
}

async function transcribePreparedAudio(
  audio: PreparedMedia,
  options: DiarizeFileOptions,
): Promise<TimedTranscriptUnit[]> {
  if (!options.channelRoles) {
    return transcribeWithTimestamps(audio.path, {
      onProgress: options.onWhisperProgress,
      onFallback: options.onWhisperFallback,
    });
  }

  // Transcribe known channels independently. Besides preserving overlap, this
  // makes local-vs-remote routing authoritative before speaker clustering.
  const channels = await splitChannels(audio, options.channelRoles);
  const units: TimedTranscriptUnit[] = [];
  for (const channel of channels) {
    const channelUnits = await transcribeWithTimestamps(channel.path, {
      onProgress: options.onWhisperProgress,
      onFallback: options.onWhisperFallback,
    });
    units.push(...channelUnits.map((unit) => ({ ...unit, role: channel.role })));
  }

  return units.toSorted(
    (a, b) =>
      (a.anchor ?? a.start) - (b.anchor ?? b.start) ||
      a.start - b.start ||
      a.end - b.end,
  );
}

/**
 * The most voices the remote channel should hold, from the calendar invite.
 *
 * Everyone invited who hasn't declined, minus Tyler, plus one seat for a guest
 * who wasn't invited or a Tyler missing from his own list. The extra seat is
 * cheap and a missing one is not: on four AMI meetings a ceiling one below the
 * real count raised wrong-speaker words from 4.5% to 14.0%, while a ceiling
 * one above changed nothing. A meeting room can seat several people behind
 * one invite, so an invite with a room gives no ceiling.
 */
export function remoteVoiceCeiling(attendees: readonly { email?: string; response?: string }[]): number | undefined {
  if (attendees.some((attendee) => /@resource\.calendar\.google\.com$/iu.test(attendee.email ?? ''))) return undefined;
  const invited = attendees.filter((attendee) => attendee.response !== 'declined').length;
  if (invited < 2) return undefined;
  const remote = invited - 1;
  return remote + 1;
}

function positiveIntegerArgument(
  args: string[],
  flag: string,
  value: number | undefined,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  args.push(flag, String(value));
}

function parsePythonDiarization(value: unknown): PythonDiarization {
  if (!value || typeof value !== 'object') {
    throw new Error('Diarization script returned invalid JSON');
  }

  const candidate = value as { turns?: unknown; speakers?: unknown };
  if (!Array.isArray(candidate.turns) || !Array.isArray(candidate.speakers)) {
    throw new Error('Diarization JSON is missing turns or speakers');
  }

  const turns = candidate.turns.map((raw, index): DiarizationTurn => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Diarization turn ${index} is invalid`);
    }
    const turn = raw as Record<string, unknown>;
    if (
      typeof turn.start !== 'number' ||
      typeof turn.end !== 'number' ||
      !Number.isFinite(turn.start) ||
      !Number.isFinite(turn.end) ||
      turn.start < 0 ||
      turn.end < turn.start ||
      typeof turn.speaker !== 'string' ||
      !turn.speaker.trim()
    ) {
      throw new Error(`Diarization turn ${index} has invalid fields`);
    }
    if (turn.role !== undefined && typeof turn.role !== 'string') {
      throw new Error(`Diarization turn ${index} has an invalid role`);
    }
    return {
      start: turn.start,
      end: turn.end,
      speaker: turn.speaker,
      ...(typeof turn.role === 'string' ? { role: turn.role } : {}),
    };
  });

  const speakers = candidate.speakers.map((raw, index): Speaker => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Speaker ${index} is invalid`);
    }
    const speaker = raw as Record<string, unknown>;
    if (
      typeof speaker.id !== 'string' ||
      !speaker.id.trim() ||
      typeof speaker.label !== 'string' ||
      !speaker.label.trim()
    ) {
      throw new Error(`Speaker ${index} has invalid fields`);
    }
    return { id: speaker.id, label: speaker.label };
  });

  // Voices are optional: an older helper or the Python script has none, and a
  // malformed one is dropped rather than failing the meeting.
  const voices = new Map<string, SpeakerVoice>();
  const rawVoices = (value as { voices?: unknown }).voices;
  if (rawVoices && typeof rawVoices === 'object' && !Array.isArray(rawVoices)) {
    for (const [id, raw] of Object.entries(rawVoices as Record<string, unknown>)) {
      const voice = raw as { embedding?: unknown; seconds?: unknown } | null;
      if (!voice || !Array.isArray(voice.embedding) || voice.embedding.length === 0 ||
          !voice.embedding.every((x) => typeof x === 'number' && Number.isFinite(x)) ||
          typeof voice.seconds !== 'number' || !Number.isFinite(voice.seconds)) continue;
      const spans = turns.filter((turn) => turn.speaker === id).map((turn): [number, number] => [turn.start, turn.end]);
      voices.set(id, { embedding: voice.embedding as number[], seconds: voice.seconds, spans });
    }
  }
  const model = (value as { model?: unknown }).model;
  return { turns, speakers, ...(typeof model === 'string' && model ? { model } : {}), ...(voices.size ? { voices } : {}) };
}

/**
 * Separate speakers with the configured engine. The native helper prints the
 * same JSON as scripts/diarize.py; an explicit Python or pyannote model always
 * means Python.
 */
export async function runSpeakerSeparation(
  audioPath: string,
  options: DiarizeFileOptions,
): Promise<PythonDiarization> {
  const engine = options.engine ?? speakerEngine();
  if (options.pythonPath || options.model || !usesSpeakersHelper(engine)) return runPythonDiarization(audioPath, options);
  const args = [audioPath, ...speakerEngineArguments(engine)];
  if (options.channelRoles) args.push('--channel-roles', options.channelRoles.join(','));
  positiveIntegerArgument(args, '--num-speakers', options.numSpeakers);
  positiveIntegerArgument(args, '--min-speakers', options.minSpeakers);
  positiveIntegerArgument(args, '--max-speakers', options.maxSpeakers);
  const result = await runProcess(speakersHelper(), args, options.onDiarizationMessage);
  try {
    const diarization = parsePythonDiarization(JSON.parse(result.stdout));
    return diarization.model ? { ...diarization, model: helperModelLabel(diarization.model) } : diarization;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The speaker helper wrote malformed JSON');
    throw error;
  }
}

async function runPythonDiarization(
  audioPath: string,
  options: DiarizeFileOptions,
): Promise<PythonDiarization> {
  const args = [DIARIZATION_SCRIPT, audioPath];
  if (options.channelRoles) {
    args.push('--channel-roles', options.channelRoles.join(','));
  }
  if (options.model) args.push('--model', options.model);
  positiveIntegerArgument(args, '--num-speakers', options.numSpeakers);
  positiveIntegerArgument(args, '--min-speakers', options.minSpeakers);
  positiveIntegerArgument(args, '--max-speakers', options.maxSpeakers);

  const result = await runProcess(
    resolveDiarizationPython(options.pythonPath),
    args,
    options.onDiarizationMessage,
  );

  try {
    return parsePythonDiarization(JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Diarization script wrote malformed JSON');
    }
    throw error;
  }
}

function completeSpeakerList(
  speakers: Speaker[],
  transcript: StructuredTranscript['transcript'],
): Speaker[] {
  const labels = new Map(speakers.map((speaker) => [speaker.id, speaker.label]));
  for (const segment of transcript) {
    if (!segment.speaker) continue;
    if (!labels.has(segment.speaker)) {
      labels.set(
        segment.speaker,
        segment.speaker === 'UNKNOWN' ? 'unknown' : segment.speaker,
      );
    }
  }
  return [...labels].map(([id, label]) => ({ id, label }));
}

/**
 * Enrich already-prepared media with pyannote speakers. Whisper runs exactly
 * once per prepared channel and its timed units are reused for alignment.
 */
export async function diarizePreparedMedia(
  audio: PreparedMedia,
  options: DiarizeFileOptions = {},
): Promise<StructuredTranscript> {
  const endManagedSession = beginManagedProcessSession();
  try {
    // Fail fast on missing Python dependencies, gated model access, or invalid
    // channel routing before spending time on one or more Whisper passes.
    const diarization = await runSpeakerSeparation(audio.path, options);
    if (diarization.voices) options.onVoices?.(diarization.voices);
    const transcriptUnits = await transcribePreparedAudio(audio, options);
    const roleSpeakers = Object.fromEntries(
      (options.channelRoles ?? [])
        .map((role) => role.trim().toLowerCase())
        .filter((role) => role === 'local')
        .map((role) => [role, 'LOCAL']),
    );
    const transcript = mergeDiarization(
      transcriptUnits,
      diarization.turns,
      { roleSpeakers },
    );

    const identities = new Map(diarization.speakers.map((speaker, index) => [speaker.id,
      speaker.label === speaker.id ? `Speaker ${index + 1}` : speaker.label]));
    let document: StructuredTranscript = {
      speakerAnalysis: { status: 'complete', model: options.model ?? diarization.model ?? diarizationStatus().model,
        detail: 'Voices separated locally. Speaker numbers apply to this recording; names need confirmation.' },
      transcript,
      speakers: completeSpeakerList(diarization.speakers.map((s) => ({ ...s, label: identities.get(s.id)! })), transcript),
    };

    document = await applySpeakerLabels(
      document,
      options.speakerLabeler ?? new EvidenceSpeakerLabeler(),
      options.labelingEvidence ?? { screenshots: [], attendees: [] },
    );

    if (options.enricher) {
      document = await applyTranscriptEnrichment(document, options.enricher);
    }

    return document;
  } finally {
    endManagedSession();
  }
}

/** Prepare a source file, then run the speaker-aware timestamp pipeline. */
export async function diarizeFile(
  filePath: string,
  options: DiarizeFileOptions = {},
): Promise<StructuredTranscript> {
  const audio = await prepareMedia(filePath, {
    preserveChannels: true,
    audioStreamIndex: options.audioStreamIndex,
    onStatus: options.onMediaStatus,
  });
  try {
    return await diarizePreparedMedia(audio, options);
  } finally {
    audio.cleanup();
  }
}
