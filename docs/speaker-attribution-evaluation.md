# Speaker attribution evaluation

Run the deterministic replay gym locally:

```sh
bun scripts/gym-speaker-attribution.ts --rounds 3
```

It writes `results.json` and `report.md` in a private directory under `.gym-results/`. Use `--output <directory>` to select a report directory. The exit code is nonzero if a case fails. Runs accept one to ten rounds. Generated WAVs, capture bundles and transcript libraries live in a private temporary directory and are removed on completion, failure or handled cancellation. The runner creates no children, opens no audio devices, reads no browser content and calls no models or services.

The PCM is a synthetic tone used only to exercise durable capture. Authored ASR units and saved Meet observations are replayed through the production finalizer. The scorer reads the saved `transcript.json`, rather than an intermediate in-memory result. The gym verifies the attached capture manifest, hashes of committed chunks, retained observation sidecar, completed status and unique transcript evidence IDs.

These are **synthetic replay results, not measured live Meet accuracy**. There are three different evidence levels:

| Check | What it establishes | What it does not establish |
| --- | --- | --- |
| Evaluator unit tests | Independent scoring arithmetic; wrong, unknown and missing speech stay distinct; erroneous output fails | Capture or recognition quality |
| Persisted replay gym | Authored observations and ASR timing survive assembly, finalization, naming, saving and reloading safely | Actual browser markers, acoustic separation or ASR accuracy |
| Optional local ASR gym (`scripts/gym-speaker-asr.ts`) | Generated speech passes through a real local recognizer, timing and the saved capture pipeline | Live Accessibility accuracy, real conversational overlap or hardware routing |

Live Meet testing needs independent ground truth from consenting participants: who actually spoke and when, simultaneous speech, the local microphone and deliberately hidden/unreadable tiles. Keep those results separate from this replay report. A successful live active-speaker badge observation is useful evidence for the native adapter, but is not an end-to-end diarized transcript benchmark.

## Independent ground truth and metrics

`src/speaker-evaluation.ts` accepts authored reference turns and a saved transcript. It has no dependency on the Meet reader, participant hashing, polling interval or its alignment thresholds. Reference turns contain a time range, source channel and expected display names. One remote name means unambiguous speech; multiple names represent simultaneous speech; an empty list means a name should not be asserted. Ground truth records the person actually speaking even when the simulated UI marker is missing.

Turns cannot overlap within a source channel; represent an overlapping remote interval once with both names. Microphone and system turns may overlap each other. Durations use a union of predicted intervals, so duplicate segments cannot improve the score. A conflicting incorrect name makes that interval wrong. Silence outside authored turns is excluded. This is display-name attribution scoring, not biometric identity verification or the conventional diarization error rate. Two different people with the same display name cannot be distinguished by this metric.

| Metric | Definition |
| --- | --- |
| Correct name seconds | Transcribed, unambiguous remote reference time with the expected saved display name |
| Wrong name seconds | Transcribed, unambiguous remote time carrying an incorrect or unresolved asserted name |
| Unknown name seconds | Transcribed, unambiguous remote time with only an anonymous/source label |
| Missing seconds | Reference time with no nonempty transcript on the expected channel |
| Unsafe name seconds | An asserted single name during reference overlap or explicitly unattributable speech |
| Named coverage | Correct name seconds / all unambiguous remote reference seconds |
| Transcribed named coverage | Correct name seconds / transcribed unambiguous remote reference seconds |
| Wrong-name rate | (Wrong + unsafe named seconds) / (Correct + wrong + unsafe named seconds) |
| Transcript coverage | Transcribed reference seconds / all reference seconds |
| Provenance violation seconds | Names lack the expected evidence source, or a local/anonymous segment incorrectly claims a Meet name source |

A zero denominator produces `null`, displayed as `n/a`. In particular, naming nobody does **not** establish a zero wrong-name rate. Healthy cases require full named coverage as well as zero wrong-name time. Cases with known missing evidence require unknown labels and retain all words; those abstentions reduce coverage instead of being counted as successful names.

`LOCAL` identifies the microphone; `SYSTEM` and `REMOTE_*` are source/anonymous remote labels. Other speaker IDs assert names through the saved speaker table. The evaluator defaults to Accessibility provenance; legacy DOM cases explicitly select DOM provenance.

Saved segments encode source in their speaker ID. Timing alone cannot detect a source swap during simultaneous local and remote speech. `wrongSourceSeconds` detects an output channel active during a reference interval when no reference speech exists on that output channel. The overlapping-source fixture additionally checks independently authored lexical markers against the expected channel; the optional real-ASR gym must do the same. This is not a substitute for future explicit capture-track provenance on segments.

## Replay acceptance cases

| Case | Expected behavior |
| --- | --- |
| Two remote speakers | Every authored single-speaker turn keeps the correct name |
| Remote overlap | Overlapping words stay source-labelled; later unambiguous speech is named |
| Missing markers | Preserve words, leave the unobservable turn unnamed, resume names after evidence returns |
| Read outage | Do not carry a matching name across a multi-second evidence gap |
| Name change | Retain old/new display names on their own turns; leave a crossing utterance unnamed |
| Stable ID rename | Historical evidence must not retroactively rewrite earlier display names; versioned names or conservative abstention are safe |
| Simultaneous local microphone | Local words stay `LOCAL`, remote words retain their remote name, provenance stays separate |
| Legacy provenance | Old DOM evidence remains labelled DOM after recovery/finalization |
| Evidence-source transition | A single utterance crossing incompatible evidence sources stays unnamed |

Every case also requires zero wrong or unsafe name time, zero missing reference time, zero detectable source/provenance violations and intact saved captures. Unknown-label durations are explicitly checked for the gap/transition cases. Reports show per-case and per-turn results; a combined success percentage would hide the intentional abstentions.

Initial replay exposed a real historical rename failure: reusing a participant ID with a new display name overwrote the old name in the final speaker table. The stable-ID case protects against that failure independently of the finalizer's chosen repair. Keep this case even though the current native adapter versions its tile identity when the name changes.

To extend the gym, author speech truth before observations. Include bad/missing observations without changing the actual reference speaker. Do not derive reference names by calling the attribution function, or claim that perfect scores on supplied observations establish real-world name accuracy. Use the independent evaluator tests to check incorrect names, fabricated overlap attribution, empty predictions, duplicate segments, conflicting names and invalid timing.
