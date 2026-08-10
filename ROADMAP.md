# Sea Shell roadmap

## Shipped on the staging branch

- Universal audio/video import with deterministic FFmpeg media preparation.
- Canonical timestamps, speaker diarization, editable speaker names, SRT/VTT,
  and a folder-based transcript library.
- Transcript-first TUI with a responsive, on-demand history drawer.
- Conservative speaker identity from roster, self-identification, direct
  handoffs, and timestamped active-speaker observations.
- Safe Git fast-forward updater.
- Meeting artifact bundle with streaming, post-session, and hybrid Humain runs;
  evidence-linked overlays; notes/analysis/chat views; read-only Calendar
  suggestions; and friendly derived documents.

## Next hardening checkpoints

- Real-meeting eval corpus covering reversals, ambiguous aliases, diarization
  errors, late evidence, disconnection, and abstention.
- Native finalization trigger when a live meeting ends, with an explicit consent
  and spend confirmation policy.
- Human correction UI for claims, not only speaker labels.
- Context connectors for Blueprint/Atlas/project docs with source-map display.
- Calendar attendee extraction where the provider exposes it reliably.
- Packaging Humain and Sea Shell so the optional engine dependency installs and
  updates without a development checkout.
- macOS app projection over the same transcript and meeting contracts after the
  terminal workflow is stable.
