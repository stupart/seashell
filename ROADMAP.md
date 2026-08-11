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
- Versioned `transcription.seashell.local` capability discovery for Humain and
  separate observer/reconciliation/chat model settings with a shared fallback.
- Native macOS system-audio capture alongside the microphone, with first-buffer
  clock evidence, incremental WAV chunks, source labels, silence gating,
  permission fallback, echo-duplicate suppression, and an advertised
  `capture.seashell.macos.live` offer.
- Separate durable mic/system tracks with atomic chunks, SHA-256 content
  evidence, an fsynced append-only journal, recovery commands, and a full-track
  final ASR pass.
- Independent mic/system meters plus a disposable signal test, graceful quit
  attachment, and an end-of-meeting `G` path that preserves the transcript even
  when optional Humain enrichment is unavailable.

## Next hardening checkpoints

- Add hardware-clock drift measurement/correction, device-change recovery,
  explicit route discontinuities, and microphone/system acoustic echo
  cancellation beyond conservative transcript deduplication.
- Provisional live transcript revisions; capture,
  diarization, identity, cleanup, and rendering remain separate transforms.
- Consent-first meeting detection from process/audio/calendar signals, followed
  later by an isolated optional Google Meet participant/active-speaker adapter.
- Strict local/cloud transcription offer discovery with explicit timestamp,
  diarization, language, format, size, privacy, and cost capability matching.
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
