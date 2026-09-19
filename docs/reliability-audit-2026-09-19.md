# Sea Shell reliability audit — 19 September 2026

Six focused repair/test rounds are prepared as stacked PRs. They address
reproducible installation, Humain process boundaries, capture lifecycle,
repeatable verification, recovery, and exclusive watcher ownership. These are
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
| Humain could return another run/model or missing/duplicate segment IDs; relative stores moved with its cwd | Validate identities and resolve paths before dispatch; four regressions failed before the fix | [#3](https://github.com/stupart/seashell/pull/3) |
| Stuck providers could hold meeting processing forever | Bounded output/deadline, cancellation, kill escalation, and unconditional private request cleanup | [#3](https://github.com/stupart/seashell/pull/3) |
| Recorders ignoring signals could hang shutdown | Escalate and drain both sources; process fixtures ignore SIGINT/SIGTERM deliberately | [#4](https://github.com/stupart/seashell/pull/4) |
| Concurrent ASR requests could bypass readiness; missing executables caused uncaught errors; stop could race startup | Shared readiness, spawn-error handling, startup cancellation; deterministic server fixtures and actual warm ASR | [#4](https://github.com/stupart/seashell/pull/4) |
| Detector errors bypassed stop hysteresis; capture startup errors left the controller recording | Advance missing-signal handling, reset failed starts, and release leases in nested cleanup | [#4](https://github.com/stupart/seashell/pull/4) |
| Login watcher lost custom runtime/config paths, logs lacked explicit private modes, failed bootout looked successful | Preserve non-secret paths, precreate 0600 logs, and retain registration/report failed shutdown | [#4](https://github.com/stupart/seashell/pull/4) |
| Missing FFmpeg counted as two passing integration tests | Explicit ordinary-suite skips; required media checks in a bounded gym and macOS CI | [#5](https://github.com/stupart/seashell/pull/5) |
| A torn final journal line hid committed capture audio | Replay complete records; preserve torn bytes before repairing the append boundary; complete corrupt records still fail | [#6](https://github.com/stupart/seashell/pull/6) |
| An unrelated corrupt transcript could block lookup/export; record IDs could escape storage directories | Isolate damaged entries and reject unsafe IDs before writes; regression coverage includes recovery and traversal | [#6](https://github.com/stupart/seashell/pull/6) |
| Concurrent stale-owner cleanup could grant two watcher leases | Stable-inode kernel `flock`, automatically released on process death; deterministic takeover race and six-process election/crash tests | [#7](https://github.com/stupart/seashell/pull/7) |

## Verified results

- Baseline: 121 Bun tests and 3 Python tests passed, but the two media tests did
  not actually run without FFmpeg. This was a coverage defect, not media proof.
- Final combined local run: **149 Bun tests, 3 Python tests, zero failures**, in
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
- Device acceptance: the initial five-second run did not establish system-audio
  readiness. A direct native probe received a CoreAudio buffer; a repeated
  eight-second check with delayed synthetic playback captured **5 audible mic
  chunks and 6 audible system chunks**, returned `ready: true`, and discarded its
  own recording. This proves a short signal path, not diarization or echo quality.
- An 80-column TUI smoke opened history, selected the saved synthetic meeting,
  displayed its timed transcript, and exited cleanly with recording disabled.
  Calendar timed out and displayed recovery guidance; Calendar permission/readiness
  has not been accepted on this account.
- GitHub macOS CI passed for the gym and recovery PRs. The ownership PR runs the
  same checks on its final commit; inspect the PR check for the current result.

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
   bounded spend; especially repeat-enrichment/retry behavior and interruption
   while enrichment is active. Current process/contract fixtures do not replace
   a real provider acceptance run.

Use the resulting evidence to select the next small regression/PR round. Preserve
failure logs and document unverified prerequisites explicitly; do not infer
production readiness from unit-test counts alone.
