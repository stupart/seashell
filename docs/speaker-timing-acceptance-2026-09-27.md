# Speaker timing acceptance, 2026-09-27

A new local inference test found a production timestamp defect in RC15. Whisper
recognized the words, but the canonical transcription path combined original
segment timestamps with VAD-compressed token and DTW timestamps. A final
four-second sentence collapsed to a one-millisecond cue. That prevented useful
speaker attribution and also affected transcript navigation and subtitle timing.

The test uses three generated remote turns (Samantha / Daniel / Samantha), a
separate overlapping local voice (Karen), authored turn intervals, and scripted
Meet observations. It runs actual local Whisper, saves the capture through the
production finalizer, reloads the saved transcript, and evaluates that output.
It never opens an audio input, plays sound, joins a meeting, or contacts a model
provider. Scripted observations do **not** establish live Meet accuracy.

## Fix and evidence

The canonical word-timestamp path now runs DTW on original audio without
Whisper's internal VAD. Live draft VAD is unchanged. This can increase final-pass
work for recordings with long silence; timing correctness takes priority here.
The parser also rejects inconsistent token clocks in favor of complete segment
text and ignores punctuation-only DTW anchors that extend words into silence.

The same mixed-clock behavior is documented in the upstream
[Whisper issue #4046](https://github.com/ggml-org/whisper.cpp/issues/4046) and the
[pinned CLI JSON writer](https://github.com/ggml-org/whisper.cpp/blob/927cfce34f31707e17f2bff35c349632fb9e2c3a/examples/cli/cli.cpp).
A sanitized actual failing JSON output is retained as a regression fixture.

On this Apple Silicon Mac, using the installed large-v3-turbo-q5_0 model:

| Local generated-speech case | Reference time covered by transcript | Correct names among transcribed remote reference time | Wrong named seconds |
| --- | ---: | ---: | ---: |
| RC15, short pauses | 37.4% | 88.6% | 0 |
| Fixed, short pauses | 93.4% | 89.5% | 0 |
| Fixed, 15-second pauses around turns | 94.1% | 92.2% | 0 |

The old result's apparently good naming rate hid a missing final turn's timing.
The evaluator therefore reports missing transcription, unknown names, wrong
names, and named coverage separately. The short-pauses RC15 run failed its
independent lexical check: Friday was not saved under Alice. Both fixed cases
recover the expected utterance markers under Alice, Bob, and Microphone. Unknown
names near turn boundaries are retained rather than filled in.

These duration metrics include synthesized utterance envelopes, which contain
some silence. They are not word error rate, diarization error rate, or a
real-human attribution accuracy claim. A small reported wrong-channel duration
can reflect ASR boundary error; lexical markers independently check simultaneous
local/remote source assignment. See the evaluator's documented limits.

## Reproduce

With local inference assets installed in the source checkout:

```sh
bun scripts/gym-speaker-asr.ts
bun scripts/gym-speaker-asr.ts --long-pauses
```

To exercise a trusted installed Seashell package's actual transcription adapter:

```sh
bun scripts/gym-speaker-asr.ts --runtime-root "$(brew --prefix seashell)/libexec"
```

The default local CI includes a fast deterministic speaker replay gym. Actual
inference is opt-in via these commands or `bun run gym -- --asr`; it needs
FFmpeg, the named macOS voices, the Whisper binary, and the local model. Child
process groups have deadlines and cancellation cleanup. Success deletes generated
audio/captures; private metrics, reference text and the saved transcript remain
under `.gym-results/speaker-asr/`. Failed synthetic media is retained for diagnosis.

## Live self identity remains unresolved

A fresh solo Chrome Meet inspection checked normal/hovered tiles, accessible
custom content, and linked elements. It exposed no verified local-self identity
outside the Participants list. No heuristic based on display name or layout was
added. The current People-panel requirement remains for unmuted microphones.
The test room/window was closed, and the temporarily stopped idle background
watcher was restored. Both foreground and background permission checks passed.
