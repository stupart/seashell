# Background live transcripts and capture health

Background meetings now publish live transcript drafts to the same library entry
that appears when recording starts. Opening Seashell follows that entry without
starting another microphone recorder. The background watcher keeps recording
when the TUI closes, then stops its draft worker before the final transcription
pass replaces the draft.

Four independent signals explain what is happening:

| Signal | What it establishes | What it does not establish |
|---|---|---|
| Meeting watcher state | Waiting for a meeting, awaiting approval, recording, or stopped | An idle watcher is not a recorder |
| Per-source health | Whether microphone/computer audio is starting, delivering PCM, quiet, reconnecting, unavailable, stopped, or disabled | PCM delivery is not proof of audible or intelligible speech |
| Audio saved through | Latest end time of a successfully committed chunk on either track | Both tracks may not have continuous coverage through that time |
| Draft status | Waiting, transcribing, live, delayed, or stopped | A delayed draft does not mean recording has stopped |

A quiet source may reflect silence, a mute control, or the wrong input. It is a
reason to check when speech is expected, not an inferred permission failure.
Nonquiet signal detection also cannot establish that the intended person's
words were recorded. The final transcript and, when necessary, retained audio
remain the evidence to review.

## Persistence and recovery

Each capture has a private `capture-health.json` sidecar. It records current
source states, last PCM and nonquiet-signal times, and a bounded set of warnings.
There is at most one warning per kind per source: quiet, reconnecting,
unavailable, and no audio. A repeated warning retains the first occurrence and
latest diagnostic; recovery adds a resolved time. This is a compact health
summary, not an attempt-by-attempt log. Microphone retry messages include the
attempt, exit/signal information, and bounded recorder diagnostics.

Health updates persist at most once per second unless the state or warning
changes; stopping forces a final write. No growing health journal is created.
The background entry also retains health and saved-audio progress through
processing, ready, failed, and interrupted states. Stopping does not erase an
earlier warning. Old library entries without health continue to load with
unconfirmed source status.

One unavailable source does not stop a useful surviving source. A microphone
that never supplies PCM releases the startup gate after a bounded timeout so
computer capture can proceed. Capture shutdown fails when there was a capture
error and no committed chunks; otherwise saved chunks remain available for
final transcription and recovery.

The watcher's separate `.background-watch.json` heartbeat distinguishes idle
watching from an approval prompt before any meeting entry exists. Dead or stale
watchers become unavailable rather than appearing to record indefinitely. TUI
approval is scoped to a new token for each suggestion, so an old approval cannot
authorize a later suggestion from the same browser. The existing explicit CLI
approval command remains supported.

When replacing an existing login watcher, macOS can acknowledge its removal
before the service has finished unloading. Seashell retries only that replacement
path's transient bootstrap error, with a ten-second bound. Other setup failures
are reported immediately, and a failed shutdown preserves the previous login
registration. This retry does not change the permanent permission host.

Meeting detection warnings are visible while watching and on the current
background recording. They clear when the reader recovers and do not attach to
an unrelated saved transcript. Observer messages describe detection or naming
failures; they never assert that audio is recording. Audio recording status
continues to come from the capture health and saved-progress signals above.


## Bounded local drafts

Background draft transcription currently uses local Whisper even when the
foreground draft setting is cloud or adaptive. It makes no cloud request and
does not run Humain meeting analysis during capture. Configured final
transcription and post-meeting enrichment retain their separate routing and
consent requirements.

The draft worker starts its own local server lazily after an audible chunk has
been committed. It runs one request at a time with at most four pending jobs;
superseded previews leave their audio untouched. A missing model, inference
failure, or queue pressure produces a delayed status. The final pass processes
the durable capture rather than trusting draft coverage. Draft text is capped
at 10,000 segments and two million characters; reaching that limit stops draft
growth while audio recording continues.

Draft saves replace the provisional text/JSON without accumulating meeting
revision archives. Microphone and computer channels remain distinct. Meet
speaker hints apply only to computer audio and only when existing timing
evidence supports them. A whole draft chunk can span a speaker change, so final
timestamped transcription can produce more precise labels.

Closing the worker immediately blocks late draft writes, cancels pending jobs,
and shuts down only its owned inference process. Canonical finalization begins
after that cleanup, preventing a late draft from overwriting the final record.
Speaker renaming waits until recording and final processing finish, so an
automatic transcript update cannot overwrite a user's correction.

## Automated acceptance

These focused tests use synthetic callbacks, temporary libraries, and injected
transcribers. They do not open an audio device, change permissions, or run paid
models:

```bash
bun test test/capture-health.test.ts test/capture-health-watch.test.ts \
  test/background-meeting-status.test.ts test/durable-live-capture.test.ts \
  test/background-live-transcript.test.ts test/background-watch-status.test.ts \
  test/microphone-health.test.ts test/live-microphone.test.ts
```

Coverage includes silent PCM versus nonquiet signal, retained and recovered
warnings, throttled writes, one-source startup failure, callbacks only after
durable commit, approval token renewal, bounded draft queues, save/inference
failure, echo/source provenance, and late results after close. Injected
microphone children verify startup timeout, retry exhaustion, diagnostics, and
cleanup. These tests establish control flow and persistence, not physical
microphone intelligibility or live Meet speaker accuracy.

Device acceptance still requires a real spoken phrase and remote/computer
speech under the same permission host used for the meeting. Foreground and
background permission identities can differ. Existing audio-route and speaker
acceptance reports document their own measured scope; this implementation does
not turn those earlier checks into a new hardware test.

## Terminal UX acceptance

The actual Ink app was rendered in isolated temporary libraries at 110×32 and
48×32 terminal sizes. Screenshot review covered idle watching, pending approval,
live text with both inputs, microphone failure with surviving computer audio,
and the saved recording retaining that failure. These were injected recording
states, not screenshots of a real meeting or a physical-device acceptance test.
No private meeting transcript was used.

The previous background screen reported an active watcher without a recording
timer, saved-audio progress, or source failure. It also explicitly deferred text
until meeting end. The revised screen separates those states and displays the
live meeting automatically. Pending approval for another call does not relabel
an older transcript; history remains readable while the next call records.

The subprocess TUI flow tests cover approval scoped to the displayed suggestion,
live updates before finalization, microphone warnings, audio-help navigation,
scrolling away from the live edge without being pulled back, resuming with L,
subsequent meetings, history identity, and stale watcher status. Separate
foreground tests cover startup, total input failure, a surviving source, and
late callbacks from old capture handles during rapid pause/resume.

```bash
bun test test/tui-background-history.test.ts test/tui-capture-health.test.ts \
  test/recording-status.test.ts test/automatic-meeting-signal.test.ts
```

Shutdown tests send signals only to isolated test processes and verify capture
flush, draft close, canonical finalization, and watcher exit in that order.
The real local inference smoke and its explicit limits are recorded in
[the background live transcript acceptance report](background-live-transcript-acceptance-2026-09-27.md).

A remaining performance opportunity is avoiding a library-wide record lookup
on each draft save. Queue and draft sizes are bounded, but synchronous library
lookup/render time on very large libraries has not been benchmarked in this
acceptance run.
