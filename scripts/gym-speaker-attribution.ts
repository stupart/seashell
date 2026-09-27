import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CaptureSessionStore, loadCaptureSession, readVerifiedCaptureChunk } from '../src/capture-session.ts';
import { saveFinalizedCapture } from '../src/capture-finalizer.ts';
import { pcmS16leToWav } from '../src/live-system-audio.ts';
import type { MeetSample } from '../src/meet-speakers.ts';
import { evaluateSpeakerAttribution, type SpeakerEvaluation, type SpeakerReferenceTurn } from '../src/speaker-evaluation.ts';
import { findTranscriptRecord } from '../src/transcript-library.ts';
import type { TimedTranscriptUnit, TranscriptSegment } from '../src/transcript-types.ts';

const ax = 'google-meet-accessibility' as const;
const alice = { id: 'MEET_aaaaaaaaaaaaaaaaaaaa', label: 'Alice' };
const bob = { id: 'MEET_bbbbbbbbbbbbbbbbbbbb', label: 'Bob' };
const alicia = { id: 'MEET_cccccccccccccccccccc', label: 'Alicia' };
const meeting = '/abc-defg-hij';
const observation = (at: number, speaker?: typeof alice, source: TranscriptSegment['speakerSource'] = ax): MeetSample => ({
  at, meeting, browser: 'chrome', ...(speaker ? { speaker } : {}), ...(source ? { source } : {}),
});
const remote = (id: string, start: number, end: number, ...speakers: string[]): SpeakerReferenceTurn => ({ id, start, end, channel: 'system-audio', speakers });
const unit = (start: number, end: number, text: string): TimedTranscriptUnit => ({ start, end, text });

interface ReplayCase {
  id: string;
  detail: string;
  /** Ground truth is authored separately from the input observations. */
  reference: SpeakerReferenceTurn[];
  observations: MeetSample[];
  system: TimedTranscriptUnit[];
  microphone?: TimedTranscriptUnit[];
  minimumNamedCoverage: number;
  expectedUnknownSeconds?: number;
  expectedSafeAbstentionSeconds?: number;
  expectedNamedSource?: TranscriptSegment['speakerSource'];
  sourceMarkers?: Array<{ text: string; channel: 'microphone' | 'system-audio' }>;
}

/** The tone is only a persisted PCM carrier; fixture ASR text is injected.
 * These cases exercise save/recovery boundaries, not speech recognition or AX. */
function cases(): ReplayCase[] {
  return [
    {
      id: 'two-remote-speakers', detail: 'Two independently labelled remote turns retain their names.',
      reference: [remote('alice-turn', 1, 2, 'Alice'), remote('bob-turn', 4, 5, 'Bob')],
      observations: [observation(.5, alice), observation(1, alice), observation(1.5, alice), observation(2, alice),
        observation(2.5, alice), observation(3.5, bob), observation(4, bob), observation(4.5, bob), observation(5, bob), observation(5.5, bob)],
      system: [unit(1, 2, 'The garden gate opens tomorrow.'), unit(4, 5, 'My delivery arrives on Thursday.')],
      minimumNamedCoverage: 1,
    },
    {
      id: 'remote-overlap', detail: 'Simultaneous remote speech stays unnamed; a later isolated turn is named.',
      reference: [remote('both-talking', 1, 2, 'Alice', 'Bob'), remote('alice-alone', 3, 4, 'Alice')],
      observations: [observation(.5, alice), observation(1), observation(1.5), observation(2),
        observation(2.5, alice), observation(3, alice), observation(3.5, alice), observation(4, alice), observation(4.5, alice)],
      system: [unit(1, 2, 'We both spoke at the same time.'), unit(3, 4, 'The budget is approved.')],
      minimumNamedCoverage: 1, expectedSafeAbstentionSeconds: 1,
    },
    {
      id: 'missing-markers', detail: 'Speech is retained when the participant marker disappears.',
      reference: [remote('alice-hidden', 1, 2, 'Alice'), remote('bob-visible', 4, 5, 'Bob')],
      observations: [observation(.5, alice), observation(1), observation(1.5), observation(2),
        observation(3.5, bob), observation(4, bob), observation(4.5, bob), observation(5, bob), observation(5.5, bob)],
      system: [unit(1, 2, 'The proposal still needs a review.'), unit(4, 5, 'I can review it after lunch.')],
      minimumNamedCoverage: .5, expectedUnknownSeconds: 1,
    },
    {
      id: 'reader-gap', detail: 'A multi-second read outage cannot borrow the same name from its endpoints.',
      reference: [remote('unobserved-alice', 1, 2, 'Alice'), remote('observed-alice', 6, 7, 'Alice')],
      observations: [observation(0, alice), observation(.5, alice), observation(4, alice), observation(4.5, alice),
        observation(5.5, alice), observation(6, alice), observation(6.5, alice), observation(7, alice), observation(7.5, alice)],
      system: [unit(1, 2, 'Keep these words through a read outage.'), unit(6, 7, 'The visible speaker returns.')],
      minimumNamedCoverage: .5, expectedUnknownSeconds: 1,
    },
    {
      id: 'name-change', detail: 'Display-name changes retain earlier names and abstain across the transition.',
      reference: [remote('before', 1, 2, 'Alice'), remote('change-before', 2.5, 2.75, 'Alice'),
        remote('change-after', 2.75, 3, 'Alicia'), remote('after', 4, 5, 'Alicia')],
      observations: [observation(.5, alice), observation(1, alice), observation(1.5, alice), observation(2, alice), observation(2.5, alice),
        observation(2.75, alicia), observation(3, alicia), observation(3.5, alicia), observation(4, alicia), observation(4.5, alicia), observation(5, alicia)],
      system: [unit(1, 2, 'Please use the old display name here.'), unit(2.5, 3, 'The name changes during this sentence.'), unit(4, 5, 'The new name is now visible.')],
      minimumNamedCoverage: .8, expectedUnknownSeconds: .5,
    },
    {
      id: 'stable-id-rename', detail: 'Historical evidence with a reused ID must not retroactively rename earlier speech.',
      reference: [remote('old-label', 1, 2, 'Alice'), remote('new-label', 4, 5, 'Alicia')],
      observations: [observation(.5, alice), observation(1, alice), observation(1.5, alice), observation(2, alice),
        observation(3.5, { ...alice, label: 'Alicia' }), observation(4, { ...alice, label: 'Alicia' }),
        observation(4.5, { ...alice, label: 'Alicia' }), observation(5, { ...alice, label: 'Alicia' })],
      system: [unit(1, 2, 'My display name was Alice.'), unit(4, 5, 'My display name is now Alicia.')],
      // Correct versioned names or a conservative abstention are both safe.
      minimumNamedCoverage: 0,
    },
    {
      id: 'simultaneous-local-microphone', detail: 'A remote name must never replace local microphone words, including double talk.',
      reference: [remote('remote', 1, 3, 'Alice'), { id: 'local', start: 1.5, end: 2.5, channel: 'microphone', speakers: [] }],
      observations: [observation(.5, alice), observation(1, alice), observation(1.5, alice), observation(2, alice),
        observation(2.5, alice), observation(3, alice), observation(3.5, alice)],
      system: [unit(1, 3, 'The remote designer prefers a green palette.')],
      microphone: [unit(1.5, 2.5, 'Local budgeting needs another spreadsheet.')], minimumNamedCoverage: 1,
      sourceMarkers: [{ text: 'remote designer', channel: 'system-audio' }, { text: 'Local budgeting', channel: 'microphone' }],
    },
    {
      id: 'legacy-provenance', detail: 'Old DOM evidence keeps its original provenance when finalized.',
      reference: [remote('historical-alice', 1, 2, 'Alice')],
      observations: [observation(.5, alice), observation(1, alice), observation(1.5, alice), observation(2, alice)]
        .map(({ source: _source, ...sample }) => sample),
      system: [unit(1, 2, 'This is historical meeting evidence.')], minimumNamedCoverage: 1,
      expectedNamedSource: 'google-meet-dom',
    },
    {
      id: 'source-transition', detail: 'A single utterance spanning different evidence sources stays unnamed.',
      reference: [remote('mixed-evidence', 1, 2, 'Alice')],
      observations: [observation(.5, alice), observation(1, alice), observation(1.5, alice, 'google-meet-dom'), observation(2, alice, 'google-meet-dom')],
      system: [unit(1, 2, 'Do not combine incompatible evidence.')], minimumNamedCoverage: 0, expectedUnknownSeconds: 1,
    },
  ];
}

export interface SpeakerReplayResult {
  round: number;
  case: string;
  detail: string;
  passed: boolean;
  failures: string[];
  evaluation?: SpeakerEvaluation;
  captureVerified?: boolean;
}
export interface SpeakerReplayReport {
  schemaVersion: 1;
  kind: 'synthetic-speaker-attribution-replay';
  createdAt: string;
  rounds: number;
  passed: boolean;
  scratchRemoved: boolean;
  limitations: string[];
  results: SpeakerReplayResult[];
}

function carrier(seconds: number): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * 16_000) * 2);
  for (let frame = 0; frame < pcm.length / 2; frame++) pcm.writeInt16LE(Math.round(1000 * Math.sin(frame * 2 * Math.PI * 220 / 16_000)), frame * 2);
  return pcmS16leToWav(pcm);
}

async function runCase(root: string, fixture: ReplayCase, round: number): Promise<SpeakerReplayResult> {
  const failures: string[] = [];
  const library = join(root, `round-${round}`, fixture.id);
  const store = new CaptureSessionStore({ libraryDir: library, sessionId: `${fixture.id}-${round}`, startedAtUnixMs: 1_000 });
  const originalCapture = store.root;
  const duration = Math.ceil(Math.max(...fixture.reference.map(turn => turn.end))) + 1;
  for (const trackId of ['system-audio', ...(fixture.microphone ? ['microphone'] : [])] as const) {
    // More than one durable chunk exercises assembly, hashing and bundle moves.
    for (const [start, end] of [[0, duration / 2], [duration / 2, duration]]) {
      const sourcePath = join(library, `${trackId}-${start}.wav`);
      writeFileSync(sourcePath, carrier(end! - start!), { mode: 0o600 });
      store.commitChunk({ sourcePath, trackId: trackId as 'microphone' | 'system-audio', startSeconds: start!, endSeconds: end!, audible: true });
    }
  }
  const sidecar = [JSON.stringify({ version: 1, sessionId: store.manifest.sessionId, origin: 1_000 }),
    ...fixture.observations.map(sample => JSON.stringify(sample)), ''].join('\n');
  writeFileSync(join(store.root, 'meet-speakers.jsonl'), sidecar, { mode: 0o600 });
  await saveFinalizedCapture(store, library, 'speaker-replay', {
    title: fixture.id, diarizeSystemAudio: false,
    localTranscriber: async path => {
      // Fixture IDs may themselves contain "microphone". Match the assembled
      // track suffix rather than accidentally routing both tracks to that stub.
      const track = path.match(/-(microphone|system-audio)-[a-f0-9-]{36}\.wav$/u)?.[1];
      if (!track) throw new Error('Unexpected assembled track path');
      return (track === 'microphone' ? fixture.microphone ?? [] : fixture.system).map(segment => ({ ...segment }));
    },
  });
  const saved = findTranscriptRecord(library, store.manifest.sessionId);
  const manifestPath = join(dirname(saved.path), 'capture', 'manifest.json');
  const manifest = loadCaptureSession(manifestPath);
  for (const chunk of manifest.chunks) readVerifiedCaptureChunk(manifestPath, chunk);
  const captureVerified = manifest.status === 'completed' && !existsSync(originalCapture) &&
    readFileSync(join(dirname(manifestPath), 'meet-speakers.jsonl'), 'utf8') === sidecar;
  if (!captureVerified) failures.push('Saved capture is incomplete, changed, or remains attached to its temporary location.');
  const evaluation = evaluateSpeakerAttribution(fixture.reference, saved.record, { expectedNamedSource: fixture.expectedNamedSource });
  for (const field of ['wrongNameSeconds', 'unsafeNameSeconds', 'wrongSourceSeconds', 'provenanceViolationSeconds', 'missingSeconds'] as const) {
    if (evaluation[field] > 1e-8) failures.push(`${field}: ${evaluation[field]} (expected 0)`);
  }
  if (evaluation.namedCoverage === null || evaluation.namedCoverage + 1e-8 < fixture.minimumNamedCoverage) {
    failures.push(`namedCoverage: ${evaluation.namedCoverage} (minimum ${fixture.minimumNamedCoverage})`);
  }
  for (const [expected, actual, label] of [
    [fixture.expectedUnknownSeconds, evaluation.unknownNameSeconds, 'unknownNameSeconds'],
    [fixture.expectedSafeAbstentionSeconds, evaluation.safeAbstentionSeconds, 'safeAbstentionSeconds'],
  ] as const) if (expected !== undefined && Math.abs(expected - actual) > 1e-8) failures.push(`${label}: ${actual} (expected ${expected})`);
  for (const marker of fixture.sourceMarkers ?? []) {
    const matches = saved.record.transcript.filter(segment => segment.text.includes(marker.text));
    if (matches.length !== 1 || (matches[0]!.speaker === 'LOCAL' ? 'microphone' : 'system-audio') !== marker.channel ||
        (marker.channel === 'microphone' && matches[0]!.speakerSource !== undefined)) failures.push(`Source marker failed: ${marker.text}`);
  }
  const segmentIds = saved.record.transcript.map(segment => segment.id);
  if (segmentIds.some(id => !id) || new Set(segmentIds).size !== segmentIds.length) failures.push('Saved evidence IDs are missing or duplicated.');
  return { round, case: fixture.id, detail: fixture.detail, passed: !failures.length, failures, evaluation, captureVerified };
}

export async function runSpeakerReplayGym(options: { rounds?: number; signal?: AbortSignal } = {}): Promise<SpeakerReplayReport> {
  const rounds = options.rounds ?? 1;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('rounds must be between 1 and 10');
  const root = mkdtempSync(join(tmpdir(), 'seashell-speaker-replay-'));
  const results: SpeakerReplayResult[] = [];
  try {
    for (let round = 1; round <= rounds; round++) for (const fixture of cases()) {
      if (options.signal?.aborted) throw new Error('Speaker replay cancelled');
      try { results.push(await runCase(root, fixture, round)); }
      catch (error) { results.push({ round, case: fixture.id, detail: fixture.detail, passed: false,
        failures: [error instanceof Error ? error.message : String(error)] }); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  return {
    schemaVersion: 1, kind: 'synthetic-speaker-attribution-replay', createdAt: new Date().toISOString(), rounds,
    passed: results.every(result => result.passed), scratchRemoved: !existsSync(root), results,
    limitations: [
      'Synthetic PCM with injected ASR units and authored observations; no live audio, browser, Accessibility permission, network, or model inference.',
      'Replay measures persisted attribution and safe abstention, not live Meet name accuracy, ASR accuracy, identity verification, or conventional diarization error rate.',
      'Reference turns are independent of observations. Concurrent source isolation also uses authored lexical markers because labels alone cannot reveal a source swap.',
    ],
  };
}

export function renderSpeakerReplayReport(report: SpeakerReplayReport): string {
  const percent = (ratio: number | null | undefined) => ratio == null ? 'n/a' : `${(ratio * 100).toFixed(1)}%`;
  return [
    '# Synthetic speaker attribution replay', '', `Result: ${report.passed ? 'PASS' : 'FAIL'} · ${report.rounds} round(s) · scratch removed: ${report.scratchRemoved}`, '',
    ...report.limitations.map(line => `- ${line}`), '',
    '| Round | Case | Result | Named coverage | Wrong-name rate | Unknown seconds | Missing seconds |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map(result => `| ${result.round} | ${result.case} | ${result.passed ? 'PASS' : 'FAIL'} | ${percent(result.evaluation?.namedCoverage)} | ${percent(result.evaluation?.wrongNameRate)} | ${result.evaluation?.unknownNameSeconds ?? 'n/a'} | ${result.evaluation?.missingSeconds ?? 'n/a'} |`), '',
    ...report.results.filter(result => !result.passed).flatMap(result => [`## Round ${result.round}: ${result.case}`, '', ...result.failures.map(failure => `- ${failure}`), '']),
  ].join('\n') + '\n';
}

if (import.meta.main) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const args = process.argv.slice(2);
    let rounds = 1, output: string | undefined;
    for (let index = 0; index < args.length; index++) {
      const argument = args[index];
      if (argument === '--rounds' && args[index + 1]) rounds = Number(args[++index]);
      else if (argument === '--output' && args[index + 1]) output = resolve(args[++index]!);
      else throw new Error('Usage: bun scripts/gym-speaker-attribution.ts [--rounds 1..10] [--output directory]');
    }
    const report = await runSpeakerReplayGym({ rounds, signal: controller.signal });
    const destination = output ?? resolve('.gym-results', `speaker-replay-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    writeFileSync(join(destination, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(destination, 'report.md'), renderSpeakerReplayReport(report), { mode: 0o600 });
    console.log(`Synthetic speaker replay ${report.passed ? 'PASS' : 'FAIL'}: ${report.results.filter(result => result.passed).length}/${report.results.length} cases. ${destination}`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
