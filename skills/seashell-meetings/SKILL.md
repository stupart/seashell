---
name: seashell-meetings
description: Use the user's recorded meetings from Seashell (local transcripts, speakers and AI notes) to answer questions about past calls, find decisions and action items, prepare for an upcoming meeting, or draft follow-ups. Use when the user mentions a meeting, call, sync, 1:1, "what did we decide", "who said", "action items", "follow up", or a person they met with.
---

# Seashell meetings

Seashell records the user's meetings on this Mac and exposes them through the
`seashell` MCP server (read-only). Transcripts never leave the Mac unless you
send their content somewhere, so only do that when the user asks.

## Find the right meeting first
- `list_meetings` (newest first; `query`, `from`, `to`) or `search_transcripts`
  (every word must appear in one segment). Never guess a meeting or segment ID.
- Then `get_meeting` for notes (summary, decisions, action items with their
  supporting segments) and `get_transcript` to read the exact words (page with
  `offset`/`nextOffset`; filter one `speaker`).
- When `get_meeting` notes carry `sections`, they follow the user's own notes
  template (for example "Goals and pain points", "Next steps"); prefer them
  for the layout of a summary or follow-up, and keep their citations.

- A meeting listed as `private` has AI turned off by the user. Tell them it is
  private rather than reading its files directly.

## Speakers
- "Microphone" is the user. "Remote speaker N", "System audio" and
  "Unknown remote speaker" are other people. Calendar attendees (in
  `get_meeting`) suggest who they are, but say when a name is a guess.

## Always cite
Quote or attribute with the segment ID and time, like `[s000123 12:04]`, so the
user can jump to the source. If the transcript does not support an answer, say so.

## Common jobs
- **What did we decide / who owns what:** `get_meeting` items of type
  `decision` and `action_item`; confirm wording against the transcript.
- **Across meetings:** `list_action_items` (optionally `since`), or
  `search_transcripts` for a topic, then read the surrounding segments.
- **Prep for a meeting:** find earlier meetings with the same people or title,
  summarize open action items and unresolved questions.
- **Follow-up email or Slack message:** draft it from decisions and action items
  with owners and dates; show the draft and wait for approval before sending.
- **File work (e.g. Linear, GitHub):** propose the issues (title, description,
  owner, source segment) and create them only after the user confirms, using
  their own connected tools.

Machine transcripts mishear names and jargon. When something looks wrong,
check neighbouring segments before relying on it.
