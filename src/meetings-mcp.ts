import { createInterface } from 'readline';
import { loadMeetingArtifact } from './meeting-artifact.ts';
import { findTranscriptRecord, listTranscriptRecords, loadTranscriptPath } from './transcript-library.ts';
import type { TranscriptRecord } from './transcript-types.ts';

/**
 * A read-only, local MCP server over the Seashell library, so Claude Code or
 * Codex can answer questions across meetings, draft follow-ups and file work
 * with the user's own tools. Nothing leaves the Mac unless the agent sends it.
 */

export const MEETINGS_MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const MEETINGS_MCP_INSTRUCTIONS = [
  "Seashell is the user's local library of recorded meetings: transcripts, speaker labels and AI notes.",
  'Find meetings with list_meetings or search_transcripts before reading one; never invent meeting IDs or segment IDs.',
  'Quote with the segment ID and time, e.g. [s000123 12:04], so the user can check the source.',
  'Transcripts are machine-generated. "Microphone" is the user; "Remote speaker N" and "System audio" are other people unless renamed.',
  'This server is read-only. Ask the user before sending anything (email, Slack, Linear) based on a meeting.',
].join(' ');

type Arguments = Record<string, unknown>;

function text(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function count(value: unknown, name: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`);
  return Math.min(value as number, maximum);
}

function date(value: unknown, name: string): number | undefined {
  const raw = text(value, name);
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO date such as 2026-10-01`);
  return parsed;
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const rest = `${String(Math.floor(whole % 3600 / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
}

function labels(record: TranscriptRecord): Map<string, string> {
  const names = new Map(record.speakers.map(speaker => [speaker.id, speaker.label]));
  names.set('LOCAL', names.get('LOCAL') ?? 'Microphone');
  names.set('SYSTEM', names.get('SYSTEM') ?? 'System audio');
  return names;
}

function segmentId(record: TranscriptRecord, index: number): string {
  return record.transcript[index]?.id?.trim() || `s${String(index + 1).padStart(6, '0')}`;
}

function minutes(record: TranscriptRecord): number | undefined {
  return record.source.duration === undefined ? undefined : Math.round(record.source.duration / 6) / 10;
}

function load(libraryDir: string, id: unknown) {
  const found = findTranscriptRecord(libraryDir, text(id, 'id', true)!);
  return { ...found, artifact: loadMeetingArtifact(libraryDir, found.record.id) };
}

export function listMeetings(libraryDir: string, args: Arguments = {}) {
  const query = text(args.query, 'query')?.toLocaleLowerCase();
  const from = date(args.from, 'from');
  const to = date(args.to, 'to');
  const limit = count(args.limit, 'limit', 20, 200);
  const meetings = [];
  for (const entry of listTranscriptRecords(libraryDir)) {
    const started = Date.parse(entry.createdAt);
    if ((from !== undefined && started < from) || (to !== undefined && started > to + 86_400_000 - 1)) continue;
    const artifact = loadMeetingArtifact(libraryDir, entry.id);
    const summary = artifact?.analysis?.summary;
    if (query) {
      const record = loadTranscriptPath(`${entry.directory}/transcript.json`);
      const haystack = [entry.title, summary ?? '', ...record.transcript.map(segment => segment.text)].join('\n').toLocaleLowerCase();
      if (!query.split(/\s+/u).every(word => haystack.includes(word))) continue;
    }
    meetings.push({
      id: entry.id, title: entry.title, startedAt: entry.createdAt,
      ...(entry.duration === undefined ? {} : { durationMinutes: Math.round(entry.duration / 6) / 10 }),
      kind: entry.kind, segments: entry.segmentCount,
      notes: artifact?.analysis ? (artifact.analysis.final ? 'final' : 'draft') : artifact?.provisionalClaims.length ? 'live-draft' : 'none',
      ...(summary ? { summary: summary.length > 280 ? `${summary.slice(0, 277)}…` : summary } : {}),
    });
    if (meetings.length >= limit) break;
  }
  return { meetings };
}

export function getMeeting(libraryDir: string, args: Arguments) {
  const { record, artifact } = load(libraryDir, args.id);
  const names = labels(record);
  const starts = new Map(record.transcript.map((segment, index) => [segmentId(record, index), segment.start]));
  const claims = artifact?.analysis?.claims ?? artifact?.provisionalClaims ?? [];
  return {
    id: record.id, title: record.title, startedAt: record.createdAt,
    ...(minutes(record) === undefined ? {} : { durationMinutes: minutes(record) }),
    ...(artifact?.calendar ? { calendar: { title: artifact.calendar.title, startAt: artifact.calendar.startAt,
      attendees: artifact.calendar.attendees.map(person => ({ name: person.name, ...(person.email ? { email: person.email } : {}) })) } } : {}),
    speakers: [...new Set(record.transcript.map(segment => segment.speaker ?? 'SYSTEM'))]
      .map(id => ({ id, label: names.get(id) ?? id })),
    notes: {
      status: artifact?.analysis?.final ? 'final' : artifact?.analysis ? 'draft' : claims.length ? 'live-draft' : 'none',
      ...(artifact?.analysis?.summary ? { summary: artifact.analysis.summary } : {}),
      items: claims.map(claim => ({
        type: claim.type, text: claim.text,
        ...(claim.person ? { person: claim.person } : {}),
        evidence: claim.evidenceSegmentIds.map(id => `${id} ${clock(starts.get(id) ?? 0)}`),
      })),
      // The notes in the owner's template, section by section, each point cited.
      ...(artifact?.analysis?.notes ? {
        template: artifact.analysis.template,
        sections: artifact.analysis.notes.map(section => ({
          heading: section.heading,
          items: section.items.map(item => ({
            text: item.text,
            evidence: item.evidenceSegmentIds.map(id => `${id} ${clock(starts.get(id) ?? 0)}`),
          })),
        })),
      } : {}),
    },
    transcriptSegments: record.transcript.length,
  };
}

export function getTranscript(libraryDir: string, args: Arguments) {
  const { record } = load(libraryDir, args.id);
  const offset = count(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const limit = count(args.limit, 'limit', 200, 500);
  const speaker = text(args.speaker, 'speaker')?.toLocaleLowerCase();
  const names = labels(record);
  const segments = record.transcript.map((segment, index) => ({
    id: segmentId(record, index), at: clock(segment.start), start: segment.start, end: segment.end,
    speaker: names.get(segment.speaker ?? 'SYSTEM') ?? segment.speaker ?? 'Unknown', text: segment.text,
  })).filter(segment => !speaker || segment.speaker.toLocaleLowerCase().includes(speaker));
  const page = segments.slice(offset, offset + limit);
  return { id: record.id, title: record.title, total: segments.length, offset, segments: page,
    ...(offset + page.length < segments.length ? { nextOffset: offset + page.length } : {}) };
}

export function searchTranscripts(libraryDir: string, args: Arguments) {
  const words = text(args.query, 'query', true)!.toLocaleLowerCase().split(/\s+/u);
  const limit = count(args.limit, 'limit', 30, 200);
  const matches = [];
  for (const entry of listTranscriptRecords(libraryDir)) {
    let record: TranscriptRecord;
    try { record = loadTranscriptPath(`${entry.directory}/transcript.json`); } catch { continue; }
    const names = labels(record);
    for (const [index, segment] of record.transcript.entries()) {
      const lower = segment.text.toLocaleLowerCase();
      if (!words.every(word => lower.includes(word))) continue;
      matches.push({ meetingId: record.id, title: record.title, startedAt: record.createdAt,
        segmentId: segmentId(record, index), at: clock(segment.start),
        speaker: names.get(segment.speaker ?? 'SYSTEM') ?? segment.speaker ?? 'Unknown', text: segment.text });
      if (matches.length >= limit) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

export function listActionItems(libraryDir: string, args: Arguments = {}) {
  const since = date(args.since, 'since');
  const limit = count(args.limit, 'limit', 50, 500);
  const items = [];
  for (const entry of listTranscriptRecords(libraryDir)) {
    if (since !== undefined && Date.parse(entry.createdAt) < since) continue;
    const artifact = loadMeetingArtifact(libraryDir, entry.id);
    for (const claim of artifact?.analysis?.claims ?? artifact?.provisionalClaims ?? []) {
      if (claim.type !== 'action_item') continue;
      items.push({ meetingId: entry.id, title: entry.title, startedAt: entry.createdAt, text: claim.text,
        ...(claim.person ? { person: claim.person } : {}), evidence: claim.evidenceSegmentIds,
        final: Boolean(artifact?.analysis?.final) });
      if (items.length >= limit) return { items };
    }
  }
  return { items };
}

const string = (description: string) => ({ type: 'string', description });
const integer = (description: string) => ({ type: 'integer', minimum: 0, description });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const MEETINGS_MCP_TOOLS = [
  { name: 'list_meetings', title: 'List meetings', annotations: readOnly,
    description: 'Newest-first list of recorded meetings with title, start time, length and a short summary. Optional filters: words that must all appear (title, notes or transcript) and a date range.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      query: string('Words that must all appear'), from: string('Earliest date, e.g. 2026-10-01'),
      to: string('Latest date, inclusive'), limit: integer('Maximum meetings (default 20)') } },
    run: listMeetings },
  { name: 'get_meeting', title: 'Get meeting notes', annotations: readOnly,
    description: 'One meeting: calendar details, speakers, the AI summary and note items (decisions, action items, facts) with the transcript segments that support each.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: string('Meeting ID from list_meetings') } },
    run: getMeeting },
  { name: 'get_transcript', title: 'Read a transcript', annotations: readOnly,
    description: 'A page of a meeting transcript: segment ID, time, speaker and text. Use offset and nextOffset to page; optionally keep one speaker.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: {
      id: string('Meeting ID'), offset: integer('First segment (default 0)'), limit: integer('Segments per page (default 200, max 500)'),
      speaker: string('Only segments whose speaker label contains this text') } },
    run: getTranscript },
  { name: 'search_transcripts', title: 'Search all transcripts', annotations: readOnly,
    description: 'Find transcript segments across all meetings that contain every word of the query, newest meetings first.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: string('Words that must all appear in a segment'), limit: integer('Maximum matches (default 30)') } },
    run: searchTranscripts },
  { name: 'list_action_items', title: 'List action items', annotations: readOnly,
    description: 'Action items from meeting notes across all meetings, newest first, with who owns them and the supporting segments.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      since: string('Only meetings on or after this date'), limit: integer('Maximum items (default 50)') } },
    run: listActionItems },
] as const;

type Request = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** One JSON-RPC message in, at most one response out (notifications get none). */
export function handleMeetingsMcpMessage(libraryDir: string, message: Request, version: string): Record<string, unknown> | undefined {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id ?? null, result });
  const error = (code: number, text: string) => ({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } });
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request');
  const notification = message.id === undefined;
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      const protocolVersion = MEETINGS_MCP_PROTOCOL_VERSIONS.includes(requested as never) ? requested : MEETINGS_MCP_PROTOCOL_VERSIONS[0];
      return reply({ protocolVersion, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'seashell', title: 'Seashell meetings', version }, instructions: MEETINGS_MCP_INSTRUCTIONS });
    }
    case 'ping': return notification ? undefined : reply({});
    case 'tools/list':
      return reply({ tools: MEETINGS_MCP_TOOLS.map(({ run: _run, ...tool }) => tool) });
    case 'tools/call': {
      const tool = MEETINGS_MCP_TOOLS.find(candidate => candidate.name === message.params?.name);
      if (!tool) return error(-32602, `Unknown tool: ${String(message.params?.name)}`);
      try {
        const result = tool.run(libraryDir, (message.params?.arguments ?? {}) as Arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (cause) {
        // Tool failures are results the model can read and correct, not protocol errors.
        return reply({ isError: true, content: [{ type: 'text', text: cause instanceof Error ? cause.message : String(cause) }] });
      }
    }
    default:
      if (notification) return undefined;
      return error(-32601, `Method not found: ${message.method}`);
  }
}

/** stdio transport: newline-delimited JSON-RPC; stdout carries protocol only. */
export async function runMeetingsMcpServer(libraryDir: string, version: string,
  input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Request;
    try { message = JSON.parse(line); } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    const response = handleMeetingsMcpMessage(libraryDir, message, version);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
