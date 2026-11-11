---
name: seashell-meetings
description: Use the user's recorded meetings from Seashell (local transcripts, speakers, AI notes and insights) to answer questions about past calls, find decisions, action items, risks and open questions across meetings, prepare for an upcoming meeting, draft follow-ups, or, when asked, fix a transcript and shape how Seashell writes notes (prompts, templates, extractors, automations). Use when the user mentions a meeting, call, sync, 1:1, "what did we decide", "who said", "action items", "follow up", or a person they met with.
---

# Seashell meetings

Seashell records the user's meetings on this Mac and exposes them through the
`seashell` MCP server. Transcripts never leave the Mac unless you send their
content somewhere, so only do that when the user asks.

## Find the right meeting first
- `list_meetings` (newest first; `query`, `from`, `to`) or `search_transcripts`
  (every word must appear in one segment). Never guess a meeting or segment ID.
- Then `get_meeting` for notes (summary, decisions, action items with owner
  and due date, risks, open questions, follow-ups, each with its supporting
  segments) and `get_transcript` to read the exact words (page with
  `offset`/`nextOffset`; filter one `speaker`).
- When `get_meeting` notes carry `sections`, they follow the user's own notes
  template (for example "Goals and pain points", "Next steps"); prefer them
  for the layout of a summary or follow-up, and keep their citations.
- `possiblyOutOfDate` means words changed after the notes were written (a
  corrected line, removed silence). Check the transcript before relying on them.
- A meeting listed as `private` has AI turned off by the user. Tell them it is
  private rather than reading its files directly. Every tool refuses it.

## Across meetings
- `query_notes` answers "what did Dana commit to", "decisions about pricing
  since October", "open questions from the hiring syncs": filter by `kind`
  (decisions, actions, risks, questions, follow-ups), `person`, `about`,
  `meeting`, `since` and `until`. Seashell does not track whether an action
  was done; say so rather than calling one open or closed.
- `list_action_items` is the quick list of every action item.

## Insights and video
- `get_insights` shows what the user's extractors found in a meeting (named
  fields, each item cited). `run_extractor` runs one now through the AI the
  user chose; it takes a minute or more and sends that meeting to their provider.
- `get_video_moment` gives the screen recording file and the offset where a
  segment was said, or `video: null` when there is no recording.

## Speakers
- "Microphone" is the user. "Remote speaker N", "System audio" and
  "Unknown remote speaker" are other people. Calendar attendees (in
  `get_meeting`) suggest who they are, but say when a name is a guess.

## Always cite
Quote or attribute with the segment ID and time, like `[s000123 12:04]`, so the
user can jump to the source. If the transcript does not support an answer, say so.

## Changing things (only when the user asks)
These tools change the user's own files. Say what you changed.
- **Transcript:** `edit_segment` fixes a misheard line; `rename_speaker` names a
  speaker by ID or current label. The old transcript is kept in the meeting's
  history and the notes stay (marked possibly out of date after an edit).
- **Prompts:** `list_prompts` / `update_prompt` for what each AI role is told
  (`live`, `notes`, `chat`). Text inside `<!-- -->` is a note to the user and
  is never sent. Prompts steer focus and style; the citation rules are fixed.
- **Templates:** `list_templates` / `update_template` for notes templates (one
  `##` heading per section, guidance under it) and the "About me" profile.
- **Extractors:** `list_extractors`, `create_extractor`, `update_extractor`,
  `delete_extractor`. Each has fields (name and what counts), a prompt, and
  `when`: `always`, `manual`, or title, attendee or app words.
- **Automations:** `list_automations`, `create_automation`,
  `update_automation`, `delete_automation`. They run when a meeting is ready:
  extract, write the notes to a folder, run a shell command with the meeting
  JSON on stdin, or post to a webhook. One you add or change is saved off: tell
  the user to read its file and change `enabled: false` to `enabled: true`.
  Shell, webhook and writes outside the Sea Shell folder then wait until the
  user allows them in a Seashell dialog, and again after any change; tell the
  user to expect that dialog.

## Common jobs
- **What did we decide / who owns what:** `get_meeting` items of type
  `decision` and `action_item`; confirm wording against the transcript.
- **Prep for a meeting:** `query_notes` with the people or title words for
  earlier action items, risks and open questions; read the cited segments.
- **Follow-up email or Slack message:** draft it from decisions and action items
  with owners and dates; show the draft and wait for approval before sending.
- **File work (e.g. Linear, GitHub):** propose the issues (title, description,
  owner, source segment) and create them only after the user confirms, using
  their own connected tools.

Machine transcripts mishear names and jargon. When something looks wrong,
check neighbouring segments before relying on it, and offer to fix the line.
