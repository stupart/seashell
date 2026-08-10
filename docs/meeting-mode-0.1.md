# Sea Shell meeting mode 0.1

## Product boundary

Sea Shell owns capture, media preparation, ASR, diarization, stable transcript
segments, the transcript library, exports, and the terminal experience. Humain
owns model execution, route identity, policy, durable run evidence, usage, and
cost provenance. The meeting controller is intentionally narrow and lives in
Sea Shell until Humain's generic durable Loop and Workflow runtime exists.

The base transcript is always authoritative and independently usable. Meeting
intelligence is a companion `meeting.json` manifest plus versioned overlays and
derived documents. No enrichment failure may overwrite or block the base.

## Session workflow

```text
mark or calendar-associate transcript
  -> save canonical transcript
  -> initialize meeting cursor, overlap, run budget, and artifact manifest

while meeting is active and enough new segments exist
  -> freeze new segment range plus bounded overlap
  -> send approved context + compact provisional claims to a cheap observer
  -> reject schema errors and citations to nonexistent segment IDs
  -> append provisional overlay
  -> durably advance cursor

when the meeting ends (hybrid/post-session)
  -> freeze complete transcript
  -> reconcile provisional claims with later corrections and complete context
  -> publish final overlay
  -> derive notes, decisions, actions, resources, and enriched exports

chat
  -> use frozen transcript + final claims + recent meeting conversation
  -> require evidence segment IDs in every answer
```

## UX contract

- The default live surface remains the simple transcript-first Sea Shell UI.
- `H` opens the existing left history drawer. Meetings are marked there without
  adding a second navigation system.
- Ordinary transcripts show the ordinary reader.
- Meetings add one compact view strip: Notes, Transcript, Analysis, Chat.
- Timestamps and speaker labels stay presentation toggles over the same stored
  transcript.
- Calendar suggestions are read-only and opt-in. `ask` is the default policy
  when the connector is enabled.
- The TUI never silently chooses a model. Backend and exact model must be saved
  with `seashell meeting setup` or provided to the CLI invocation.

## Failure and trust rules

- Provisional claims are never presented as final.
- Every claim and chat answer cites stable transcript segment IDs.
- Missing evidence, unknown claim types, malformed output, or out-of-range
  confidence fails that enrichment run.
- The observer has a maximum run count and monotonically advancing cursor.
- A failed run records an artifact failure while leaving transcript and exports
  readable.
- The Humain run store is private product evidence; the friendly meeting folder
  is the user-facing artifact.
