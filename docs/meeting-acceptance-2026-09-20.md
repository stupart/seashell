# Meeting capture and terminal acceptance — 20 September 2026

This round addresses the reported silent microphone, redundant idle labels,
unclear display shortcuts, and missing transcript/resource checks.

## Reproductions and fixes

- **Audio startup race on a physical Mac.** The installed RC3 capture check twice
  received zero microphone and system chunks. Microphone-only capture worked.
  Starting system capture after the microphone delivered its first PCM kept
  microphone capture working. All three callers now use that startup order,
  with a bounded fallback when the microphone cannot open. The corrected
  eight-second physical check captured eight microphone and five system chunks,
  with audible signal on both tracks. Its temporary audio was discarded.
- **Incomplete transcript on quit.** A known 11.434-second input saved only its
  draft through 10.016 seconds, omitting the final sentence, despite retaining
  both raw chunks. Quit and new-session now finalize the durable audio before
  publishing. The same input after the fix includes the closing sentence and
  aligned speech through 11.22 seconds. Failed finalization leaves recoverable
  audio and does not label a partial result complete.
- **Scheduler shutdown leak.** An inference provider that ignored cancellation
  left `drain()` polling forever after `stop()` returned. A child-process
  regression required SIGKILL before the fix; afterward it exits naturally in
  about two seconds. Stop polling is bounded, and terminal completion uses it.
- **Partial startup ownership.** If the optional system helper throws during
  launch, the microphone remains reachable and stops normally, flushing its
  final chunk.

## Terminal behavior

The normal idle screen no longer repeats “Watching for meetings” and “Waiting
for meeting audio.” Space remains labelled **Record now**. Active capture,
observer ownership, processing, and errors retain their status.

`T` toggles timestamps; `S` toggles speaker labels. Both shortcuts are named
explicitly beside a visible transcript. An actual terminal check verified each
toggle and their combined plain-text view.

An input is shown as opening until it actually supplies PCM. If microphone
startup supplies no audio after eight seconds, instructions point to macOS
Microphone permission and Sound input selection. Messages wrap instead of
truncating. Checks at 100×28 and 48×24 verified the transcript and the complete
recovery message. Active empty capture explains its ten-second audio chunks.

## Repeatable gym

```sh
bun run gym -- --native --capture-soak --meeting-soak --asr \
  --humain /absolute/path/to/Humain/dist/cli.js
```

The meeting exercise runs 100 detection/capture/stop/finalization cycles using
200 real child streams, real WAV storage, and fixture detector/ASR boundaries.
It requires all 400 chunks, complete timing for both tracks, saved meeting
artifacts, zero remaining children, and unchanged signal-listener counts.
It records forced-GC retained heap and RSS after warmup, with coarse growth
budgets of 16 MiB and 128 MiB. CI now runs this exercise on each PR.

The first 100-cycle run passed in 19.8 seconds: retained heap grew 954,203 bytes
and RSS 24,461,312 bytes between cycles 10 and 100. These limits detect large
regressions; they do not prove the absence of every memory leak.

After the quit/finalization fix, the complete gym passed again: **177 Bun tests,
3 Python tests, and all 11 gym checks**. Its 100-cycle run took 20.1 seconds,
with 201,701 bytes of retained-heap growth and 38,338,560 bytes of RSS growth.
Evidence: `.gym-results/2026-09-19T16-07-13.933Z-1733/report.md` and its adjacent
logs/metrics. Working changes were tested before the runtime commit.

The storage exercise separately passed 90 minutes of accelerated capture time,
1,079 chunks, torn-journal recovery, and 1,080 timeline samples including an
intentional gap. Actual batch and warm Whisper inference, Humain contracts,
and local Seashell transcription through Humain passed. A terminal run also
showed real Whisper live output from a synthetic microphone stream.

## Limits

Physical testing used macOS 26.6.2 on Apple Silicon, MacBook Pro microphone,
and AirPods Max USB output. The startup result applies to this tested device
configuration; permission denial and alternate devices still need acceptance.
The repeated-meeting run uses synthetic detection and transcription, and the
storage clock is accelerated. Neither is a 60–90 minute elapsed physical call,
a speech-accuracy evaluation, or a cloud-provider test. Intel first-run ASR
latency remains a separate distribution concern.

Changes are a reviewable PR candidate; publishing the formula/main branch is
separate from installing a local preview.
