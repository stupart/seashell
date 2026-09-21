# Seashell distribution acceptance — 20 September 2026

## Publication status — updated 21 September 2026

The reliability and meeting UI changes in Seashell PRs #2–#16 are merged into
`main`, along with the public installation instructions in #17.
[Post-merge source CI passed](https://github.com/stupart/seashell/actions/runs/35538629817).

[Homebrew tap #1](https://github.com/stupart/homebrew-tap/pull/1) is merged into
`trunk`. Its public release candidate is **1.1.0-rc6**, pinned to Seashell commit
`b8e812c4213f51cb2953d750646b22326efab3d3`.
[Post-merge fresh installs passed on Apple Silicon and Intel](https://github.com/stupart/homebrew-tap/actions/runs/35538519086).
The public installation command is:

```bash
brew install stupart/tap/seashell
seashell
```

The acceptance details below preserve the earlier RC3 experiments. For the
subsequent real Meet test and RC6 results, see
[Google Meet acceptance](google-meet-acceptance-2026-09-20.md). For the current
portability and optional Humain limitations, see
[meeting intelligence status](meeting-intelligence-status.md).

The npm name `seashell` belongs to the unrelated `heineiuo/seashell` message
framework. `@stupart/seashell` was not registered when checked, and this repo's
package manifest remains `private: true`. No npm package was published.
Seashell now includes the MIT license and declares `MIT` in package metadata.
The README already described the project as MIT; the missing license file is now
present. The formula declares MIT and installs the project and upstream notices.

## Package behavior

The formula targets macOS Sonoma or later and selects the official Bun 1.4.2
binary for Apple Silicon or Intel. It keeps Bun private to Seashell, so installing
the app requires no Bun tap or separately configured runtime. FFmpeg and SoX are
ordinary Homebrew dependencies; CMake is a build dependency. The source, runtime,
Whisper revision, large-v3-turbo model, and VAD model are checksum-pinned.
The package retains upstream copyright/license notices for Bun, whisper.cpp,
the Whisper model, and Silero VAD, alongside Seashell's own MIT license.

Installation compiles Seashell's native helpers and both Whisper executables
with embedded Metal shaders on Apple Silicon and explicit SIMD CPU optimizations
on Intel, then installs the complete runtime and model files.
The models make the first download substantial; this is currently a source
formula, not a prebuilt bottle. A Mac needs Homebrew and Apple developer tools.

The app opens without an API key or separate setup. Package installation does
not write user configuration or register a login watcher. `seashell setup`
opts into that background behavior. Humain intelligence and speaker diarization
remain optional; ordinary local transcription needs neither.

`seashell update` directs packaged installations to Homebrew before attempting
Git. Login-agent commands and their environment use the stable Homebrew `opt`
path, preserving the reference when a versioned Cellar is replaced.

## Local acceptance

- Downloaded and ran the actual public-main bootstrap into fresh install/config
  paths with autostart disabled. Native/backend/model installation, doctor, and
  transcription of synthetic speech passed. This tested the older public main,
  independently of the review checkout.
- Installed and reinstalled the candidate through Homebrew using public source
  and model URLs. The formula definition came from a local review tap. The final
  package includes its own Bun runtime. A real `brew upgrade` subsequently
  replaced `1.1.0-rc1` with `1.1.0-rc2`; the installed command and package tests
  passed afterward. A further upgrade to the MIT-licensed `1.1.0-rc3` passed
  formula test, linkage, audit, and style checks, with all five project/runtime/
  engine/model license notices verified in the installed package.
- The installed terminal app opened, selected a saved transcript from history,
  displayed the expected Tuesday/Alice/Bob speech, and exited cleanly. Recording
  was disabled for this UI test.
- The package integration regressions reproduced before repair. The complete
  source gym passed with **167 Bun tests and 3 Python tests**, TypeScript, native
  compilation, and accelerated capture-storage recovery. It passed on Bun 1.4.0
  and again after Homebrew upgraded the local runtime to Bun 1.4.2.
- Fresh hosted testing exposed native diagnostic helpers ignoring termination.
  Two real-process regressions reproduced the overrun, then passed after forced
  termination was added at each deadline. The full gym passed again with
  **169 Bun tests and 3 Python tests**, TypeScript, native compilation, and the
  accelerated capture-storage recovery exercise. The final source also passed
  [macOS CI on Bun 1.4.0](https://github.com/stupart/seashell/actions/runs/35451189921).
- The final private-runtime package passed `brew test`, `brew linkage --test`,
  `brew audit --strict`, and formula style checks. The test passed with only
  system directories on PATH: repeatable setup, doctor, known-phrase local
  transcription, and the Homebrew update message all worked. A separate
  installed-command doctor check under the same restricted PATH returned
  `ok: true`.

[Fresh Apple Silicon and Intel CI passed](https://github.com/stupart/homebrew-tap/actions/runs/35450459727)
installation, configuration, doctor, real transcription, and linkage after the
Intel CPU/Metal corrections. The formula test step took 3 minutes 33 seconds on
Apple Silicon and 9 minutes 8 seconds on Intel, including setup and diagnostics.
The workflow gives full-model acceptance ten minutes, keeps a twenty-minute
job limit, and separately records timed first-launch diagnostics.
[The exact MIT-licensed RC3 candidate also passed both architectures](https://github.com/stupart/homebrew-tap/actions/runs/35451288965):
the test steps took 4 minutes 4 seconds on Apple Silicon and 9 minutes 5 seconds
on Intel. Installation, timed doctor, formula assertions, and linkage all passed.

The installed local preview is available as `/opt/homebrew/bin/seashell`.
Test config and transcript libraries are isolated under
`/tmp/seashell-distribution.Lq3a2h`; no test registered a login watcher. This
directory also retains bootstrap, build, diagnostics, and transcription logs.
The final source gym's Bun 1.4.2 evidence is
`.gym-results/2026-09-19T14-24-19.260Z-56840/report.md`.

## Failures found during installation testing

1. The normal Git updater cannot update a Homebrew package. The CLI now emits
   the Homebrew command, with a regression proving it never invokes Git.
2. A login watcher pointing into a versioned Cellar would break after upgrade
   cleanup. Package-root overrides and preserved environment now use `opt`.
3. macOS `say` returned a successful exit with zero-duration audio inside
   Homebrew's isolated test environment. The package itself transcribed correctly
   in the normal shell. The formula test now uses the speech fixture from the
   checksum-pinned Whisper source and checks known transcript phrases.
4. A fresh hosted Mac could not resolve the separate `oven-sh/bun` dependency
   without explicitly tapping it. The formula now downloads a checksum-pinned
   private Bun runtime, and its test removes preconfigured package paths.
5. Hosted diagnostics took about 90 seconds. Native helpers can ignore SIGTERM
   while their main queue is blocked in CoreAudio startup; a synchronous spawn's
   timeout can then keep waiting. Real helper fixtures reproduced this deadline
   overrun. Both diagnostic probes now use SIGKILL at their existing deadline,
   and the system-audio check reports a timeout explicitly. These read-only probes
   do not save recordings. Timed cold diagnostics on the final candidate dropped
   to about **5 seconds on Apple Silicon and 7 seconds on Intel**, verifying the
   observed delay as well as the isolated regression.
6. The initial portable build configuration inadvertently disabled Intel SIMD
   under Homebrew's `SOURCE_DATE_EPOCH` environment. Its CMake cache showed SSE,
   AVX, AVX2, FMA, and F16C disabled; Intel transcription exceeded even the
   ten-minute test allowance. The formula now explicitly enables an Intel
   Haswell/AVX2 baseline, matching the bundled Bun runtime's
   [documented CPU requirement](https://bun.sh/docs/installation#cpu-requirements).
   The full-model test keeps a ten-minute
   bound and every transcript assertion, within a twenty-minute job limit.
7. Intel inference still stalled with SIMD enabled. The final recipe limits Metal
   to Apple Silicon and uses CPU inference on Intel, matching
   [Homebrew's upstream ggml configuration](https://github.com/Homebrew/homebrew-core/blob/main/Formula/g/ggml.rb).
   The CI now retains process CPU/memory snapshots and a sampled stack for any
   inference lasting over two minutes, so a timeout includes actionable evidence.
   The CPU-only Intel build subsequently passed the full test. Its sampled stack
   and CPU time show active inference, including substantial thread-barrier time.
8. The package initially omitted the bundled transcription engine and models'
   copyright notices. The recipe now installs the engine's existing notice and
   checksum-pinned model notices alongside Bun's notice.

## Limits and release follow-through

Hosted macOS runners provide clean installation environments with developer
tools/Homebrew already installed. They do not establish first-boot setup on an
untouched Mac or microphone/system-audio/Calendar permission acceptance. Local
installation, doctor, and real file transcription do not prove a long meeting,
sleep/wake, device changes, or remote Humain provider quality. Those checks remain
in the [device acceptance runbook](testing-gym.md#device-acceptance-and-soak).

Intel performance remains a product follow-up: the successful hosted run spent
roughly eight minutes in Whisper on an 11-second audio fixture. Passing this test
establishes package correctness, not real-time transcription on Intel. A physical
Intel benchmark should compare thread counts and model sizes before claiming a
smooth live experience. The current file path requests six Whisper threads even
on a four-vCPU runner; the sampled thread barriers make this worth measuring,
but they do not establish how much latency a different thread count would save.
An [immediately preceding CPU-only Intel run](https://github.com/stupart/homebrew-tap/actions/runs/35451094346)
hit the ten-minute test deadline with the same runtime. The successful RC3 run
therefore does not establish consistent hosted latency; the narrow test margin
and thread-count/model benchmark remain explicit follow-ups.

The public formula remains an explicit release candidate. Every formula update
needs fresh installation CI before promotion to a stable release. Installations
from the earlier `stupart/seashell-preview` tap retain that tap's ownership;
Homebrew refuses to install the same formula from `stupart/tap` alongside it.
Moving such an installation requires quitting Seashell and replacing the preview
package with the public package. Fresh users should use only `stupart/tap`.
