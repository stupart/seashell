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
- Capture clock provenance and explicit overrun discontinuities, with a
  preallocated real-time CoreAudio handoff and a hardware-clocked aggregate
  device based on current AudioCap/Recap patterns.
- Async serialized chunk durability, bounded draft scheduling, one private
  lifecycle-owned warm Whisper server, and measured machine-local ASR profiles.
- Exact-model OpenRouter STT through Humain plus consented Local/Cloud/Adaptive
  draft routing and an independently pinned canonical final route.
- Automatic macOS meeting detection from active process-audio signals with
  confirmation hysteresis, dropout grace, maximum duration, and cooldown.
- Low-resource background capture with no in-meeting inference, serialized
  post-session finalization, a one-watcher lock shared with the TUI, and an
  optional per-user launch-at-login agent.
- Calendar-corroborated browser auto-capture, conservative browser consent,
  attendee extraction for speaker evidence, and bounded allow-listed project
  context for Humain enrichment.
- Private per-user permissions for newly written transcript, meeting, capture,
  config, and background-log data.
- One-command source bootstrap with idempotent first-install defaults, automatic
  launch-at-login, explicit opt-outs, and byte-preserving reinstall behavior.
- A persistent native meeting-signal stream that pays CoreAudio initialization
  once instead of spawning a new detector every poll, plus bounded Calendar
  retry and concise permission recovery guidance.

## Next hardening checkpoints

- Add hardware-clock drift measurement/correction, device-change recovery,
  automatic route restart, and microphone/system acoustic echo
  cancellation beyond conservative transcript deduplication.
- Provisional live transcript revisions; capture,
  diarization, identity, cleanup, and rendering remain separate transforms.
- Isolated optional Google Meet participant/active-speaker evidence adapter,
  with explicit screen-data disclosure and a deterministic fallback.
- Expand the strict local/cloud offer catalog with diarization, language,
  format, size, price-unit, and latency matching before automatic selection.
- Real-meeting eval corpus covering reversals, ambiguous aliases, diarization
  errors, late evidence, disconnection, and abstention.
- Human correction UI for claims, not only speaker labels.
- Context connectors for Blueprint/Atlas/project docs with permission grants,
  revision-aware source maps, and in-product visibility beyond the current
  explicit file allow-list.
- HIPAA-oriented deployment profile: organizational identity/RBAC, audit log,
  retention/deletion policy, managed encryption, BAA-backed provider allow-list,
  incident operations, and external risk/security validation.
- Native macOS notifications and a one-click consent surface for ambiguous
  meetings detected by the headless login watcher.
- Packaging Humain and Sea Shell so the optional engine dependency installs and
  updates without a development checkout.
- macOS app projection over the same transcript and meeting contracts after the
  terminal workflow is stable.
