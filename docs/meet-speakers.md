# Google Meet speaker names (experimental)

Seashell can read the names and speaking indicators on visible Meet participant
tiles in Google Chrome or Safari on macOS. This adds a lightweight naming route
without a Hugging Face account, a model download, a bot, or a Seashell login.

## Connect once

In Seashell press **V**, then **Connect Google Meet · automatic**.
Alternatively run `seashell meeting speakers auto`, then reopen Seashell.
Seashell finds the call in Chrome or Safari; there is no browser choice to make.
The status shows which browser is connected. Explicit `chrome` and `safari` CLI
overrides remain available for troubleshooting.

Enable **Allow JavaScript from Apple Events** in each browser you use for Meet:

- Chrome: **View → Developer → Allow JavaScript from Apple Events**.
- Safari: **Settings → Advanced → Show features for web developers**, then
  **Develop → Allow JavaScript from Apple Events**.
- If macOS asks, allow your terminal app to control the browser.
  Review this permission in **System Settings → Privacy & Security → Automation**.

This browser setting permits local automation to execute JavaScript in webpages.
Seashell uses it only to read existing Google Meet tabs in running Chrome/Safari,
while recording or when you explicitly check the connection. It does not change
browser security settings itself, click meeting controls, or send page data to a
new service. Display names become part of your transcript and can therefore be
included in AI analysis through your existing configured provider.

## Check before a meeting

Join a call, keep participant tiles visible, and run:

```sh
seashell meeting speakers check
```

In the app, **V → Check Meet connection** does the same thing. A connection showing
a participant count means the roster is readable; it does **not** yet prove that
speaking detection works. While somebody remote speaks, look for **Meet hint:
their name** in the live footer. With two remote participants, take turns speaking,
then check the saved transcript after finishing. Test overlap, a muted participant,
screen sharing, and hiding/restoring tiles too. Stop or pause Seashell normally so
its final pass can process all saved audio.

Live draft chunks spanning a speaker change retain source labels. Final local ASR
uses smaller timestamped units, so it can assign more names than the draft.
Microphone audio remains separately labeled **Microphone**, including when Meet
mutes your microphone. Seashell's microphone capture is independent of Meet's mute.

Turn this integration off with **V → Turn off Meet reader** or
`seashell meeting speakers off`. The CLI change takes effect after reopening the
app/background watcher. Browser permission can also be revoked in the browser.

## What the names mean

These are **timing hints**, not verified identities or separate audio tracks.
Seashell still receives mixed computer audio. Avoid music, videos, or another call
playing at the same time. Meet UI updates can lag, so quick transitions can be
wrong even when the name appears right. Review consequential speaker attribution.

The adapter samples every 500 ms after the previous read completes. A segment is
named only when at least 90% of its time is covered by adjacent observations of
the same participant. It never fills a gap over 1.75 seconds. Multiple active remote
speakers, unnamed active tiles, missing tiles, read failures, slow reads, and
transitions remain source/anonymous labels. It refuses multiple joined Meet tabs,
including calls in both browsers, and pins one browser and meeting code per
recording. If a second running browser cannot be checked, names pause rather than
assuming it has no call; follow its permission guidance or close that browser.
Closed or uninstalled browsers are ignored without launching them.
Start a new recording for a new call or when moving the call to another browser.
Two people with the same display name still have distinct participant IDs.

The optional `capture/meet-speakers.jsonl` sidecar is saved with the audio bundle.
It uses the audio session's time origin, persists pause boundaries, and survives
finalization/recovery. Memory holds at most 600 recent samples; the sidecar is
capped at 16 MiB / 100,000 observations. On corruption or a limit, names become
unavailable while audio recording/finalization continues. New transcript segments
carry `speakerSource: "google-meet-dom"`; the record's `speakerAnalysis` identifies
the result as `platform-hints`.

The browser DOM is not a stable Google API. The initial adapter uses structural
participant/self markers and known speaking classes documented in
[Vexa's Meet reader](https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/gmeet-capture/src/gmeet-speakers.ts).
It does not guess new CSS classes when indicators disappear. Browser/layout
changes can require an adapter update. Automated tests cover the evidence and
audio integration; they cannot certify Google's current rendered layout or a
physical meeting's attribution accuracy.

For other meeting apps or hidden/unreadable tiles, optional local voice separation
remains available through **V**. It separates anonymous remote voices after
recording; it does not invent names. Meet's official Media API has a different
access/authorization model and is not used by this adapter.
