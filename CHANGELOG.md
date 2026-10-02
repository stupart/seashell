# Changelog

## Unreleased — calendar titles that work in the background

- Meeting titles and attendees come from a native "Seashell Calendar" helper
  using EventKit. Scripting Calendar.app could not work from the background
  recorder (its hardened Bun host cannot hold Apple Events permission) and
  launched Calendar.app on every read. Reads never prompt; turn titles on with
  `,` → Meeting titles from Calendar, or `seashell meeting calendar setup`.
- The Meet link is found in the event's URL, location or notes (where Google
  Calendar puts it), so a Meet call matches its event. Notes are searched,
  never stored. All-day and cancelled events are ignored.
- The login watcher restarts itself between meetings when Seashell is upgraded
  or settings change, so new code and settings apply without a manual restart.
  It never restarts during a meeting.

## Unreleased — keep microphone permission across upgrades

- The installed "Seashell Microphone" copy is replaced only when its helper
  protocol changes. Rebuilding the same helper with another SDK (Homebrew vs. a
  source build, or a Command Line Tools update) changes its bytes, and macOS
  ties Microphone access to the exact code hash, so replacing it asked again.
- Out-of-view Meet windows now read "A call already recording keeps recording"
  instead of "meeting detection paused".

## Unreleased — Settings: what works, at a glance

- Press `,` for Settings: features on the left, details and one-key fixes on the
  right. The Overview lists every capability as working, needs attention, off or
  broken. It is judged from permissions, the running recorder, and what your
  last meeting actually captured, not from configuration alone.
- Enter fixes what Seashell can fix itself: start the background recorder,
  connect Google Meet, allow the microphone, or open speaker and AI setup.
- The header says "Setup needed" when something required for recording is broken.
- `seashell status [--json]` prints the same table with a command for each fix.

## Unreleased — one meeting, one entry

- Safari Meet calls no longer split when the browser's Accessibility tree is
  briefly unreadable. Safari captures the microphone in `com.apple.WebKit.GPU`
  (Chrome in `com.google.Chrome.helper`); the observation-gap rule now compares
  browser families instead of literal bundle IDs. In real use this bug turned
  three calls into eleven entries and dropped up to 8½ minutes between pieces.
- A call that ends and comes back within `meeting.automation.resumeWindowSeconds`
  (default 180, 0 disables) reopens the same capture bundle on its original clock
  and continues the same entry; the final transcript runs once, over the whole meeting.
- Background meetings now record your microphone. The watcher's Bun host uses the
  hardened runtime without the audio-input entitlement, so macOS gave SoX silent
  buffers (every background mic track was digital zero). A native
  `seashell-microphone` helper answers for its own Microphone permission, follows
  device changes, and keeps the stream on the wall clock. Grant it once with
  `seashell meeting microphone setup`; check with `seashell meeting microphone`.
- Microphone failures retry with backoff for the whole meeting instead of
  giving up after two restarts; a denied permission is reported, not retried.
- `seashell meeting merge <id>...` and `meeting merge --auto [--dry-run]` join
  pieces of one meeting into one entry and one capture bundle; pieces go to `_Trash`.
- History rows show day, start time and length before the title.
- A full-screen Meet window on another desktop (Space) is no longer read as a
  confirmed departure; Accessibility cannot see other desktops, so it now counts
  as unreadable and recording continues while the browser holds the microphone.

## Unreleased — Google Meet names

- One automatic connection discovers Chrome and Safari without a browser
  selection. Report the connected browser, reject simultaneous calls or an
  unreadable second browser, and preserve browser identity across pause/resume.

- Opt-in Chrome/Safari reader for visible Meet participant names and speaking
  indicators. Connect or check permissions in V, or `meeting speakers`.
- Save bounded, timestamped speaker evidence alongside capture audio; apply
  conservative names to live drafts and smaller final ASR units. Overlap,
  transitions, stale reads, multiple calls and unknown tiles retain source labels.
- Distinguish platform timing hints from voice separation and verified identity.
  No model, browser extension, extra login or audio upload is required.

## Unreleased — local speaker separation

- V opens speaker setup/readiness and saved-recording reprocessing; Shift+F
  directs unconfigured users to setup. Optional Python/model state survives upgrades.
- `setup --speakers [--login|--check]` verifies the actual model; readiness is
  shared by doctor, capabilities and automatic meeting finalization.
- Local finalization separates remote voices when ready. Failure saves source
  text with an explanation; unknown voices never get a numbered identity.
- Saved-recording retries produce a review copy, preserving original corrections
  and notes. Names can be assigned using existing speaker rename controls.
- Add public AMI video scoring gym and pipeline/UI regressions. Actual model
  quality remains gated on user model access; fixture tests do not establish accuracy.


## Unreleased — AI provider picker

- Choose meeting AI from the TUI with P or `seashell ai setup`.
- Discover Claude Code, Codex, local models and OpenRouter through Humain, with setup guidance and explicit model/privacy choices.
- Apply post-session notes/chat settings without restarting capture or losing compatible limits.

## Unreleased

### Added

- Install a private Humain engine package with `seashell ai install`, inspect Node readiness and discover AI providers.
- Select a loopback `local-openai` model for evidence-validated meeting analysis.

### Fixed

- Meeting claims, notes and chat now bind to transcript content. Replacing or
  re-segmenting a transcript archives old evidence, resets stale observation,
  and rejects in-flight results for a superseded revision. Ordinary append
  preserves valid observations; cumulative observer budgets remain bounded.

- Humain discovery uses an explicit `HUMAIN_CLI`, an installed engine package, or `humain` on PATH,
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
