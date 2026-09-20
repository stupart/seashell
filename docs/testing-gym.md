# Sea Shell reliability gym

The repeatable loop is: reproduce a failure, keep the failing evidence, add a
regression, make a focused PR, and run the affected checks plus the full gym.
Repeat a suite when investigating intermittent behavior or validating a combined
set of fixes. A green synthetic run does not establish real-device reliability.

## Automatic checks

```bash
bun install --frozen-lockfile
brew install ffmpeg
bun run gym
bun run gym -- --rounds 3 --native
bun run gym -- --capture-soak
```

The gym requires FFmpeg instead of silently counting missing media tests as
passes. It checks TypeScript, Bun and Python tests, and optionally builds the
native Swift/C helpers on macOS. Every run writes private logs, a JSON result,
revision/runtime metadata, and a readable report under `.gym-results/`. A failed
step exits nonzero and retains evidence. Steps have time limits that terminate
their subprocess groups. Generated files are ignored by Git.

The regression suite includes:

- Bootstrap, paths with spaces, missing developer tools, dirty reinstall refusal.
- Model HTTP/interruption/checksum failures and safe retry; update repair retry.
- Media preparation, timed transcripts, subtitle rendering, library persistence.
- Durable capture commits, journal recovery, track gaps, echo suppression.
- Meeting detection/consent, expired heartbeats, partial detector messages across
  restart, capture startup failure, and saved meetings after enrichment failure.
- Capture children ignoring shutdown, server readiness races, missing binaries,
  cancellation during startup, and bounded Humain cancellation.
- Humain consent, receipt/model identity, segment IDs, caller-relative paths,
  long meeting IDs, changed observer requests, and window-scoped evidence.
- Login-agent configuration, private logs, and failed shutdown reporting.

The macOS GitHub Actions workflow runs the default gym plus native compilation
and the accelerated capture-storage exercise for each PR and keeps evidence for
14 days. It requires no private Humain repo,
model download, microphone, Calendar permission, or cloud credentials.

`--capture-soak` accelerates a 90-minute, two-track capture clock through 1,079
real WAV chunk commits (about 345 MB). It injects a stale projection and torn
journal append, reopens the store, continues recording, then assembles both
complete tracks and verifies 1,080 timeline samples including a deliberate
10-second microphone gap. Metrics include commit-window latency, sampled RSS,
CPU time, event-loop delay, and assembly time. Successful runs delete generated
audio and retain metrics; failed runs retain the fixture for diagnosis. This
tests storage and recovery under volume, not native devices or ASR throughput
over 90 minutes of elapsed time.

## Real local ASR and Humain compatibility

After installing the runtime, exercise actual Whisper batch and warm-server
inference, library/subtitle output, and creation of a meeting artifact:

```bash
bun run gym -- --asr
bun run gym -- --humain /absolute/path/to/humain-engine/dist/cli.js
bun run gym -- --rounds 3 --asr --humain /absolute/path/to/humain-engine/dist/cli.js
```

`--asr` uses macOS `say` to synthesize a known speech fixture to disk; it does
not open the microphone or play audio. Build Humain first. `--humain` exercises
the real Humain CLI, compiler, semantic validation, durable run store, and
receipt through an isolated local model-executable fixture. It verifies successful
and terminal-failure replay without redispatch, long meeting identities, a changed
observer route, and chat evidence. Its child environment excludes ambient API
credentials, and its executable path cannot resolve the installed model CLI.

Combining `--asr` and `--humain` also invokes local Seashell transcription through
Humain and requires a successful local artifact with expected words. Humain
remains an optional sibling integration, with no package dependency added to
either product. These checks do not exercise paid/remote meeting providers or
cloud transcription. An unchanged terminal Humain request remains terminal;
Seashell does not silently retry a possibly paid dispatch under a new identity.

For a fresh installer acceptance run, use a dedicated macOS test account with
Homebrew and Apple Command Line Tools. The public command is still:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/stupart/seashell/main/bootstrap.sh)"
```

To isolate storage and avoid a persistent watcher during an installer experiment,
set `SEASHELL_INSTALL_DIR`, `SEASHELL_BIN_DIR`, and `SEASHELL_CONFIG` to fresh
absolute paths, plus `SEASHELL_SKIP_AUTOSTART=1`, before running that command.
The installer still installs any missing system packages. On an untouched Mac,
Apple's developer-tool installer, Homebrew's setup, and OS permission dialogs
remain explicit prerequisites; don't claim an unattended first install there.

## Homebrew distribution gym

The candidate formula and workflow live in
[stupart/homebrew-tap#1](https://github.com/stupart/homebrew-tap/pull/1).
CI checks the exact formula checkout on fresh Apple Silicon and Intel macOS
runners. It downloads checksum-pinned source, Bun, Whisper, and models, compiles
the native helpers, installs the package, and runs `brew test` and
`brew linkage --test`. It retains Homebrew logs for 14 days.
The workflow records timed first-launch diagnostics and gives full-model formula
acceptance a ten-minute limit, within a twenty-minute job limit; hosted CPU
inference can exceed Homebrew's default five-minute test allowance.
During formula acceptance it logs Whisper's elapsed/CPU time and memory, and
retains a one-second process sample if inference is still active after two minutes.

The formula test starts with only the system PATH and isolated config/library
directories. It checks the command wrapper, capabilities, repeatable setup
without autostart, doctor, actual transcription of Whisper's pinned speech
fixture, and package-aware update guidance. Using the source fixture avoids
depending on `say` voices, which can yield empty audio in a headless test account.

Register a review checkout, then exercise its formula:

```bash
brew tap stupart/seashell-preview /absolute/path/to/homebrew-tap-checkout
brew install --build-from-source stupart/seashell-preview/seashell
brew test stupart/seashell-preview/seashell
brew linkage --test stupart/seashell-preview/seashell
brew audit --strict stupart/seashell-preview/seashell
```

Use a disposable test account for installation experiments. Unlike the source
bootstrap, the Homebrew package does not configure a login watcher at install
time; `seashell` works with defaults, and `seashell setup` explicitly opts into
the watcher. See the [acceptance report](distribution-acceptance-2026-09-20.md)
for results and the distinction between candidate and published commands.

## Device acceptance and soak

Use an Apple Silicon Mac with actual audio devices as the device gym. A macOS VM
is useful for clean install/reset testing but does not substitute for physical
CoreAudio routing. Keep the normal account and test account separate.

1. Run `seashell doctor --json`. Test permission denied, then permission granted.
2. Speak and play a synthetic speech file while running
   `seashell capture test --seconds 5`. Both sources need audible chunks. This
   command discards only its own test recording. Retain its JSON result.
3. Make a synthetic Zoom/Meet call. Confirm detection, ambiguous-browser consent,
   stop grace, mic/system separation, final transcript, and saved raw tracks.
4. Repeat with mute/unmute, headphones, a changed output device, sleep/wake, and
   a denied system-audio permission. Record the exact device/OS versions.
5. Interrupt capture after committed chunks, restart, list/finalize recovery,
   and verify timestamps and playback against the original fixture.
6. Run a 60–90 minute synthetic meeting and a subsequent meeting. Track peak RSS,
   CPU, raw chunk count, missing intervals, finalization latency, and orphan
   processes. Keep no real meeting content in public CI artifacts.
7. Separately test optional diarization after model setup, and configured Humain
   notes/chat using synthetic content and an explicitly bounded route. These are
   separate acceptance results; missing credentials are not a pass.

File each discovered failure with the commit, command, result/log path, expected
behavior, actual behavior, and minimum reproduction. Stop a repair round only
when its regression and affected integration checks pass, or record the exact
external prerequisite preventing verification. PRs remain reviewable before
merging; merging an earlier stacked PR requires retargeting the next to `main`.
