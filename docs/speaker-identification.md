# Local speaker separation

Updated 24 September 2026. Implementation in the real-speakers change; RC10
predates this feature's setup UI. See the PR/local CI receipt for release status.

## Plan and implemented workflow

1. **Capture reliably.** RC10 fixes quiet microphone speech being skipped, adds
   quiet/stall warnings and bounded capture retries. Local regression tests pass;
   another physical meeting is still needed to confirm the reported device case.
2. **Verify once.** Press **V** in Seashell, or run `seashell setup --speakers`.
   A per-user Python environment survives app upgrades. Setup loads the real
   model and writes a readiness receipt; empty cache folders do not count.
3. **Separate after recording.** When verified, normal local capture finalization
   runs the model on computer audio. Whisper words are aligned with voice turns;
   source-separated microphone text retains its own clock and ID. Live text keeps
   source labels until finalization. Speaker failure falls back to source text
   with a saved explanation, never silently losing the meeting.
4. **Review and name.** Use **[ / ]** to select a speaker and **R** to rename it.
   Numbers denote anonymous voice clusters, not verified people.
5. **Retry old recordings.** Open a saved recording, press **V**, and choose
   **Identify saved recording**. Or run `seashell library speakers <id> identify`.
   This creates a separate review copy using retained capture or original media.
   Corrected text, names, notes and raw audio in the original remain untouched.
   The copy has new evidence IDs and no copied/stale AI analysis. Raw capture
   remains with the original; select the original when rerunning separation.

Setup does not require Humain. It downloads optional dependencies and model
weights; no meeting audio leaves the computer. Heavy setup/reprocessing from the
TUI is disabled while recording. Escape cancels setup and drains its child.
A concurrent setup is rejected rather than modifying the same environment twice.

The publisher requires personal acceptance of the
[Community-1 access conditions](https://huggingface.co/pyannote/speaker-diarization-community-1),
including contact sharing. Sea Shell does not accept those conditions for users.

```bash
# After accepting access in the browser, sign in securely in your terminal:
seashell setup --speakers --login
# Subsequent verification uses the cache, without network access:
seashell setup --speakers --check --json
```

Authentication is delegated to Hugging Face; Sea Shell does not store tokens.
Execution disables Hugging Face network requests and pyannote metrics. Missing
or modified cached files invalidate readiness; runtime failures are still handled
because a receipt attests a previous check, not an infallible installation.
`doctor`, capability discovery, execution, and automatic finalization share the
same Python discovery. Custom Python/model/cache overrides remain supported.

## Validation status

The product pipeline tests use fixture model outputs to exercise source identity,
fallback, unknown labels, cancellation, review-copy preservation and the real
Ink UI at wide/narrow widths. These do **not** establish voice-clustering accuracy.
The real dependency import and offline check run separately. On this Mac the
model is not cached and Hugging Face sign-in remains outstanding; the public
video model-quality run therefore remains pending. No accuracy claim is made.

## Repeatable public-video gym

The fixture is the AMI Consortium's ES2002a meeting, 180–360 seconds, with four
participants. The gym combines the public corner-camera video and matching
headset-mix audio into a MOV with lossless PCM audio, then extracts that exact
audio for model scoring. It clips the published human utterance segments into
the same time range and retains overlaps. Source URLs, SHA-256 checksums,
license attribution, and transformation details are saved in `reference.json`.
AMI signals and transcription are [CC BY 4.0](https://groups.inf.ed.ac.uk/ami/download/).

Prepare without model access:

```bash
python3 scripts/gym-diarization.py --cache-dir /tmp/seashell-speaker-gym
```

After speaker setup, run from a source installation with built Whisper/models:

```bash
"$HOME/Library/Application Support/Sea Shell/diarization-venv/bin/python" \
  scripts/gym-diarization.py --cache-dir /tmp/seashell-speaker-gym --run

# A separate run with the true speaker count, to diagnose clustering errors:
"$HOME/Library/Application Support/Sea Shell/diarization-venv/bin/python" \
  scripts/gym-diarization.py --cache-dir /tmp/seashell-speaker-gym --run --num-speakers 4
```

The model stage exercises production `scripts/diarize.py`. The video stage
exercises the actual CLI, video preparation, Whisper timestamps, and speaker
merge with an isolated config/library and `--no-save`. Each run retains raw
turns, a transcript, logs, timings, and a JSON report. A failed model or empty
transcript makes the command fail; preparation alone never reports quality.

Scores include optimal speaker-label mapping, detected speaker count, and DER
with two settings: a 250 ms collar excluding overlap, and no collar including
overlap. Lower is better. Utterance annotations include pauses; this is not the
official AMI benchmark protocol. The production model selects exclusive turns,
so the strict score also exposes its inability to represent overlapping voices.
This development clip is not held out from model development. A headset mix is
easier than laptop speakers, and video lip synchronization has not been
independently checked. This establishes a repeatable integration test, not a
general accuracy claim or a memory-leak/long-meeting soak result.

At preparation time: all source checksums passed, the video contains a video
stream and 16 kHz mono PCM audio, all four annotated speakers are represented,
and Python/pyannote imports succeeded. The real model and quality scores are
pending the user's model-access acceptance and local login. No private meeting
audio was used or uploaded.

Next fixtures should cover a held-out meeting, far-field audio, overlap,
silence/music, short turns, source-separated local/remote tracks, and repeated
long runs with process/RSS sampling. Store regressions as reports with model,
device, configuration, and fixture hashes; never substitute mocked diarization
for a model-quality pass.

## Boundaries and next stages

Seashell owns audio capture, local diarization, transcript IDs, corrections,
setup, and privacy controls. Humain consumes the resulting labeled transcript
for notes and analysis; an LLM does not invent identities from the sound of a voice.
No provider subscription, app login, or transcript upload is needed for this local path.
The model publisher separately requires Hugging Face model-access acceptance
and local authentication for the first download.

This release separates the computer-audio track after capture and retains
microphone as a distinct **source**, not a verified person. Several people near
one microphone are not separated by the meeting capture path. Imported mixed
recordings use local clustering across the complete file. Speaker numbers are
recording-local: they must not be treated as identities across meetings. Overlap,
short turns, echo and similar voices can cause incorrect attribution.

Next stages, after measuring the local baseline:

1. Authoritative meeting-platform evidence: import authorized, timestamped
   Google Meet transcript/participant associations, retaining provenance and
   unknown/conflicting identities. Calendar attendee lists alone cannot assign
   a voice. No Meet, Zoom or Teams participant connector exists in this release.
2. Explicit shared-room mode for microphone clustering; headset/near-end mode
   remains a separate source. Avoid labeling a shared microphone as “you.”
3. Additional held-out, far-field and overlapping-speech fixtures, long-call
   resource measurements, and rename/identity correction propagation to notes.
4. Only then evaluate live provisional clusters with final reconciliation. The
   current after-meeting pass avoids competing with live capture/Whisper.

Mac onboarding cards can reuse the same setup service and readiness receipt.
The TUI is the implemented interface; a native Mac onboarding flow is not added here.
