# Local CI

On macOS with Apple Command Line Tools, Node 22.13+, Bun, FFmpeg and Python 3:

```sh
bun run ci
```

This installs locked dependencies, tests the CI runner, then runs the complete
existing gym: typecheck, Bun/Python regressions, required media checks, Swift/C
native build, accelerated capture-storage recovery and 100 meeting lifecycles.
It opens no microphone and makes no paid model calls. It requires no model
download or private Humain checkout. Dependency downloads still need the network.

`bun run ci:quick` runs development checks without native/soak checks. It never
qualifies as full CI. Optional real ASR, Humain-package and device checks remain
documented in [the gym runbook](testing-gym.md); this gate does not silently
download gated diarization models or use cloud providers.

Private logs, JSON receipts and a readable report are in `.ci-results/<run>/`;
gym details are in `.gym-results/<run>/`. The latest receipt is
`.ci-results/latest.json`. Both folders are ignored by Git. A receipt binds the
tested source bytes, file modes/symlinks and runtime versions. Changes during
testing invalidate it. Timeouts and Ctrl-C terminate the active command group;
failed/cancelled steps never count as passes. Concurrent CI in one checkout is
refused. Preserve failed evidence; delete obsolete result folders when needed.

```sh
bun run ci:verify   # verify the clean checkout matches a passing full run
bun run ci:hook     # optional pre-push verification hook
```

Run CI, commit the tested contents, then push. A commit with identical tested
bytes retains the receipt. The hook rejects dirty or changed source, runtime
changes, incomplete checks, and pushes of another unchecked revision. Existing
hooks/configuration are preserved. Worktrees share repository hooks. Remove the
hook only if it contains `local-ci-verification`; for an existing custom hook,
add `node scripts/local-ci.mjs --verify` manually. This developer guard is local,
not tamper-proof remote branch protection, and publishes nothing to GitHub.

GitHub Actions is disabled and automatic push/PR triggers are removed. The
manual workflow calls the same runner if an owner explicitly enables hosted
execution later. The current Mac architecture is recorded; Apple Silicon tests
do not certify Intel or Linux. Fresh Homebrew installation remains a separate
local formula test (`brew test <your-tap>/seashell`) on each available Mac type.
