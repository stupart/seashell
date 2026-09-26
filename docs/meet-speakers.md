# Google Meet speaker names (experimental)

Seashell's native macOS Accessibility reader inspects meeting controls,
participant names, and speaking indicators exposed by Google Meet. It adds a
lightweight naming route without a browser extension, developer settings,
Hugging Face account, model download, meeting bot, or Seashell login.

Start with **Google Meet in Google Chrome**. Accessibility is an interface used
across macOS apps, but each meeting app still needs a tested adapter. Safari
compatibility is not yet verified; its CLI override remains available for
diagnostics. This implementation is experimental, and automated tests do not
certify a real call's speaker accuracy or every current Meet layout.

## Connect once

In Seashell press **V**, then **Connect Google Meet · Accessibility**.
Alternatively run:

```sh
seashell meeting speakers setup
```

This enables automatic browser selection and explicitly requests macOS
Accessibility access for **both this window and the background meeting host**.
If access is missing, Seashell opens **System Settings → Privacy & Security →
Accessibility**. Enable the entries shown by macOS, return to Seashell, and
choose **Check Meet connection**. Choosing **Connect Google Meet** again also
opens setup to repair missing access.

The permission owner can differ between a terminal session and a background
host. **Terminal access alone does not enable background meeting detection.**
The explicit connection check verifies both scopes without prompting and tells
you which scope still needs access. It uses a temporary background check; it
does not start recording or change launch-at-login settings. Seashell cannot
approve its own macOS permission. A packaged app will need a stable app identity
for polished one-time onboarding.

Normal launch, background polling, and **Check Meet connection** never request
permission or open System Settings. The CLI `auto`, `chrome`, and `safari`
commands save a browser preference and perform a read-only permission check;
only `setup` requests permission. No JavaScript-from-Apple-Events setting or
browser Automation permission is required by this reader.

Accessibility is a broad macOS permission. Seashell uses it to inspect meeting
interface evidence while watching for meetings, recording, or checking the
connection. It does not click meeting controls or record screenshots. It does
not invoke a vision model or upload screen contents. Display names become part
of the saved transcript and may therefore be sent through your configured AI
provider when you use meeting analysis.

## Check before a meeting

Join a call in Chrome and keep participant tiles visible. **When your Meet
microphone is unmuted, open Meet's People / Participants panel and leave it
open.** The current adapter needs the panel's self marker to distinguish your
tile from remote speakers. With your Meet microphone muted, naming can proceed
without that panel. If neither condition is met, naming pauses safely while
audio recording continues. Then run:

```sh
seashell meeting speakers check
```

In the app, **V → Check Meet connection** does the same thing. A connection with
a participant count means the roster is readable; it does **not** prove speaking
detection works. While somebody remote speaks, look for **Meet hint: their name**
in the live footer. With two remote participants, take turns speaking, then
check the saved transcript after finishing. Also test overlap, muting, screen
sharing, hidden/restored tiles, a background tab, a minimized window, and
consecutive calls. Stop or pause Seashell normally so the final pass can process
all saved audio. A layout that exposes names but no active-speaker evidence must
retain source or anonymous labels.

Live draft chunks spanning a speaker change retain source labels. Final local
ASR uses smaller timestamped units, so it can assign more names than the draft.
Microphone audio remains separately labeled **Microphone**, including when Meet
mutes your microphone. Seashell's microphone capture is independent of Meet's
mute.

Turn this integration off with **V → Turn off Meet reader** or
`seashell meeting speakers off`. Recording can continue without participant
names. CLI configuration changes take effect after reopening the app/background
watcher; wait until recording has finished before restarting it. Revoke access
in **System Settings → Privacy & Security → Accessibility** if desired.

## What the names mean

These are **timing hints**, not verified identities or separate audio tracks.
Seashell still receives mixed computer audio. Avoid music, videos, or another
call playing at the same time. Meet UI updates can lag, so quick transitions can
be wrong even when the name appears right. Review consequential attribution.
People sharing a room microphone cannot be reliably separated by that device's
display name.

The adapter samples every 500 ms after the previous read completes. A segment
is named only when at least 90% of its time is covered by adjacent observations
of the same participant. It never fills a gap over 1.75 seconds. Multiple active
remote speakers, unnamed activity, missing tiles, read failures, slow reads,
and transitions remain source/anonymous labels. It refuses ambiguous joined
meetings and pins one browser and meeting code per recording. If another running
browser cannot be checked, naming pauses rather than assuming it has no call.
Closed or uninstalled browsers are ignored without launching them.

The optional `capture/meet-speakers.jsonl` sidecar is saved with the audio bundle.
It uses the audio session's time origin, persists pause boundaries, and survives
finalization/recovery. Memory holds at most 600 recent samples; the sidecar is
capped at 16 MiB / 100,000 observations. On corruption or a limit, names become
unavailable while audio recording/finalization continues. New native hints use
`speakerSource: "google-meet-accessibility"`; older `google-meet-dom` evidence
remains readable. The record's `speakerAnalysis` identifies the result as
`platform-hints`.

Meet's Accessibility tree is not a stable speaker API. Browser, language, and
layout changes can require adapter updates. The reader must see explicit
speaking evidence; it does not infer speech from a participant's presence or
invent a name for an unknown voice.

For other meeting apps or unreadable tiles, optional local voice separation
remains available through **V**. It separates anonymous remote voices after
recording and does not invent names. It is a separate setup from Accessibility.
Meet's official Media API has a different access/authorization model and is not
used by this adapter.

## Automatic call boundaries

Connecting the reader also supplies automatic meeting mode with a joined-call
signal when the accessible meeting controls identify an active call. A muted
Meet can still start capture; prejoin previews must not. Meeting IDs distinguish
consecutive rooms in the same browser. A confirmed departure stops at the next
poll; permission errors and ambiguous interfaces use the configured end grace
before stopping. Other meeting apps continue to use process-audio detection.

Enable persistent background capture with `seashell meeting autostart enable`.
It records without live inference, publishes one History entry per call at
capture start, and prepares the transcript after departure while watching for
the next meeting. This requires the Mac to be awake and the login service
active. Grant Accessibility from explicit speaker setup before relying on
automatic boundaries; the background service will not interrupt you with
permission dialogs. Real-call, background-tab, and minimized-window behavior
still require validation on each supported browser.
