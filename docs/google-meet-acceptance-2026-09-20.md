# Google Meet and live-reader acceptance — 20 September 2026

## Physical meeting result

The existing RC4 terminal detected Chrome's real microphone activity and showed
the expected browser confirmation prompt. Approval started a new meeting. After
the browser released audio input, capture stopped and the journal recorded
`meeting-finished`. The terminal and cheap meeting monitor remained running.

The saved meeting is 620.223 seconds long, with 62 microphone and 62 computer
audio chunks. All 124 stored WAV files passed length and SHA-256 verification
(39,677,256 bytes). The final transcript contains the spoken test sentence
“Seashell meeting test. The next meeting is on Tuesday.” twice. Both file
transcription and a new private warm Whisper worker also recognized that exact
sentence from the captured microphone audio.

The computer track had two audible chunks, but no known remote-speaker phrase
was exercised. Six 11 ms computer-audio overruns were recorded explicitly:
66 ms total. The check proves real browser detection, approved recording,
microphone speech capture, finalization, and durable storage on this Mac. It
does not establish lossless capture, remote participant accuracy, a full-length
call soak, or Humain enrichment (this meeting remains transcript-only).
The recording stays in the user's local library; no audio is committed here.

## Display failure and correction

The user reported that speaking produced no visible words. An early inspection
saw only punctuation, but subsequent inspection found the exact spoken sentence
in the live transcript. The reader remained on its first page as new text was
appended, so early punctuation-only results concealed later speech off-screen.

Live mode now follows the latest text by default. Scrolling back retains the
reader's position while new text arrives. Reaching the bottom or pressing `L`
resumes following. Punctuation-only live results are omitted without altering
the raw audio. The reader measures its actual available height, and compact
meeting controls/tabs and shorter status text leave room for wrapped speech in
a 48×24 terminal. Redundant meeting-created/recording notices are removed.

Two isolated Ink integration cases at 100×28 and 48×24 failed before the fix.
They now verify a complete new sentence, retained browsing position, resuming
at the bottom, the `L` shortcut, and omission of punctuation-only results. They
use real transcript storage with fixture microphone/ASR boundaries and access
no user devices or library. The native/storage/meeting gym passed 183 Bun
tests, 3 Python tests, typechecking, native compilation, accelerated storage,
and 100 meeting lifecycle cycles. Evidence:
`.gym-results/2026-09-20T07-30-39.321Z-37537/report.md`.

The idle-clock bug found during this check is documented separately in
[`idle-capture-clock-2026-09-20.md`](idle-capture-clock-2026-09-20.md).

## Conch coexistence

Read-only inspection found Conch's `meeting-autopause` already enabled. Its
25 microphone-claim/pause-controller tests passed at revision
`c7404819a50f646be920bdb7a6b406b32e6dda2b`, covering debouncing, overlap with
other pause owners, restoration, cancellation, and protection from stale input
injection. These are state-machine tests, not proof of simultaneous physical
capture. No Conch settings or source were changed. Separate Whisper workers
remain separate compute/memory consumers; shared transcription is not enabled.

RC5's fresh installs passed on both
[Apple Silicon and Intel](https://github.com/stupart/homebrew-tap/actions/runs/35495853970).
The full-model formula transcription tests took 4m04s and 9m37s respectively on
hosted runners. Intel remains a performance limitation, despite passing the
correctness check. The newer reader/clock candidate is validated separately.
