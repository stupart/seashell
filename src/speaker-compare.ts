import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { assembleCaptureTrack } from './capture-finalizer.ts';
import { runSpeakerSeparation } from './diarize.ts';
import { readMeetingAiSettingsAt } from './meeting-artifact.ts';
import { speakerForUnit } from './merge-diarization.ts';
import { findTranscriptRecord, listTranscriptRecords } from './transcript-library.ts';
import type { DiarizationTurn, TranscriptSegment } from './transcript-types.ts';

/**
 * Try Nemotron 3 on calls already recorded, and show only the lines where it
 * disagrees with the speakers saved in the meeting. Nothing saved is changed,
 * and the page, with its transcript lines and short clips, stays in the library.
 */

const FOLDER = '_speaker-comparison';
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
const DEFAULT_MEETINGS = 5;
const CLIPS_PER_MEETING = 15;
const CLIP_PADDING_SECONDS = 0.5;
const CLIP_MAX_SECONDS = 12;

export interface SpeakerDisagreement {
  start: number;
  end: number;
  text: string;
  current: string;
  proposed: string;
  clip?: string;
}

export interface MeetingComparison {
  id: string;
  title: string;
  createdAt: string;
  currentVoices: number;
  proposedVoices: number;
  lines: number;
  changedLines: number;
  disagreements: SpeakerDisagreement[];
}

export interface SpeakerComparisonReport {
  page?: string;
  meetings: MeetingComparison[];
  skipped: { private: number; noAudio: number };
}

type Line = Pick<TranscriptSegment, 'start' | 'end' | 'text'> & { speaker: string };

function remoteLines(transcript: readonly TranscriptSegment[]): Line[] {
  // A line saved as unknown has no speaker to disagree with, and is no extra person.
  return transcript.flatMap((segment) => (segment.speaker && segment.speaker !== 'LOCAL' &&
    !segment.speaker.endsWith('UNKNOWN') && segment.text.trim()
    ? [{ start: segment.start, end: segment.end, text: segment.text, speaker: segment.speaker }] : []));
}

/**
 * Each proposed voice takes the name of the saved speaker it shares the most
 * speech with, one to one, so "Remote speaker 2" means the same on both sides.
 * Lines are judged by the rule meetings use: see speakerForUnit.
 */
export function compareLines(
  transcript: readonly TranscriptSegment[],
  turns: readonly DiarizationTurn[],
  labels: ReadonlyMap<string, string> = new Map(),
): Pick<MeetingComparison, 'currentVoices' | 'proposedVoices' | 'lines' | 'changedLines' | 'disagreements'> {
  const lines = remoteLines(transcript);
  const sorted = [...turns].sort((a, b) => a.start - b.start || a.end - b.end);
  const judged = lines.map((line) => ({ line, proposed: speakerForUnit(line, sorted) }))
    .filter(({ proposed }) => proposed !== 'UNKNOWN');

  const shared = new Map<string, number>();
  for (const { line, proposed } of judged) {
    const key = `${proposed}\u0000${line.speaker}`;
    shared.set(key, (shared.get(key) ?? 0) + line.end - line.start);
  }
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const [key] of [...shared].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const [proposed, current] = key.split('\u0000') as [string, string];
    if (names.has(proposed) || taken.has(current)) continue;
    names.set(proposed, current);
    taken.add(current);
  }

  const proposedVoices = new Set(judged.map(({ proposed }) => proposed));
  let extra = 0;
  for (const proposed of [...proposedVoices].sort()) {
    if (!names.has(proposed)) names.set(proposed, `new-${extra += 1}`);
  }
  const label = (speaker: string) => (speaker.startsWith('new-') ? `New voice ${speaker.slice(4)}` : labels.get(speaker) ?? speaker);
  const disagreements = judged.filter(({ line, proposed }) => names.get(proposed) !== line.speaker)
    .map(({ line, proposed }): SpeakerDisagreement => ({
      start: line.start, end: line.end, text: line.text.trim(),
      current: label(line.speaker), proposed: label(names.get(proposed)!),
    }));
  return {
    currentVoices: new Set(lines.map((line) => line.speaker)).size,
    proposedVoices: proposedVoices.size,
    lines: lines.length,
    changedLines: disagreements.length,
    disagreements,
  };
}

/** A short mono clip of the assembled 16 kHz track, so the page needs no player or server. */
function writeClip(track: string, destination: string, start: number, end: number): void {
  const first = Math.max(0, start - CLIP_PADDING_SECONDS);
  const seconds = Math.min(CLIP_MAX_SECONDS, end + CLIP_PADDING_SECONDS - first);
  const pcm = Buffer.alloc(Math.floor(seconds * SAMPLE_RATE) * BYTES_PER_SAMPLE);
  const descriptor = openSync(track, 'r');
  let read = 0;
  try {
    read = readSync(descriptor, pcm, 0, pcm.length, WAV_HEADER_BYTES + Math.floor(first * SAMPLE_RATE) * BYTES_PER_SAMPLE);
  } finally {
    closeSync(descriptor);
  }
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + read, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(read, 40);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, Buffer.concat([header, pcm.subarray(0, read)]), { mode: 0o600 });
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(whole / 3600);
  return `${hours ? `${hours}:${pad(Math.floor(whole / 60) % 60)}` : Math.floor(whole / 60)}:${pad(whole % 60)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

export function renderComparisonPage(report: SpeakerComparisonReport): string {
  const meetings = report.meetings.map((meeting) => {
    const rows = meeting.disagreements.filter((line) => line.clip).map((line) => {
      const key = escapeHtml(`${meeting.id}:${line.start}`);
      return `<li data-key="${key}">
        <p class="line">${escapeHtml(line.text)}</p>
        <audio controls preload="none" src="${escapeHtml(line.clip!)}"></audio>
        <div class="pick">
          <span class="time">${clock(line.start)}</span>
          <button data-choice="current">${escapeHtml(line.current)} <small>saved</small></button>
          <button data-choice="nemotron">${escapeHtml(line.proposed)} <small>Nemotron 3</small></button>
          <button data-choice="neither">Neither / can't tell</button>
        </div>
      </li>`;
    }).join('\n');
    const shown = meeting.disagreements.filter((line) => line.clip).length;
    return `<section>
      <h2>${escapeHtml(meeting.title)}</h2>
      <p class="facts">Voices: ${meeting.currentVoices} saved, ${meeting.proposedVoices} with Nemotron 3. Different on ${meeting.changedLines} of ${meeting.lines} lines${shown < meeting.changedLines ? `, longest ${shown} shown` : ''}.</p>
      ${rows ? `<ol>${rows}</ol>` : '<p class="facts">They agree on every line.</p>'}
    </section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Speaker comparison</title>
<style>
:root { color-scheme: light dark; --ink: #1c1c1e; --muted: #6e6e73; --line: #d9d9de; --bg: #fff; --on: #0a66c2; }
@media (prefers-color-scheme: dark) { :root { --ink: #f2f2f4; --muted: #a1a1a8; --line: #3a3a3f; --bg: #161618; --on: #5aa9f5; } }
body { margin: 0 auto; max-width: 720px; padding: 24px 16px 64px; font: 16px/1.5 -apple-system, system-ui, sans-serif; color: var(--ink); background: var(--bg); }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 40px 0 4px; }
.facts, .intro { color: var(--muted); margin: 0 0 12px; }
ol { list-style: none; margin: 0; padding: 0; } li { border-top: 1px solid var(--line); padding: 16px 0; }
.line { margin: 0 0 8px; } audio { width: 100%; height: 36px; }
.pick { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.time { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 48px; }
button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: none; color: inherit; cursor: pointer; }
button small { color: var(--muted); } button[aria-pressed="true"] { border-color: var(--on); box-shadow: inset 0 0 0 1px var(--on); }
#tally { position: sticky; top: 0; background: var(--bg); padding: 12px 0; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
</style></head><body>
<h1>Who said it?</h1>
<p class="intro">These are the lines where the speaker saved in your meeting and Nemotron 3 disagree. Play each one and pick who was right. Your meetings have not changed.</p>
<p id="tally" aria-live="polite"></p>
${meetings}
<script>
const key = 'seashell-speaker-comparison';
const load = () => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };
let picks = load();
const items = [...document.querySelectorAll('li[data-key]')];
function paint() {
  const count = (choice) => Object.values(picks).filter((pick) => pick === choice).length;
  document.getElementById('tally').textContent = 'Nemotron 3 right: ' + count('nemotron') + ' · Saved right: ' + count('current') + ' · Neither: ' + count('neither') + ' · ' + (items.length - Object.keys(picks).length) + ' left';
  for (const item of items) for (const button of item.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(picks[item.dataset.key] === button.dataset.choice));
  }
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-choice]');
  if (!button) return;
  picks[button.closest('li').dataset.key] = button.dataset.choice;
  try { localStorage.setItem(key, JSON.stringify(picks)); } catch {}
  paint();
});
paint();
</script></body></html>
`;
}

export async function compareSavedSpeakers(libraryDir: string, options: {
  ids?: readonly string[];
  last?: number;
  onStatus?: (message: string) => void;
  separate?: (track: string) => Promise<DiarizationTurn[]>;
} = {}): Promise<SpeakerComparisonReport> {
  const separate = options.separate ?? (async (track: string) =>
    (await runSpeakerSeparation(track, { engine: 'nemotron3' })).turns);
  const wanted = new Set(options.ids ?? []);
  const limit = wanted.size ? wanted.size : options.last ?? DEFAULT_MEETINGS;
  const folder = join(libraryDir, FOLDER);
  rmSync(folder, { recursive: true, force: true });

  const report: SpeakerComparisonReport = { meetings: [], skipped: { private: 0, noAudio: 0 } };
  for (const entry of listTranscriptRecords(libraryDir)) {
    if (report.meetings.length >= limit) break;
    if (wanted.size && !wanted.has(entry.id)) continue;
    if (readMeetingAiSettingsAt(entry.directory)?.off) { report.skipped.private += 1; continue; }
    const manifestPath = join(entry.directory, 'capture', 'manifest.json');
    if (!existsSync(manifestPath)) { report.skipped.noAudio += 1; continue; }
    const { record } = findTranscriptRecord(libraryDir, entry.id);
    if (remoteLines(record.transcript).length === 0) { report.skipped.noAudio += 1; continue; }

    options.onStatus?.(`Separating voices · ${record.title}…`);
    const track = assembleCaptureTrack(manifestPath, JSON.parse(readFileSync(manifestPath, 'utf8')), 'system-audio');
    if (!track) { report.skipped.noAudio += 1; continue; }
    try {
      const compared = compareLines(record.transcript, await separate(track),
        new Map(record.speakers.map((speaker) => [speaker.id, speaker.label])));
      const longest = [...compared.disagreements].sort((a, b) => (b.end - b.start) - (a.end - a.start))
        .slice(0, CLIPS_PER_MEETING);
      for (const line of longest) {
        line.clip = `clips/${record.id}-${Math.round(line.start * 1000)}.wav`;
        writeClip(track, join(folder, line.clip), line.start, line.end);
      }
      report.meetings.push({ id: record.id, title: record.title, createdAt: record.createdAt, ...compared });
    } finally {
      rmSync(track, { force: true });
    }
  }
  if (report.meetings.length) {
    mkdirSync(folder, { recursive: true });
    report.page = join(folder, 'index.html');
    writeFileSync(report.page, renderComparisonPage(report), { mode: 0o600 });
  }
  return report;
}

export function renderSpeakerComparison(report: SpeakerComparisonReport): string {
  if (!report.meetings.length) return 'No recorded calls with remote voices to compare.';
  const skipped = [
    ...(report.skipped.private ? [`${report.skipped.private} private`] : []),
    ...(report.skipped.noAudio ? [`${report.skipped.noAudio} without saved audio`] : []),
  ];
  return [
    'Nothing was changed, and this stayed on your Mac.',
    '',
    ...report.meetings.map((meeting) =>
      `  ${meeting.title}\n    voices ${meeting.currentVoices} → ${meeting.proposedVoices} · different on ${meeting.changedLines} of ${meeting.lines} lines`),
    ...(skipped.length ? ['', `Skipped ${skipped.join(' and ')}.`] : []),
    '',
    `Listen where they disagree: open "${report.page}"`,
    'If Nemotron 3 wins: seashell speakers use nemotron3',
  ].join('\n');
}
