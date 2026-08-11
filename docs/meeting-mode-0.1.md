# Sea Shell meeting mode 0.1

## Product boundary

Humain owns reusable capture/transcription protocol semantics, capability
discovery, model execution, route identity, policy, durable run evidence,
usage, and cost provenance. Sea Shell implements the first local macOS capture
and transcription provider and owns transcript presentation, library, exports,
and terminal experience. Sea Shell keeps running independently; the
implementation remains local until another consumer proves an extraction
boundary. The meeting controller is intentionally narrow and lives in Sea Shell
until Humain's generic durable Loop and Workflow runtime exists.

The base transcript is always authoritative and independently usable. Meeting
intelligence is a companion `meeting.json` manifest plus versioned overlays and
derived documents. No enrichment failure may overwrite or block the base.

## Session workflow

```text
mark or calendar-associate transcript
  -> save canonical transcript
  -> initialize meeting cursor, overlap, run budget, and artifact manifest

for every microphone or system-audio packet
  -> map it onto the shared live-session clock
  -> atomically commit an independently decodable WAV chunk
  -> fsync an append-only journal event before live ASR
  -> update independent source health and transcript projections

while meeting is active and enough new segments exist
  -> freeze new segment range plus bounded overlap
  -> send approved context + compact provisional claims to a cheap observer
  -> reject schema errors and citations to nonexistent segment IDs
  -> append provisional overlay
  -> durably advance cursor

when the meeting ends (hybrid/post-session)
  -> stop both sources and wait for committed work
  -> assemble each durable track and run final ASR
  -> reconcile playback echo and freeze the complete transcript
  -> attach the raw capture bundle beside the transcript
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
- The TUI never silently chooses a model. Sea Shell selects separate exact
  observer, reconciliation, and chat routes from settings; Humain pins them in
  compiled runs and receipts. A shared backend/model remains the fallback.
- “Works with,” “detects,” and “integrates with” Google Meet are separate
  capabilities. Local mic + system capture now satisfies the first beta
  checkpoint; detection and participant/active-speaker integration remain
  unimplemented.
- Capture persistence is inference-independent: each source commits local audio
  first, so a model crash cannot erase the already recorded session. `Q` saves
  and attaches it; `G` additionally performs final-track ASR and enrichment.

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
