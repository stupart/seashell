# Native meeting observation

Seashell's meeting reader uses the macOS Accessibility API. The first adapter
targets Google Meet in Chrome. It removes the browser extension and JavaScript
from Apple Events setup requirements; it does not make every meeting interface
equally readable. Chrome call-state and remote speaker signals were verified in
a real test on 2026-09-26. Safari speaker names remain unavailable and unverified.

## Scope and boundaries

The implementation has three separate responsibilities:

1. Native audio capture records microphone and system channels durably.
2. A local observer reads meeting state and timestamped speaker hints through
   Accessibility. These hints can improve names and meeting boundaries without
   becoming a dependency of audio capture.
3. Humain performs model inference, including transcription, optional voice
   separation, and meeting analysis. It should receive the smallest useful
   evidence package, not unrestricted access to the user's desktop.

This change introduces no screenshot capture, vision model, face recognition, or
screen upload. Those are future options, not requirements for native observation.

Accessibility is a broad macOS permission. Seashell's reader should limit its
inspection to supported meeting surfaces, remain read-only, and report permission
state separately from a missing or temporarily unreadable interface. Apple
documents that permission prompts are asynchronous; prompting does not make the
current permission check succeed. [Apple permission API](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions)

## Evidence, not identity guesses

The Chrome adapter reads `AXDOMClassList` on exposed Meet tiles. A real remote
participant playing prerecorded speech exposed the known changing speaker badges
`Oaajhc`, `HX2H7`, `wEsLMd`, and `OgVli`. The adapter associates them only with a
validated tile and its single name slot. These are undocumented Meet classes,
not a stable platform API; a browser or Meet update can require new fixtures.

Names currently require either the exposed Participants list's `(You)` marker
to identify the local tile, or a muted local Meet microphone so active speaking
tiles can be treated as remote. With the local microphone unmuted and no readable
self marker, capture continues with source labels. Opening Meet's People panel
can expose that marker. Seashell does not change this layout or mute the user.

The meeting adapter should emit a bounded, versioned observation containing the
application/browser, meeting ID, observation time, joined state, visible
participant identifiers/names, and explicit speaking indicators. Its result must
also distinguish confirmed absence from an incomplete read.

Display names and active-speaker indicators are platform hints. They do not
provide separate participant audio tracks or verify a person's identity. Names
must remain unknown when indicators disagree, several people speak together,
stable participant identifiers are unavailable, or the read is too slow. Two
people named Alex must not become one participant. A shared conference-room
device is one endpoint unless other evidence separates the people using it.

Speaker evidence uses the recording's clock and is pinned to one call/browser.
Existing alignment requires matching adjacent observations, at least 90% segment
coverage, and no gap above 1.75 seconds. Read latency above 750 ms invalidates a
live speaker sample. Pause/resume and adapter/source transitions must insert
unknown evidence rather than carrying a name through the gap. These are current
conservative thresholds, not a measured accuracy guarantee.

Chromium exposes accessible web content through a cached tree and notes that
updates can lag the renderer. Visibility also affects tree membership. This is
why a roster alone cannot prove speaker detection, and a missing tree cannot
prove a call ended. [Chromium accessibility architecture](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/accessibility/overview.md)

Google documents a screen-reader command to announce the current speaker. This
establishes that Meet has accessible speaker information, but does not guarantee
any particular passive attribute or selector. Seashell must not repeatedly send
that keyboard command, steal focus, enable captions, or change the user's layout
to manufacture a signal. [Google Meet screen-reader guide](https://support.google.com/meet/answer/15738543?hl=en)

## Automatic boundaries

The lifecycle controller preserves an already recording Meet's identity while
its tree is unavailable and the same browser still has active microphone input.
It applies this to a lost Accessibility permission as well: permission to read
names and permission to capture audio are separate. Names pause; the existing
audio session can continue within its configured maximum duration.

Native `idle` ends a joined call immediately only when `absenceConfirmed` is
true. Incomplete reads, timeouts, background tabs, minimized windows, unsupported
layouts, and traversal limits must not produce confirmed absence. A positively
identified different joined call ends the old session so the next call gets its
own transcript. Unknown state cannot start a new recording on its own.

The browser inventory uses exposed pages and tab metadata. Known hidden Meet
tabs and incomplete reads block naming. A fully readable ordinary page in another
browser does not block names merely because it cannot prove a historical meeting
ended. This bounded inventory cannot rule out a hidden, custom-retitled Meet tab,
and the system audio track still contains mixed computer audio.

If both meeting UI and matching browser input disappear, the normal end grace
still applies. Therefore an all-muted call with an unreadable tree can still end
after that grace. This is an explicit limitation to measure and improve; keeping
an unobservable session alive indefinitely would also record beyond departure.
Ambiguous simultaneous calls use the same grace rather than attributing mixed
audio to one of them. The maximum-duration limit remains active throughout.

An AX messaging failure is not equivalent to permission denial. Helpers need
per-message and whole-read deadlines, traversal/output limits, cancellation, and
bounded memory. Apple provides a messaging timeout and distinguishes an
unresponsive application from disabled access. [Apple timeouts](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout),
[AX error meanings](https://developer.apple.com/documentation/applicationservices/axuielement_h)

## Optional vision through Humain: proposed follow-up

Vision could inspect a small meeting-window crop when an adapter cannot read an
explicit speaking indicator. It should read visible name labels and UI highlights,
not identify people from their faces. A model result is another timestamped hint,
never proof that a speaker is who the model thinks they are.

Before enabling this route:

- Explain capture scope and whether the selected provider receives image data.
  Accessibility permission alone is not permission to upload the desktop.
- Capture only the selected meeting surface while recording. Prefer transient,
  tightly cropped frames; do not save full screenshots as routine telemetry.
- Bind each inference request and response to a meeting/session ID, capture time,
  adapter version, and evidence ID. Reject late results after departure, pause,
  or a call change. Give retries an idempotent request identity.
- Use a budgeted, inexpensive vision route and an event-driven or adaptive sample
  rate. A slow model should reduce coverage, not delay capture or reuse stale
  names. The expensive meeting-summary route must not become the frame reader.
- Restrict output to known roster identifiers plus `unknown`, record evidence
  provenance, and reconcile conflicting hints conservatively. Treat text inside
  screenshots as meeting data, never instructions for tools or exports.

Keep this contract reusable in Humain, while Seashell owns permission UX,
application selection, capture, and lifecycle decisions. This supports future
Zoom, Teams, and other adapters without teaching the inference engine how to
control a particular browser. No universal-support claim should precede testing.

## Acceptance scenarios and release evidence

Unit fixtures and local CI verify contracts and failure behavior. Live runs
establish whether the current meeting UI exposes useful evidence. Record
browser/macOS/app versions alongside each result. The following matrix is the
acceptance target, not a list of completed physical tests.

| Scenario | Required behavior |
| --- | --- |
| Fresh install, no Accessibility permission | Clear setup path; no browser developer setting; recording remains usable. |
| Grant/revoke permission while running | State updates; no repeated prompts; no fabricated names; existing audio obeys lifecycle rules. |
| Prejoin, lobby, joined while muted, departure | No automatic prejoin/lobby capture; joined call starts; confirmed departure ends it. |
| Two consecutive rooms; leave and immediately rejoin | Separate records with capture start times; prior processing does not delay next capture. |
| Background tab/window or minimized browser for longer than end grace | No false confirmed departure; matching browser input keeps one recording; disclose all-muted limitation. |
| Two joined calls, two browsers, unknown second browser | No names attached to ambiguous mixed audio; no silent reassignment to another call. |
| Two remote speakers taking turns | Names align with audio ground truth; roster readability alone is not a pass. |
| Overlap, rapid turns, duplicate names, renamed participant, room device | Prefer unknown over a wrong name; preserve distinct stable IDs where available. |
| Presentation layout, hidden tiles, captions, non-English UI | Unsupported evidence fails closed without losing audio; no global text scan that mistakes chat/captions for speaker state. |
| Slow/hung AX reads, browser crash, node/output limits | Bounded resources; no helper leak; explicit unknown state; capture continues. |
| Pause/resume, sleep, recovery, sidecar corruption | No stale names cross gaps; recovery remains possible without speaker evidence. |
| Long meeting with permission loss or stuck browser input | Maximum duration still stops capture; warnings explain degraded speaker detection. |

Measure false starts, missed starts, start/end latency, accidental session splits
or merges, wrong-name rate, named-speech coverage, speaker-transition timing error,
and CPU/memory over a long call. Evaluate incorrect names and unknown names
separately: improving apparent coverage by guessing is not an improvement.

Evidence obtained on 2026-09-26:

- **Unit and simulated lifecycle tests:** hidden-tree continuity beyond end grace
  with browser audio, confirmed departure, permission loss without remaining
  audio, room transitions, and the maximum-duration bound.
- **Replay tests:** sanitized real Chrome speaking and muted AX trees exercise
  the native parser. Additional synthetic mutations test malformed, ambiguous,
  duplicate-name, and unbound speaker evidence. Replay does not reproduce the
  browser or hardware delivering those observations.
- **Real Chrome probes:** an independent remote participant played prerecorded
  speech; native AX reads exposed its changing speaking badges and name. The
  real joined → leave → prejoin → rejoin → leave sequence was verified. Measured
  probes took approximately 88–95 ms in this setup; this is not a latency bound
  for other meetings or Macs.
- **Harness limitation:** the prototype guest succeeded. A later run through
  the reusable guest harness was rejected by Google, and the harness cleaned up
  its test process correctly. Repeatable guest admission is not yet established.

These results do not establish a complete diarized transcript end to end, a
multi-speaker attribution accuracy score, Safari names, long-call performance,
physical output switching, or loudspeaker echo quality. No vision inference was
implemented or used to obtain the speaker evidence.
