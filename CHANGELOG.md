# Changelog

## Unreleased — watch a call back, and notes that do more

**Security and privacy**

An outside review of rc33 found these. All are fixed.

- **Automations can't overwrite your files.** A `write` action never replaces
  a file Seashell didn't write, and never writes through a link; when a file is
  already there, the notes go beside it as `… (2).md`. Its files are readable
  only by you. A meeting's title can no longer point a `write` at another
  folder. Writing outside the Sea Shell folder asks you first, as `shell` and
  `webhook` do.
- **An agent can't turn an automation on.** One an agent adds or changes
  through the meetings server is saved off. Read it, then turn it on in its
  file. Settings shows it as "Off: made by an agent".
- **Approvals can't be forged.** Your answers to automation dialogs are signed
  with a key in your login Keychain. Editing the script a `shell` action runs
  asks again, and the dialog shows which file runs. Commands get only `PATH`,
  `HOME`, `LANG`, `TMPDIR` and the meeting's variables. The dialog shows a
  command exactly as it will run: hidden and right-to-left characters can't
  disguise it. Each automation asks once more after this update.
- **Webhooks go only where the file says.** https only, never on to a redirect,
  and never to this Mac or your local network unless the file names that
  address itself.
- **Video never films your screen in place of the call.** With no call window,
  the audio records alone and Seashell looks for the window every 30 seconds.
  A browser is filmed only while its tab shows the call; another tab pauses the
  video. The title line says what is filmed. Only `seashell record --video
  --display N` films a whole display, and then you get a notification. macOS
  asks once more for Screen Recording for the updated helper.
- **Private means private.** A meeting whose settings can't be read counts as
  private. Seashell checks again just before each automation action, so a
  meeting made private mid-run sends nothing more.
- **Voices are kept only as long as needed.** A private meeting keeps no
  voices. Voices nobody named go after 90 days, and a meeting moved to the
  Trash loses its own. Forgetting a person removes their voice from every
  meeting, and names Seashell suggested from it go back to a number.
- **A name an agent gives a speaker doesn't teach Seashell their voice**, and
  the old transcript is kept in the meeting's history.

**Video**

- Calls now record their window beside the audio: the Meet tab, or the Zoom,
  Teams or FaceTime window, with whatever anyone shares. It is on by default,
  at 2 frames a second, about 60 MB an hour. macOS asks once for
  **Seashell Screen Capture**; until then calls record audio only.
- In a meeting, **W** plays its video beside the transcript, from the line you
  are reading. `seashell meeting video <id> [--at 12:34]` does the same.
- **Shift+V** records by hand with video. **Space** stays audio only.
  `seashell record --video` does the same from a terminal.
- Settings → **Video** turns it on or off and asks macOS for access.
  `seashell meeting video on|off|setup` and `<app> on|off` work too.

**Notes, extractors and automations**

- Notes lead with decisions, actions (with who and by when), risks, open
  questions and follow-ups, then your template.
- Fixing a line or a speaker's name keeps the notes, marked as possibly out of
  date.
- **Prompts:** what the AI is told for live analysis, final notes and chat are
  files you can edit in `~/Documents/Sea Shell/Prompts`. Settings → Prompts
  opens one or puts it back as shipped.
- **Extractors** pull the same things out of every meeting, each one cited, and
  show under Insights in the notes. **Automations** save the notes to a
  folder, run a command or post to a web address when a meeting is ready.
  Anything sent outside Seashell asks you first. Settings lists both, and the
  last automation runs.
- A meeting this window finishes now runs extractors and automations too, as
  the background recorder does. Rewriting notes with **G** runs the extractors
  again.
- **P** → **Test connection** sends one short fixed message through each AI in
  use and says how fast it answered, or why it did not. `seashell ai test` does
  the same.
- `seashell query` finds decisions, actions, risks, questions and follow-ups
  across meetings. `seashell library clean-phantoms` removes lines Whisper
  heard in silence from saved meetings.
- The meetings server for Claude Code and Codex can now search notes across
  meetings, find the video moment for a line, and, when you ask, fix a line,
  name a speaker, or edit prompts, templates, extractors and automations.

**Who said what**

- Voices are separated by two engines: Nemotron 3, checked by community-1. On
  13 test meetings, wrong-speaker words fell from 3% to about 0.5%.
- The calendar invite caps how many voices a meeting can have.
- When you name a speaker, Seashell learns their voice, on this Mac only, and
  suggests the name in later meetings. **R** marks a suggestion; **Y** keeps it
  and **U** undoes it. Settings → **Saved voices** forgets anyone.
- Google Meet's names now reach the parts of a call Meet could not see, when
  the voice is clearly the same person.
- A recording started from a calendar event in this window, or recovered with
  `seashell capture finalize`, also uses its invitees.

**Your side of the call**

- Your microphone is recorded whatever input you use: a headset, an interface
  or a dock, not just the built-in one. macOS asks for **Seashell Microphone**
  once more.
- During a call, Seashell tells you once if the others are talking and your
  microphone has heard nothing for a minute.
- After a call where your microphone heard almost nothing, the meeting says
  "Your side wasn't recorded" in yellow, and Settings says to check it.
- Computer audio survives any number of device changes, and restarts by itself
  if it stalls.
- Computer audio can now record with its own permission, **Seashell System
  Audio**, instead of the background recorder's. Meetings switch only after you
  allow it at your Mac: Settings → Computer audio → Enter, or
  `seashell meeting computer-audio setup`. Until then nothing changes, so no
  call waits on a macOS question. If macOS later refuses it, or it sends only
  silence, the recording goes back to the old permission and says so.
- The guided setup tests that same helper, and Settings remembers a pass after
  a restart.

**Setup and Settings**

- A first run opens a guided setup. It starts the background recorder, hears
  your microphone and your Mac's sound, then offers the extras.
- Settings → **Recording** chooses which calls record by themselves, ask first
  or never, per app.
- Every screen uses one title, one rule, one key bar and one way to show the
  chosen row. Dates in the meetings list line up, even beside an emoji or a
  CJK title.

**Faster and quieter**

- The final transcript arrives sooner: on a 25-minute meeting, 34 s became
  24 s.
- whisper.cpp uses the right number of cores for your Mac.
- The meetings list and search read each transcript once, not every second.
- Meet is checked only when a call is possible, not every few seconds all day.
- The watch log no longer fills with the same warning.

**Fixes**

- After `library clean-phantoms`, rewriting notes, chat and extractors failed
  for every cleaned meeting: the notes still cited the removed lines, and
  agents saw those lines at 00:00. A note now keeps only the lines the
  transcript still has. One whose only line was removed stays, marked "source
  line removed", and is no longer sent to the AI. Meetings cleaned before this
  heal by themselves.
- Undoing a suggested name, or correcting a real one, left the old name in the
  notes and as the action's owner. The name now changes there too, and the
  notes say "Dana was renamed to Remote speaker 1". Agents see which names are
  only Seashell's suggestion.
- Notes no longer hide an action behind a similar line ("…to Acme" hid "…to
  Globex"), or show it with someone else's name and date.
- An extractor no longer saves what it found if the transcript changed while
  it ran. Each insight says "may be out of date" until it runs again, even
  after the notes are rewritten. `seashell query` and the meetings server say
  when a note may be out of date.
- `seashell query --person dan` no longer finds Jordan's actions, and an action
  belongs to its owner, not whoever said it. `--person me` finds yours.
- Dates in `seashell query` and the meetings server are your local day, as the
  library's folders are.
- The meetings server answers questions across the library about 35 times
  faster at 200 meetings, and reading never changes a meeting.
- `seashell meeting restore <id>` lists the transcripts kept in a meeting's
  history, and puts one back. The notes stay. Each meeting keeps its 20 most
  recent.
- `library clean-phantoms` keeps lines with no recorded audio under them, in a
  gap, a dropout or past the end, instead of treating them as silence.

## Unreleased — your side of the call, and no more phantom words

- The microphone recorded digital silence whenever the input was a built-in Mac
  microphone. It reports three discrete channels, and the conversion to mono
  output zeros for that layout. Channels are now averaged before resampling.
  macOS asks to allow Seashell Microphone once more after this update.
- Whisper no longer invents "Thank you" and "Okay" over silence. Speech detection
  now gates both the live draft and the final transcript. A line is removed only
  if no speech touches it and it is quiet, so loud lines always stay. On three
  AMI meetings all 12,116 hand-labelled words survived the gate, including 998
  short replies such as "okay".

## Unreleased — never miss a call

- Google Meet calls stopped recording on their own from late October. Seashell
  starts a browser call once it reads the Meet page, and it cannot read Meet in
  full screen, on another desktop or in a background tab, nor while any other
  window without a page, such as Settings, is open. It fell back to asking first,
  and the question only appeared inside an open Seashell window, so calls went
  unrecorded.
- A Meet, Zoom or Teams call on your calendar now records by itself from the
  browser's microphone. Choosing to record browser calls automatically now means
  never being asked, even when Meet is unreadable.
- Windows with no tabs and no page no longer make Meet unreadable.
- When a call does need a yes, a dialog asks directly. The old notification only
  said to run a command.
- The log says why a call was asked about instead of recorded.
- Record by hand: Space in Seashell, or `seashell record`. Stop any recording
  with Space or `seashell record stop`; a call stopped by hand stays stopped
  until it ends.
- `seashell meeting apps` lists each app; `seashell meeting apps facetime off`
  turns one off. Each app can be on, off or ask.

## Unreleased — one layout, and fewer false alarms

- Every screen now shares one title line, one body and one key bar. The stacked
  status rows, the second key bar and seven kinds of overlay are gone, so a
  recording shows more than twice as many lines of transcript.
- Naming a speaker keeps the notes and chat, and carries the name into them.
  It used to wipe them. Esc goes back and only Q quits.
- A meeting opens on Notes, which now holds Analysis too: decisions and actions
  first, then your template. Times replace quoted sources; Chat still cites.
- Search shows how many meetings matched and opens at the match.
- `R` lists speakers with something each one said, then asks for a name.
- An unreadable browser window no longer warns that meeting detection is paused
  while no call is running. That warning was false: detection from microphone
  use never stopped. Losing Accessibility access still warns.
- The app no longer reads the calendar itself when the background recorder is
  doing it, which was the source of a green "Calendar did not respond".
- `bun run journeys` renders every journey from the real app with made-up data.

## Unreleased — try Nemotron 3 on your own calls

- FluidAudio 0.18.0. Its speaker code is now an opt-in package trait, so the
  helper names the `Diarizer` trait; the old `traits: []` would have removed it.
- `seashell-speakers --engine nemotron3` runs NVIDIA's Nemotron 3 (190 MB, eight
  voices per channel). When all eight slots fill, or a speaker count is given,
  that channel goes back to community-1, which has no cap.
- `seashell speakers compare` runs it on past calls and builds a local page of
  the lines where it disagrees with the saved speaker, with a clip of each to
  listen to. Nothing saved changes, and private meetings are skipped.
- `seashell speakers use nemotron3|community-1` switches new meetings. The
  default stays community-1 until Nemotron 3 proves itself on real calls.

## Unreleased — your meetings in Claude Code and Codex

- `seashell mcp` is a local, read-only MCP server over the meeting library:
  `list_meetings`, `get_meeting` (summary and items with their source
  segments), `get_transcript` (paged, per speaker), `search_transcripts` and
  `list_action_items`. Tool output cites segment IDs and times, e.g.
  `[s000123 12:04]`. It has no dependencies and uses stdio JSON-RPC.
- `seashell mcp install` registers it with Claude Code and Codex at user scope,
  using their own `mcp add`, and installs the `seashell-meetings` skill. The
  skill covers when to use meetings, how to cite them, and approval before
  sending follow-ups or filing issues.

## Unreleased — final notes that finish

- Final notes on Claude Code (e.g. Opus) failed for every real meeting: Humain
  capped each call at $0.10 and Claude Code stopped with `error_max_budget_usd`
  (a 36-minute meeting needed about $0.55). Humain now gives each meeting role
  its own budget and time limit; Seashell waits a little longer than Humain for
  each role (live 4 min, final notes 20 min, chat 6 min).
- A failed AI step can be retried. Humain keeps a failed run's directory and
  idempotency claim, so the same request could never run again; retries now
  move to a new attempt, and successful runs are still reused.
- After a background meeting, final notes start right away instead of first
  replaying live analysis over every window (19 sequential calls for a
  36-minute meeting).

## Unreleased — speaker separation on the Apple GPU

- "auto" now uses the Apple GPU (MPS) when CUDA is absent. A real 36-minute
  meeting on an M5 Max: 48 s instead of 14.8 min, ~150× less CPU time and
  1.8 GB instead of 4.2 GB peak memory, with byte-identical speaker turns.
- A GPU failure retries the whole separation on the CPU; unsupported
  operations fall back individually (`PYTORCH_ENABLE_MPS_FALLBACK`).

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
