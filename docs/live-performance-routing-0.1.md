# Live capture performance and transcription routing `0.1`

Sea Shell keeps one durable capture truth and treats live transcription as a
replaceable draft projection. The default remains fully local.

```text
native microphone/system clocks
  -> small independently decodable WAV chunks
  -> async copy + fsync + hash + journal + manifest projection
  -> bounded draft scheduler (local, cloud, or adaptive)
  -> pinned canonical final route
  -> saved transcript + attached raw capture bundle
```

## The seven-part hardening loop

Each slice used the same loop: define the smallest safe behavior, encode its
invariants, implement it, run focused and fault tests, critique performance and
product behavior, then update the durable contract.

1. Capture packets now retain their clock origin, uncertainty, and native
   host/sample evidence. Dropped frames become explicit discontinuities rather
   than compressed time.
2. The CoreAudio callback copies into a preallocated bounded ring only. Audio
   conversion, allocation, JSON, and pipe writes run on a consumer queue.
3. Chunk copy, permission change, fsync, hashing, journal fsync, and manifest
   projection are serialized asynchronously outside the UI/capture turn.
4. Local draft ASR uses one Sea Shell-owned private `whisper-server`, a bounded
   fair queue, cancellation generations, and TERM-to-KILL cleanup. Sea Shell
   never adopts or terminates another process's Whisper server.
5. `bun run benchmark:live-asr -- <16k-mono.wav>` measures the exact model on
   this computer and stores the best tested thread count in a private local
   profile. Missing or mismatched evidence selects an honest safe default.
6. Humain exposes exact-model OpenRouter STT with required segment timestamps,
   ZDR/data-collection routing, explicit upload approval, provider usage/cost,
   generation-audit reconciliation, and durable receipts.
7. Sea Shell supports `local`, `cloud`, and `adaptive` draft routing. Adaptive
   mode can move new draft jobs to cloud when the local queue reaches a declared
   threshold; it never changes the separately pinned canonical final route.

## Clock meaning

Transcript time zero is the beginning of the capture session or source media,
not the start or end of transcription. A system-audio device sample clock is
preferred. The microphone currently uses a process-start estimate with measured
first-data uncertainty. Capture overruns insert silence and record the gap so
later words do not slide earlier on the meeting timeline.

## Routing and consent

Configuration lives at
`~/Library/Application Support/Sea Shell/config.json` unless
`SEASHELL_CONFIG` overrides it.

```json
{
  "transcription": {
    "mode": "adaptive",
    "canonicalFinal": "local",
    "adaptiveCloudQueueDepth": 3,
    "cloud": {
      "model": "openai/whisper-large-v3-turbo",
      "upstreamProvider": "groq",
      "maxCostMicrousd": 100000,
      "uploadConsent": true
    }
  }
}
```

- `local` sends no audio over the network.
- `cloud` requires an exact model and `uploadConsent: true`.
- `adaptive` stays local below the threshold and fails closed to local without
  upload consent.
- `canonicalFinal` is independent. Keep it `local` for local canonical truth
  even when cloud drafts reduce UI latency.

Humain is optional. A cloud route requires its CLI and OpenRouter setup, but a
missing or failed Humain enrichment never prevents local capture, recovery,
library storage, or export.

## Measured checkpoint

On the development Mac, the exact installed
`ggml-large-v3-turbo-q5_0.bin` model transcribed a 3.7518-second fixture with a
2.030-second median at four threads (real-time factor `0.5411`). This evidence
is machine- and model-specific; another installation must benchmark itself.

