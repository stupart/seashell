# Changelog

## Unreleased

### Added

- Audio and video transcription through one timestamped media pipeline.
- Independent timestamp and speaker presentation across text, JSON, SRT, VTT,
  CLI, and TUI surfaces.
- Local transcript library, history drawer, search, exports, recoverable trash,
  and speaker renaming.
- Conservative roster/evidence-based speaker identification.
- `seashell update` clean fast-forward updater.
- Optional meeting artifacts with read-only calendar association, incremental
  observer windows, hybrid final reconciliation, evidence-linked analysis,
  cited meeting chat, durable Humain receipts, and generated documents.
- `seashell meeting setup|create|enrich|show|chat|calendar` machine-readable CLI
  surface.

### Changed

- TUI timestamps use a compact media-relative clock while canonical data and
  subtitle exports retain millisecond precision.
- Meeting complexity is hidden from ordinary transcript items; the existing
  transcript-first UI remains the default.
- Meeting idempotency now binds the approved context as well as transcript,
  claims, route, and conversation state; changed context cannot collide with a
  prior durable run.
- Successful retries clear prior failure state and return the same updated
  metadata written to disk.

### Verified

- Full suite: 68 Bun tests, 3 Python tests, and strict TypeScript checking.
- Actual terminal captures covered the transcript-first meeting view and the
  responsive on-demand history drawer.
- A live Sea Shell -> Humain -> OpenRouter retry completed through DeepInfra on
  `google/gemma-3-4b-it`, producing evidence-linked output and an exact receipt
  with 369 input tokens, 121 output tokens, and `$0.00003055` reported cost.
