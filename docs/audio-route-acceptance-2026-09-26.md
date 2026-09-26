# Audio route recovery: 2026-09-26

System audio uses a direct CoreAudio process tap. It does not require headphones
or rely on the microphone hearing the other participants.

The audit found that output changes could leave the private aggregate clock or
converter attached to its original device/format. Native capture now observes
default output, system output, tap format, and aggregate-alive changes. A route
reset closes and flushes the helper; the TypeScript controller retries at most
twice with a fresh sample clock. Existing chunks remain committed, and the gap
before resumed audio is recorded as a device reset. Permission errors do not
trigger these retries. Unsupported change listeners warn while basic capture
continues.

An echo-reconciliation bug could discard an entire microphone response when it
contained a shorter remote quote. Suppression now requires at least 90% of the
microphone words to match overlapping computer speech. A regression verifies that
the longer local reply is preserved in either arrival order. This remains a text
heuristic, not acoustic echo cancellation or proof of who spoke.

Validation performed without changing audio devices or volume:

- **Simulated process tests:** fake helpers verify route recovery, committed audio bytes, clock/gap timing,
  retry exhaustion, permission denial, unsupported monitoring, and stopping
  during reconnection.
- **Unit and replay tests:** microphone, durable capture, echo, finalization, and speaker-evidence
  regressions pass; Swift and TypeScript typechecks pass.
- **Real device smoke only:** a newly compiled native helper ran for two seconds, emitted `start`, a real
  `first-buffer`, and `stop`, then exited normally. Its PCM output was discarded;
  no audio recording was retained. No spurious route reset occurred.

Separate real Chrome tests verified remote prerecorded-speech speaker indicators
and joined/leave/prejoin/rejoin detection through Accessibility, with roughly
88–95 ms probes. They did not test physical route changes or complete a diarized
transcript end to end. The prototype remote guest succeeded; a subsequent reusable
harness run was rejected by Google and cleaned up correctly. See the
[native observation evidence](native-meeting-accessibility.md#acceptance-scenarios-and-release-evidence)
for the tested scope and naming prerequisites. No vision model was involved.

Physical headphone unplug/replug, speakerphone echo, simultaneous local/remote
speech, Bluetooth profile changes, and long-call behavior remain unverified.
Microphone capture already retries stalled/exited SoX processes, but changing
the default input while the old device keeps supplying PCM does not currently
force a reopen. Pause/resume selects the new default input.
