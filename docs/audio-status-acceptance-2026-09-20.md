# Audio status and meeting coexistence — 20 September 2026

The startup row exposed an internal “safe chunks” counter and kept saying
“System opening…” after the native helper had opened successfully but supplied
no audio yet. It now shows `Microphone` and `Computer audio`, with starting,
ready, and receiving-audio states. The top-level status is simply `Recording`.
Raw audio durability is unchanged; only its UI counter and redundant React
updates were removed. The empty transcript describes the initial wait without
requiring users to understand chunking.

The system helper's `start` event now emits `ready`. `first-buffer` still
establishes the capture clock and emits `active`. Duplicate startup events are
idempotent, and a startup event arriving after the first buffer cannot downgrade
the active state. Ready does not establish that speech or even PCM arrived.

## Verification

- 179 Bun tests and 3 Python tests passed, including two new real child-process
  regressions for readiness without PCM and startup/first-buffer ordering.
- Typechecking and the capture/storage/meeting gym passed. Its 100 meeting
  cycles verified 400 chunks from 200 children, with zero remaining children
  or signal listeners. Retained heap grew 991,732 bytes and RSS 32,686,080 bytes
  between cycles 10 and 100. These are synthetic detector/ASR boundaries with
  real child streams, storage, and finalization, not a long physical call.
- Actual Ink terminal runs at 100×28 and 48×24 showed startup, quiet readiness,
  and both audio meters using controlled silent sources. A stalled microphone
  at 48×24 retained the full permission/input recovery instructions. No test
  captured the user's microphone or changed the user's configuration.

Gym evidence: `.gym-results/2026-09-20T06-59-37.015Z-29050/report.md`.
Terminal evidence: `/var/folders/hj/cg29fnq929v27cj88gsnrskr0000gn/T/seashell-audio-status-l6a1w607/`.

## Installed preview

Homebrew RC5 pins `c446d69be3afcd5aa3f43736672fdc48abfedc3f`. The local RC4→RC5
upgrade succeeded, and hashes of the installed UI and capture module match the
tested source. The packaged TUI opened and exited with capture disabled and an
isolated library. Formula tests (including actual known-phrase transcription),
linkage, strict audit, and style passed. The existing user-owned RC4 window was
left running; quitting and reopening `seashell` selects RC5.

[Source CI passed](https://github.com/stupart/seashell/actions/runs/35495817804).
[Fresh Apple Silicon and Intel installation CI](https://github.com/stupart/homebrew-tap/actions/runs/35495853970)
is tracked separately. Update, 21 September: both PRs are now merged:
[source #14](https://github.com/stupart/seashell/pull/14) and
[formula #1](https://github.com/stupart/homebrew-tap/pull/1).

## Real Meet test and Conch

The requested app is Google Meet. The browser/native computer-control connection
was unavailable (`Sky Computer Use native pipe startup failed`), so no meeting
was opened by automation. The user was asked to join a solo call. No browser
microphone activity had been observed when this report was written; the live
Meet acceptance test was pending at this RC5 checkpoint. The subsequent real
test, its findings, and RC6 fixes are recorded in
[Google Meet acceptance](google-meet-acceptance-2026-09-20.md).

Read-only checks showed launch at login disabled, an existing TUI owning the
watcher, and Conch's `meeting-autopause` setting already enabled. No settings
were changed. Inspection confirmed separate Whisper workers, optional reuse of
on-disk weights, and microphone-activity-based pausing rather than a shared
meeting state. README documents these limits and the solo-call acceptance
steps. Shared ASR is a possible future feature, not part of this patch.
