# Sea Shell reliability audit — 19 September 2026

Follow-up: [Homebrew distribution acceptance — 20 September](distribution-acceptance-2026-09-20.md)
adds package-aware update/login paths, bounded diagnostic probes, four regressions,
a candidate formula, and fresh-install CI. The original ten-round results below
remain historical evidence.

Ten focused repair/test rounds are prepared as stacked PRs. They address
reproducible installation, Humain process boundaries, capture lifecycle,
repeatable verification, recovery, exclusive watcher ownership, meeting replay,
detector freshness, and capture integrity. These are
review branches; the public `main` installation command does not include them
until they are merged.

## Architecture and audit scope

Sea Shell owns capture, transcription, diarization, transcript storage, and the
meeting UI. Humain remains an optional execution provider. The audit inspected
the install/bootstrap/update path, first-run and LaunchAgent configuration,
microphone/system capture, warm ASR lifecycle, meeting automation, durable
capture recovery, transcript library, and the Humain client. The sibling Humain
capability adapter and transcription/capture/meeting contracts were inspected
and exercised without modifying Humain or adding a package dependency.

This is a targeted deep reliability review, not a claim that every line, native
device configuration, or optional model integration has been verified.

## Findings and repairs

| Failure | Repair and evidence | PR |
| --- | --- | --- |
| Interrupted/HTTP model downloads became apparently installed files | SHA-256 verification, temporary download, atomic replacement; interruption, HTTP, corrupt-content, and retry fixtures | [#2](https://github.com/stupart/seashell/pull/2) |
| Installs followed mutable Whisper HEAD; a present CLI could mask a missing live server | Pin v1.9.4 by commit and build both targets; actual Metal batch/live inference passed | [#2](https://github.com/stupart/seashell/pull/2) |
| Updates left native binaries stale; an advanced Git HEAD prevented retrying failed setup | Repair native/backend/models/locked dependencies on update, including same-revision retries; preserve config/login settings | [#2](https://github.com/stupart/seashell/pull/2) |
| macOS's Git stub masked missing developer tools | Check actual compiler availability before cloning; bootstrap fixtures cover this and paths with spaces | [#2](https://github.com/stupart/seashell/pull/2) |
| Humain upload consent existed only in a TypeScript type at the final dispatch function | Require `uploadConsent === true` before process launch; negative tests verify no provider starts | [#3](https://github.com/stupart/seashell/pull/3) |
| Humain could return mismatched model/segment identities; relative stores moved with its cwd | Validate output and resolve paths before dispatch; the initial run-ID equality check is corrected to honor durable replay in #10 | [#3](https://github.com/stupart/seashell/pull/3) |
| Stuck providers could hold meeting processing forever | Bounded output/deadline, cancellation, kill escalation, and unconditional private request cleanup | [#3](https://github.com/stupart/seashell/pull/3) |
| Recorders ignoring signals could hang shutdown | Escalate and drain both sources; process fixtures ignore SIGINT/SIGTERM deliberately | [#4](https://github.com/stupart/seashell/pull/4) |
| Concurrent ASR requests could bypass readiness; missing executables caused uncaught errors; stop could race startup | Shared readiness, spawn-error handling, startup cancellation; deterministic server fixtures and actual warm ASR | [#4](https://github.com/stupart/seashell/pull/4) |
| Detector errors bypassed stop hysteresis; capture startup errors left the controller recording | Advance missing-signal handling, reset failed starts, and release leases in nested cleanup | [#4](https://github.com/stupart/seashell/pull/4) |
| Login watcher lost custom runtime/config paths, logs lacked explicit private modes, failed bootout looked successful | Preserve non-secret paths, precreate 0600 logs, and retain registration/report failed shutdown | [#4](https://github.com/stupart/seashell/pull/4) |
| Missing FFmpeg counted as two passing integration tests | Explicit ordinary-suite skips; required media checks in a bounded gym and macOS CI | [#5](https://github.com/stupart/seashell/pull/5) |
| A torn final journal line hid committed capture audio | Replay complete records; preserve torn bytes before repairing the append boundary; complete corrupt records still fail | [#6](https://github.com/stupart/seashell/pull/6) |
| An unrelated corrupt transcript could block lookup/export; record IDs could escape storage directories | Isolate damaged entries and reject unsafe IDs before writes; regression coverage includes recovery and traversal | [#6](https://github.com/stupart/seashell/pull/6) |
| Concurrent stale-owner cleanup could grant two watcher leases | Stable-inode kernel `flock`, automatically released on process death; deterministic takeover race and six-process election/crash tests | [#7](https://github.com/stupart/seashell/pull/7) |
| Optional enrichment failures suppressed readiness for an already saved meeting | Persist the enrichment error, warn, and expose the usable transcript; transcription failures still require recovery | [#8](https://github.com/stupart/seashell/pull/8) |
| A silent detector kept returning cached active-call evidence; partial messages survived restart; stop left readers pending | Expire missed heartbeats, escalate process shutdown, clear stream state, and release readers; UI failure handling advances stop grace | [#9](https://github.com/stupart/seashell/pull/9) |
| Legitimate Humain replay was rejected because it returns the original run ID | Bind successful results to their durable receipt; real engine fixture proves no repeated model dispatch | [#10](https://github.com/stupart/seashell/pull/10) |
| Long meeting IDs truncated unique suffixes; changed observer requests reused directories; dots violated Humain's ID contract | Reserve a request digest, include transcript content, and use the engine's allowed character set; enforce window-scoped observer citations | [#10](https://github.com/stupart/seashell/pull/10) |
| Committed audio hashes were recorded but not checked during finalization | Check size and SHA-256 before local assembly or any cloud dispatch; modified and truncated chunks fail without deleting the originals | [#11](https://github.com/stupart/seashell/pull/11) |

## Verified results

- Baseline: 121 Bun tests and 3 Python tests passed, but the two media tests did
  not actually run without FFmpeg. This was a coverage defect, not media proof.
- Final combined local run: **165 Bun tests, 3 Python tests, zero failures**, in
  each of three consecutive rounds; TypeScript and native Swift/C builds passed.
- Native installation plus model checksums, batch transcription, warm-server
  transcription, subtitle rendering, library storage, and meeting creation passed.
- A fresh bootstrap clone/install into disposable paths passed, with autostart
  explicitly disabled. A separate repair/reinstall passed. The fresh install used
  the review checkout as its Git source, not an unmerged public-main download.
- Real Humain CLI local transcription returned `succeeded`, a local-boundary
  timed artifact, and a durable receipt. Fourteen Humain transcription, capture,
  and meeting contract tests passed. No cloud audio upload or paid model call
  was required.
- The expanded Humain gym uses the actual engine's CLI, compiler, semantic
  validator, store, and receipts with an isolated local model executable. It
  verifies successful replay, terminal failure replay without redispatch,
  changed observer routes, long IDs, and chat evidence. It also caught and
  corrected the overly strict run-ID check from the earlier repair round.
- Accelerated storage acceptance committed **1,079 chunks / 345,327,476 bytes**
  on a 90-minute two-track clock, repaired a stale projection plus torn journal,
  resumed recording, and checked 1,080 assembled timeline samples including a
  deliberate 10-second gap. This is a volume/recovery test, not a 90-minute
  elapsed-time hardware or ASR soak. Successful fixtures are deleted; resource
  and latency metrics remain in the gym evidence.
- Device acceptance: the initial five-second run did not establish system-audio
  readiness. A direct native probe received a CoreAudio buffer; a repeated
  eight-second check with delayed synthetic playback captured **5 audible mic
  chunks and 6 audible system chunks**, returned `ready: true`, and discarded its
  own recording. This proves a short signal path, not diarization or echo quality.
- An 80-column TUI smoke opened history, selected the saved synthetic meeting,
  displayed its timed transcript, and exited cleanly with recording disabled.
  Calendar timed out and displayed recovery guidance; Calendar permission/readiness
  has not been accepted on this account.
- GitHub macOS CI passed through the meeting-identity PR. The final capture
  integrity PR also adds accelerated storage acceptance to CI; inspect its
  check for the latest result.

The final combined local evidence is
`.gym-results/2026-09-19T13-29-31.299Z-27604/report.md`. Earlier failing
reproductions were retained locally; the first expanded gym caught a module-mode
error in its model stub, which was fixed before the successful combined run.

Private run directories under `.gym-results/` retain exact revisions, runtimes,
timings, test logs, and reports. CI retains its gym artifacts for 14 days.
The implementation and runbook are in [testing-gym.md](testing-gym.md).

## Remaining acceptance work

Before calling this release fully polished, run the device/soak portion of the
runbook on a dedicated Mac/test account:

1. A true first-user setup with no existing developer tools/Homebrew, plus login
   watcher behavior across logout/reboot. The single command is verified on a
   prepared Homebrew Mac; Apple/Homebrew installation and OS dialogs are still
   explicit prerequisites.
2. Calendar permission acceptance, Google Meet/Zoom start/stop, mute/unmute,
   device switches, sleep/wake, and a 60–90 minute call with resource measurements.
3. Optional pyannote model setup and measured speaker attribution/echo quality.
4. Exact configured Humain notes/chat/cloud routes using synthetic data and
   bounded spend and interruption while enrichment is active. Real-engine
   replay is covered with a fixture provider; these checks do not establish
   remote provider behavior or quality. An unchanged terminal Humain request
   remains terminal: Seashell deliberately does not remint its identity and
   silently repeat a potentially paid operation.

Use the resulting evidence to select the next small regression/PR round. Preserve
failure logs and document unverified prerequisites explicitly; do not infer
production readiness from unit-test counts alone.
