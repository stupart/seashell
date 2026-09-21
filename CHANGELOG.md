# Changelog

## Unreleased

### Fixed

- Meeting claims, notes and chat now bind to transcript content. Replacing or
  re-segmenting a transcript archives old evidence, resets stale observation,
  and rejects in-flight results for a superseded revision. Ordinary append
  preserves valid observations; cumulative observer budgets remain bounded.

- Humain discovery uses only an explicit `HUMAIN_CLI` or `humain` on PATH,
  instead of silently selecting a developer checkout under the user's home.
- CLI meeting enrichment includes configured context files and saved meeting
  context. An explicit `--context` replaces it; unavailable approved files stop
  dispatch before the model runs.

### Documentation and validation

- Updated publication status, public install testing, and the meeting/Humain
  readiness guide, including private-engine and live-evidence limitations.
- 187 Bun tests, 3 Python tests, typecheck, native compilation, accelerated
  capture-storage recovery, and 100 synthetic meeting lifecycles passed.
- The real Humain contract gym passed with a local fixture provider.

## 1.1.0-rc6 — Homebrew candidate, 20 September 2026

### Added

- Public Homebrew formula with bundled Bun, native helpers, and local models;
  fresh Apple Silicon and Intel install/transcription checks; MIT license file.
- Reliability gym with accelerated capture recovery and repeated meeting tests.
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
- Capture clock evidence and durable overrun discontinuities.
- A preallocated CoreAudio packet ring, async chunk commit queue, bounded local
  ASR scheduler, owned warm Whisper server, and local benchmark/profile command.
- Consented Local/Cloud/Adaptive transcription routing through Humain's
  exact-model OpenRouter STT capability, with a separately pinned final route.
- Automatic meeting lifecycle detection from macOS process-audio signals,
  including confirmation polls, browser consent policy, dropout grace, maximum
  duration, cooldown, and Calendar corroboration.
- A low-resource background watcher that durably captures first, performs final
  ASR/enrichment after the call, serializes finalizers, and shares a one-owner
  lock with the TUI.
- `seashell meeting watch` and `meeting autostart` commands, a private per-user
  macOS LaunchAgent, native signal helper, doctor check, and capability offer.
- Short-lived `meeting consent approve|decline` control for browser suggestions
  raised by the headless watcher, with a macOS notification and one-use expiry.
- Calendar attendee extraction for conservative post-diarization naming and
  explicit bounded meeting context files for project/company grounding.
- One-command bootstrap and idempotent first-install configuration: local-only
  defaults, automatic login launch, and environment-variable opt-outs.

### Changed

- Fixed silent capture startup, incomplete final transcripts, capture shutdown,
  torn-journal recovery, stale meeting signals, and duplicate watcher ownership.
- Start timestamps when recording begins; follow incoming live text while
  retaining manual scrollback; clarify microphone/computer-audio status.
- TUI timestamps use a compact media-relative clock while canonical data and
  subtitle exports retain millisecond precision.
- Meeting complexity is hidden from ordinary transcript items; the existing
  transcript-first UI remains the default.
- Meeting idempotency now binds the approved context as well as transcript,
  claims, route, and conversation state; changed context cannot collide with a
  prior durable run.
- Successful retries clear prior failure state and return the same updated
  metadata written to disk.
- The macOS aggregate device now uses the current system output as its explicit
  hardware clock source; audio conversion and pipe I/O no longer run inside the
  real-time CoreAudio callback.
- Remote canonical finalization transcribes durable chunks directly instead of
  assembling unused meeting-length tracks.
- The default TUI starts in an inexpensive meeting-watching state instead of
  opening capture and Whisper immediately. New private artifacts use `0700`
  directories and `0600` files.
- The macOS meeting-signal helper now stays alive and streams snapshots, avoiding
  repeated CoreAudio startup work; Calendar failures use concise permission
  guidance and a retry cooldown instead of dumping AppleScript commands.

### Verified

- RC6 source: 183 Bun tests, 3 Python tests, typecheck, native build, storage
  recovery, and 100 synthetic meeting lifecycles. Post-merge
  [source](https://github.com/stupart/seashell/actions/runs/35538629817) and
  [fresh installation CI](https://github.com/stupart/homebrew-tap/actions/runs/35538519086)
  passed. Real Meet capture/stop and the microphone test sentence are recorded
  in the [acceptance report](docs/google-meet-acceptance-2026-09-20.md).

### Earlier development checks

- Full suite: 121 Bun tests, 3 Python tests, strict TypeScript checking, and
  shell syntax/static analysis.
- Actual terminal captures covered the transcript-first meeting view and the
  responsive on-demand history drawer.
- A live Sea Shell -> Humain -> OpenRouter retry completed through DeepInfra on
  `google/gemma-3-4b-it`, producing evidence-linked output and an exact receipt
  with 369 input tokens, 121 output tokens, and `$0.00003055` reported cost.
- Local ASR benchmark: 3.7518 seconds of audio, four-thread median 2.030
  seconds, real-time factor `0.5411`, using the exact installed quantized model.
- Live OpenRouter STT canary: exact `openai/whisper-large-v3-turbo` route pinned
  to Groq, segment timestamps preserved, `$0.00011111111111111112` provider cost.
