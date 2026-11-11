import { createInterface } from 'readline';
import {
  automationsDirectory,
  createAutomation,
  deleteAutomation,
  loadAutomations,
  automationDecision,
  readAutomationRuns,
  updateAutomation,
  type AutomationAction,
  type AutomationFilters,
} from './automations.ts';
import {
  createExtractor,
  deleteExtractor,
  extractorsDirectory,
  loadExtractors,
  runExtractor,
  updateExtractor,
  type ExtractorDefinition,
  type ExtractorField,
} from './extractors.ts';
import type { HumainMeetingRoute, runHumainMeeting } from './humain-client.ts';
import {
  count,
  getInsights,
  getMeeting,
  getTranscript,
  listActionItems,
  listMeetings,
  loadMeeting,
  queryNotes,
  searchTranscripts,
  text,
  videoMoment,
  type Arguments,
} from './meeting-memory.ts';
import { loadMeetingTemplates, PROFILE_FILE, readProfileFile, templatesDirectory, writeMeetingTemplate, writeProfile } from './meeting-templates.ts';
import { listPrompts, promptsDirectory, writePrompt } from './prompts.ts';
import { editTranscriptSegment, renameMeetingSpeaker } from './transcript-edits.ts';

/**
 * A local MCP server over the Seashell library, so Claude Code or Codex can
 * answer questions across meetings, draft follow-ups and file work with the
 * user's own tools, and, when asked, fix a transcript or shape how Seashell
 * writes notes. Reads and queries live in meeting-memory.ts; this file is the
 * transport. Nothing leaves the Mac unless the agent sends it, or an extractor
 * runs through the AI the user chose.
 */

export { getMeeting, getTranscript, listActionItems, listMeetings, searchTranscripts } from './meeting-memory.ts';

export const MEETINGS_MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const MEETINGS_MCP_INSTRUCTIONS = [
  "Seashell is the user's local library of recorded meetings: transcripts, speaker labels, AI notes and insights.",
  'Find meetings with list_meetings, search_transcripts or query_notes before reading one; never invent meeting IDs or segment IDs.',
  'Quote with the segment ID and time, e.g. [s000123 12:04], so the user can check the source.',
  'Transcripts are machine-generated. "Microphone" is the user; "Remote speaker N" and "System audio" are other people unless renamed.',
  'A speaker marked suggested (speakerSuggested on a line) was named by Seashell from a known voice and not yet confirmed by the user: treat that name as a guess.',
  'Reading is safe. Tools that change things (fixing a transcript line, naming a speaker, editing prompts, templates, extractors or automations, running an extractor) change the user\'s own files: use them only when the user asks.',
  'Ask the user before sending anything (email, Slack, Linear) based on a meeting.',
  'A meeting marked private has AI turned off by its owner: say so, and do not try to reach its content another way.',
].join(' ');

/** What the server needs from its host to run an extractor. Tests pass fakes. */
export interface MeetingsMcpDependencies {
  /** The final-notes route; undefined when meeting AI is not set up. */
  route?: () => HumainMeetingRoute | undefined;
  runner?: typeof runHumainMeeting;
  env?: NodeJS.ProcessEnv;
}

function strings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} must be a list of strings`);
  return value.map((item) => item.trim()).filter(Boolean);
}

function extractorFields(value: unknown): ExtractorField[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('fields must be a list of { name, description }');
  return value.map((field, index) => ({
    name: text(field?.name, `fields[${index}].name`, true)!,
    description: text(field?.description, `fields[${index}].description`, true)!,
  }));
}

function extractorWhen(value: unknown): ExtractorDefinition['when'] | undefined {
  if (value === undefined) return undefined;
  if (value === 'always' || value === 'manual') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const when = value as Arguments;
    return { title: strings(when.title, 'when.title'), attendee: strings(when.attendee, 'when.attendee'), app: strings(when.app, 'when.app') };
  }
  throw new Error('when must be "always", "manual", or { title, attendee, app } word lists');
}

function automationActions(value: unknown): AutomationAction[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('actions must be a list of { kind, value }');
  return value.map((action, index) => {
    const raw = text(action?.value, `actions[${index}].value`, true)!;
    switch (action?.kind) {
      case 'extract': return { kind: 'extract', extractor: raw };
      case 'write': return { kind: 'write', target: raw };
      case 'shell': return { kind: 'shell', command: raw };
      case 'webhook': return { kind: 'webhook', url: raw };
      default: throw new Error(`actions[${index}].kind must be extract, write, shell or webhook`);
    }
  });
}

function automationFilters(value: unknown): Partial<AutomationFilters> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('filters must be an object');
  const filters = value as Arguments;
  return Object.fromEntries((['title', 'attendee', 'app', 'calendar'] as const)
    .flatMap((key) => filters[key] === undefined ? [] : [[key, strings(filters[key], `filters.${key}`)!]]));
}

function listExtractorsTool(libraryDir: string, _args: Arguments, deps: MeetingsMcpDependencies) {
  return { directory: extractorsDirectory(libraryDir, deps.env), ...loadExtractors(libraryDir, deps.env) };
}

function listAutomationsTool(libraryDir: string, args: Arguments, deps: MeetingsMcpDependencies) {
  const { automations, problems } = loadAutomations(libraryDir, deps.env);
  const runs = readAutomationRuns(libraryDir);
  const recent = count(args.recentRuns, 'recentRuns', 5, 50);
  return {
    directory: automationsDirectory(libraryDir, deps.env),
    automations: automations.map((automation) => {
      const { hash: _hash, ...shown } = automation;
      const outward = automation.actions.some((action) => action.kind === 'shell' || action.kind === 'webhook');
      return {
        ...shown,
        // Shell and webhook actions run only after the owner allows this version of the file.
        approval: outward ? automationDecision(automation, deps.env) ?? 'not asked yet' : 'not needed',
        recentRuns: runs.filter((run) => run.automation === automation.name).slice(-recent)
          .map(({ hash: _runHash, ...run }) => run),
      };
    }),
    problems,
  };
}

function listPromptsTool(libraryDir: string, _args: Arguments, deps: MeetingsMcpDependencies) {
  return { directory: promptsDirectory(libraryDir, deps.env), prompts: listPrompts(libraryDir, deps.env) };
}

function listTemplatesTool(libraryDir: string, _args: Arguments, deps: MeetingsMcpDependencies) {
  return {
    directory: templatesDirectory(libraryDir, deps.env),
    aboutMe: readProfileFile(libraryDir, deps.env),
    templates: loadMeetingTemplates(libraryDir, deps.env).map((template) => ({
      name: template.name, ...(template.description ? { description: template.description } : {}),
      match: template.match, default: template.default, body: template.body, path: template.path,
    })),
  };
}

async function runExtractorTool(libraryDir: string, args: Arguments, deps: MeetingsMcpDependencies) {
  const { record } = loadMeeting(libraryDir, args.id);
  const route = deps.route?.();
  if (!route) throw new Error('Meeting AI is not set up, so extractors cannot run. The user can choose a provider with: seashell ai setup');
  await runExtractor(libraryDir, record.id, text(args.extractor, 'extractor', true)!, { route, runner: deps.runner, env: deps.env });
  return getInsights(libraryDir, { id: record.id, extractor: args.extractor });
}

const string = (description: string) => ({ type: 'string', description });
const integer = (description: string) => ({ type: 'integer', minimum: 0, description });
const stringList = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Adds a file; nothing existing changes. */
const adds = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Replaces a file's contents: the previous version is gone. */
const replaces = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const removes = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
/** Changes a transcript; the previous version is kept in the meeting's history folder. */
const edits = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const extractorProperties = {
  name: string('Extractor name, e.g. "Customer pains" (80 characters at most)'),
  when: { description: '"always" (after every meeting\'s final notes), "manual" (only when asked), or { title, attendee, app } word lists, any of which runs it',
    anyOf: [{ type: 'string', enum: ['always', 'manual'] }, { type: 'object', additionalProperties: false,
      properties: { title: stringList('Title words'), attendee: stringList('Attendee names or emails'), app: stringList('Apps, e.g. Zoom') } }] },
  fields: { type: 'array', minItems: 1, maxItems: 20, description: 'What to find, one entry each',
    items: { type: 'object', additionalProperties: false, required: ['name', 'description'],
      properties: { name: string('Field name (60 characters at most)'), description: string('What counts (500 characters at most)') } } },
  prompt: string('What to look for, in plain words (8,000 characters at most)'),
};

const automationProperties = {
  name: string('Automation name'),
  enabled: { type: 'boolean', description: 'Off until true (default true)' },
  filters: { type: 'object', additionalProperties: false, description: 'Every list given must match; within one list, any word does',
    properties: { title: stringList('Title words'), attendee: stringList('Attendee names or emails'), app: stringList('Apps, e.g. Zoom'), calendar: stringList('Calendar names') } },
  actions: { type: 'array', minItems: 1, description: 'Run in order when a meeting is ready. shell and webhook send the meeting outside Seashell and wait for the owner to allow them in a Seashell dialog.',
    items: { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: {
      kind: { type: 'string', enum: ['extract', 'write', 'shell', 'webhook'] },
      value: string('extract: an extractor name; write: a folder or a .md path ({date}, {title}, {id}); shell: a command, given the meeting JSON on stdin; webhook: an https address') } } },
};

type Tool = {
  name: string;
  title: string;
  annotations: Record<string, boolean>;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (libraryDir: string, args: Arguments, deps: MeetingsMcpDependencies) => unknown;
};

export const MEETINGS_MCP_TOOLS: readonly Tool[] = [
  { name: 'list_meetings', title: 'List meetings', annotations: readOnly,
    description: 'Newest-first list of recorded meetings with title, start time, length and a short summary. Optional filters: words that must all appear (title, notes or transcript) and a date range.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      query: string('Words that must all appear'), from: string('Earliest date, e.g. 2026-10-01'),
      to: string('Latest date, inclusive'), limit: integer('Maximum meetings (default 20)') } },
    run: listMeetings },
  { name: 'get_meeting', title: 'Get meeting notes', annotations: readOnly,
    description: 'One meeting: calendar details, speakers, the AI summary and note items (decisions, action items with owner and due date, risks, open questions, follow-ups, facts) with the transcript segments that support each, and which extractors have insights.',
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
    description: 'Action items from meeting notes across all meetings, newest first, with who owns them, when they are due when said, and the supporting segments.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      since: string('Only meetings on or after this date'), limit: integer('Maximum items (default 50)') } },
    run: listActionItems },
  { name: 'query_notes', title: 'Query notes across meetings', annotations: readOnly,
    description: 'Decisions, action items, risks, open questions or follow-ups across all meetings, newest first, e.g. action items for one person, or decisions about a topic since a date. Each has its owner and due date when said, a quote and its citations. Seashell does not track whether an action was done.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      kind: { description: 'decisions, actions, risks, questions or follow-ups; one or a list (default: all five)',
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      person: string('Who owns it, or said it when no owner was recorded: a name or the start of one ("dan" finds Dana, not Jordan). "me" finds the user\'s own'), about: string('Words that must all appear in the note or the lines it cites'),
      meeting: string('Words that must all appear in the meeting title'), since: string('Only meetings on or after this date'),
      until: string('Only meetings on or before this date'), limit: integer('Maximum items (default 50)') } },
    run: queryNotes },
  { name: 'get_insights', title: 'Get meeting insights', annotations: readOnly,
    description: 'What the user\'s extractors found in one meeting: each extractor\'s fields, every item cited.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: {
      id: string('Meeting ID'), extractor: string('Only this extractor') } },
    run: getInsights },
  { name: 'get_video_moment', title: 'Find a moment in the video', annotations: readOnly,
    description: 'The screen recording file and the offset into it where a transcript segment was said. video is null when the meeting has no video.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'segmentId'], properties: {
      id: string('Meeting ID'), segmentId: string('Segment ID, e.g. s000123') } },
    run: (libraryDir, args) => ({ id: args.id, segmentId: args.segmentId, video: videoMoment(libraryDir, args) ?? null }) },
  { name: 'list_extractors', title: 'List extractors', annotations: readOnly,
    description: 'The user\'s insight extractors: name, when each runs, its fields and prompt, and its file. Files that do not parse are listed under problems.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: listExtractorsTool },
  { name: 'create_extractor', title: 'Add an extractor', annotations: adds,
    description: 'Add an insight extractor: a few named fields Seashell pulls out of meetings, each item cited. It runs after final notes when "when" says so, or with run_extractor.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'fields'], properties: extractorProperties },
    run: (libraryDir, args, deps) => createExtractor(libraryDir, {
      name: text(args.name, 'name', true)!, when: extractorWhen(args.when), fields: extractorFields(args.fields)!,
      ...(args.prompt === undefined ? {} : { prompt: String(args.prompt) }),
    }, deps.env) },
  { name: 'update_extractor', title: 'Change an extractor', annotations: replaces,
    description: 'Change an extractor by name. Parts left out keep their current value; fields, when given, replace the whole list.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['extractor'], properties: {
      extractor: string('Current name'), ...extractorProperties } },
    run: (libraryDir, args, deps) => updateExtractor(libraryDir, text(args.extractor, 'extractor', true)!, {
      ...(args.name === undefined ? {} : { name: text(args.name, 'name', true)! }),
      ...(args.when === undefined ? {} : { when: extractorWhen(args.when) }),
      ...(args.fields === undefined ? {} : { fields: extractorFields(args.fields)! }),
      ...(args.prompt === undefined ? {} : { prompt: String(args.prompt) }),
    }, deps.env) },
  { name: 'delete_extractor', title: 'Delete an extractor', annotations: removes,
    description: 'Delete an extractor\'s file. Insights it already wrote stay with their meetings.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['extractor'], properties: { extractor: string('Extractor name') } },
    run: (libraryDir, args, deps) => ({ deleted: deleteExtractor(libraryDir, text(args.extractor, 'extractor', true)!, deps.env) }) },
  { name: 'run_extractor', title: 'Run an extractor on a meeting', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Run one extractor over one meeting through the AI provider the user chose for final notes, save the result with the meeting, and return it. Takes a minute or more. Replaces that extractor\'s earlier result for the meeting.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'extractor'], properties: {
      id: string('Meeting ID'), extractor: string('Extractor name') } },
    run: runExtractorTool },
  { name: 'list_automations', title: 'List automations', annotations: readOnly,
    description: 'The user\'s automations: what triggers each, its filters and actions, whether the owner has allowed its outward actions, and its recent runs.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { recentRuns: integer('Runs to show per automation (default 5)') } },
    run: listAutomationsTool },
  { name: 'create_automation', title: 'Add an automation', annotations: adds,
    description: 'Add an automation that runs when a meeting is ready: run extractors, write the notes to a folder, run a shell command with the meeting JSON on stdin, or post it to a webhook. Shell and webhook actions do nothing until the owner allows them in a Seashell dialog; tell the user so.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'actions'], properties: automationProperties },
    run: (libraryDir, args, deps) => {
      const { hash: _hash, ...created } = createAutomation(libraryDir, {
        name: text(args.name, 'name', true)!, actions: automationActions(args.actions)!,
        ...(args.enabled === undefined ? {} : { enabled: args.enabled === true }), filters: automationFilters(args.filters),
      }, deps.env);
      return created;
    } },
  { name: 'update_automation', title: 'Change an automation', annotations: replaces,
    description: 'Change an automation by name. Parts left out keep their current value; actions, when given, replace the whole list. Any change asks the owner again before shell or webhook actions run.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['automation'], properties: {
      automation: string('Current name'), ...automationProperties } },
    run: (libraryDir, args, deps) => {
      const { hash: _hash, ...updated } = updateAutomation(libraryDir, text(args.automation, 'automation', true)!, {
        ...(args.name === undefined ? {} : { name: text(args.name, 'name', true)! }),
        ...(args.enabled === undefined ? {} : { enabled: args.enabled === true }),
        ...(args.filters === undefined ? {} : { filters: automationFilters(args.filters) }),
        ...(args.actions === undefined ? {} : { actions: automationActions(args.actions)! }),
      }, deps.env);
      return updated;
    } },
  { name: 'delete_automation', title: 'Delete an automation', annotations: removes,
    description: 'Delete an automation\'s file. Its past runs stay in the log.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['automation'], properties: { automation: string('Automation name') } },
    run: (libraryDir, args, deps) => ({ deleted: deleteAutomation(libraryDir, text(args.automation, 'automation', true)!, deps.env) }) },
  { name: 'list_prompts', title: 'Read the AI prompts', annotations: readOnly,
    description: 'The user\'s instructions for each meeting AI role: live (live analysis), notes (final notes) and chat (meeting chat), with their files. Comments in a file are never sent. What notes must cover and how they cite stay fixed.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: listPromptsTool },
  { name: 'update_prompt', title: 'Change an AI prompt', annotations: replaces,
    description: 'Replace one prompt file (live, notes or chat). It applies the next time that role runs. An empty text sends no instructions.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'text'], properties: {
      name: { type: 'string', enum: ['live', 'notes', 'chat'] }, text: { type: 'string', description: 'The whole file' } } },
    run: (libraryDir, args, deps) => {
      if (typeof args.text !== 'string') throw new Error('text must be a string');
      return { path: writePrompt(libraryDir, text(args.name, 'name', true)!, args.text, deps.env) };
    } },
  { name: 'list_templates', title: 'Read notes templates', annotations: readOnly,
    description: 'The user\'s notes templates (each ## heading is a section of the notes, the text under it says what goes there; match words pick a template from the meeting title) and their "About me" profile.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: listTemplatesTool },
  { name: 'update_template', title: 'Change a notes template', annotations: replaces,
    description: `Replace a notes template by name, or add one. Use the name "${PROFILE_FILE.replace(/\.md$/u, '')}" to replace the profile, with its text as body.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'body'], properties: {
      name: string('Template name'), body: string('The sections: one ## heading each, with guidance under it'),
      description: string('When to use it'), match: stringList('Title words that pick this template'),
      default: { type: 'boolean', description: 'Use it when no other template matches' } } },
    run: (libraryDir, args, deps) => {
      const name = text(args.name, 'name', true)!;
      if (typeof args.body !== 'string') throw new Error('body must be a string');
      if (name.toLocaleLowerCase() === PROFILE_FILE.replace(/\.md$/u, '').toLocaleLowerCase()) {
        return { path: writeProfile(libraryDir, args.body, deps.env) };
      }
      const { body: _body, ...template } = writeMeetingTemplate(libraryDir, { name, body: args.body,
        ...(args.description === undefined ? {} : { description: text(args.description, 'description', true)! }),
        ...(args.match === undefined ? {} : { match: strings(args.match, 'match')! }),
        ...(args.default === undefined ? {} : { default: args.default === true }) }, deps.env);
      return template;
    } },
  { name: 'edit_segment', title: 'Fix a transcript line', annotations: edits,
    description: 'Correct the words of one transcript segment, e.g. a misheard name. The old transcript is kept in the meeting\'s history; the notes stay and are marked as possibly out of date.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'segmentId', 'text'], properties: {
      id: string('Meeting ID'), segmentId: string('Segment ID, e.g. s000123'), text: string('The corrected words') } },
    run: (libraryDir, args) => {
      const { record } = loadMeeting(libraryDir, args.id);
      return editTranscriptSegment(libraryDir, record.id, text(args.segmentId, 'segmentId', true)!, text(args.text, 'text', true)!);
    } },
  { name: 'rename_speaker', title: 'Name a speaker', annotations: edits,
    description: 'Give a speaker a name, by speaker ID or current label ("Remote speaker 1"). The old transcript is kept in the meeting\'s history; the user can put it back with seashell meeting restore. Notes keep their content; placeholders like "Remote speaker 1" in them take the name. Renaming someone already named moves their actions, and their name where it is a whole word, to the new name, and marks the notes as possibly out of date. Seashell does not learn the voice from a name an agent gives.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'speaker', 'name'], properties: {
      id: string('Meeting ID'), speaker: string('Speaker ID or current label'), name: string('Their name') } },
    run: (libraryDir, args) => {
      const { record } = loadMeeting(libraryDir, args.id);
      return renameMeetingSpeaker(libraryDir, record.id, text(args.speaker, 'speaker', true)!, text(args.name, 'name', true)!);
    } },
];

type Request = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** One JSON-RPC message in, at most one response out (notifications get none). */
export async function handleMeetingsMcpMessage(
  libraryDir: string, message: Request, version: string, deps: MeetingsMcpDependencies = {},
): Promise<Record<string, unknown> | undefined> {
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
        const result = await tool.run(libraryDir, (message.params?.arguments ?? {}) as Arguments, deps);
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

/**
 * stdio transport: newline-delimited JSON-RPC; stdout carries protocol only.
 * Requests are answered in order; a long extractor run holds the ones behind it.
 */
export async function runMeetingsMcpServer(libraryDir: string, version: string,
  input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout,
  deps: MeetingsMcpDependencies = {}): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Request;
    try { message = JSON.parse(line); } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    const response = await handleMeetingsMcpMessage(libraryDir, message, version, deps);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
