# Background live transcript acceptance — 2026-09-27

The real local-ASR smoke passed on an Apple M5 Max running macOS 26.6.2.
It used the installed Seashell Whisper server and `ggml-large-v3-turbo-q5_0.bin`
model with the working-tree background live transcript worker.

Run it with an existing installation:

```sh
bun scripts/background-live-transcript-gym.ts --runtime-root "$(brew --prefix seashell)/libexec"
```

This optional gym creates a Samantha voice fixture on disk using macOS `say`,
converts it to mono 16 kHz PCM with FFmpeg, and commits it to an isolated capture
store. It does not open a microphone, play audio, join a meeting, call a cloud
provider, or change a service, permission, or saved ASR profile.

## Observed results

The fixture says: “The next meeting is on Tuesday. Please test the microphone
and computer audio.” The actual local server recovered that phrase in a saved
live transcript **before the worker closed**.

| Check | Observed result |
| --- | --- |
| Generated speech length | 4.401 seconds |
| Live text saved after enqueue | 1.434 seconds |
| Second real request length | 22.003 seconds |
| Second request active when close began | Yes |
| Worker close duration | 54 ms |
| Local inference requests | 2 |
| Owned Whisper processes remaining | 0 |
| Durable audio bytes changed | No |
| Canonical replacement overwritten after close | No |
| Cleanup errors | None |

The worker closed its server during the second request. A controlled canonical
record then replaced the live draft. The gym waited for the real outstanding
requests, attempted another enqueue on the closed worker, and observed the
canonical file unchanged after another 1.5 seconds. Generated audio and the
isolated library were removed on success. JSON receipts, status transitions,
and the two nonprivate transcript snapshots remain under
`.gym-results/background-live-transcript/run-QhtmQf/` on the test machine.

An earlier smoke also passed live persistence, pending-publication cancellation,
and process cleanup, with live text saved in 3.026 seconds. Its short warm
second request finished before shutdown, so the gym was strengthened with the
longer second fixture before the final run. These are observed acceptance-run
latencies, not a latency benchmark or a promise for other hardware.

## Limits

The installed server/model are real, and the worker, scheduler, durable chunk
commits, transcript library writes, cancellation, and child-process cleanup are
real. The input is synthesized speech and the canonical replacement is a
controlled sentinel; this does not run another canonical batch transcription.
The sentinel checks that stopped live work cannot overwrite a final result.

This is not proof of physical microphone/system-audio capture, multi-speaker
accuracy, live Meet naming, permission onboarding, slow-machine responsiveness,
or hours-long stability. Those require their own acceptance runs. The separate
worker regression tests cover a provider that ignores cancellation and resolves
after close has returned.
