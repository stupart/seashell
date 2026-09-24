# Meeting intelligence and portability status

Last updated: 24 September 2026; installation evidence below dates to 21 September. This describes implemented behavior and open
work, rather than a promise that every optional integration is configured.

## Public installation and portability

The public macOS install is `brew install stupart/tap/seashell`, then `seashell`.
The tap currently distributes **1.1.0-rc10**, including its own Bun runtime,
Whisper executables, local models, and native helpers. Homebrew and Apple
developer tools are prerequisites; native builds and model downloads take time.
The app is macOS-only. Live computer audio needs macOS 14.2 or later.

[Historical hosted source CI passed](https://github.com/stupart/seashell/actions/runs/35538629817).
[Fresh Apple Silicon and Intel installations also passed](https://github.com/stupart/homebrew-tap/actions/runs/35538519086),
including repeatable setup, diagnostics, actual known-phrase transcription, and
library linkage. The formula tests with an isolated library/config and system
PATH, without the developer's Humain checkout or model credentials.

The audit found no required developer username, personal checkout, checked-in
credential, or private model file in the core runtime/install path. Paths are
derived from the installation directory and the current user's home. Standard
Homebrew paths are executable-discovery fallbacks, and the Whisper HTTP worker
binds to this machine's loopback interface on an allocated port. The public
GitHub owner namespace identifies distribution URLs; it is not a local account
dependency.

One implicit development shortcut was found: Humain discovery tried
`~/Developer/humain-engine/dist/cli.js`. The audit fix removes it. Use an installed
`humain` on PATH or an explicit `HUMAIN_CLI` instead. This fallback removal is included in the pinned RC9 formula. Newer source-only
UI fixes and the provider-first setup need a subsequent release.

Remaining platform limits: Intel installation correctness is established, but
smooth real-time Intel performance is not. The source bootstrap still enables
Metal unconditionally; use the architecture-tested Homebrew path on Intel.
Hosted runners do not establish first-boot macOS permissions, real device
switching, sleep/wake behavior, or a full-length physical meeting soak. The
[real Meet test](google-meet-acceptance-2026-09-20.md) verified microphone speech,
automatic stop, and storage; it did not validate a remote participant's speech
or model-generated notes.

GitHub Actions is now disabled to avoid hosted CI charges. Current changes use
[local CI receipts](local-ci.md); the dated hosted runs above are historical evidence.

## What exists

| Capability | Current implementation | Requirement or limit |
|---|---|---|
| Recording and transcript library | Local microphone/computer audio, durable chunks, recovery, final-track ASR, search and exports | Public package; macOS permissions |
| Automatic meetings | Process-audio detection, browser confirmation, optional Calendar title/attendees, stop grace | Browser audio is not Meet-specific participant integration |
| Meeting bundle | `meeting.json`, transcript exports, claim overlays, generated Markdown documents | A base-only meeting is useful without AI |
| Notes and analysis | Summary; decisions, actions, dates, facts, feedback, notes, resources, highlights and speaker-identity claims | Humain plus a configured exact model route |
| Live observations | Bounded transcript windows, overlap, durable cursor, maximum observer runs | Open TUI with live text; provisional results |
| Final analysis | A reconciliation pass over the complete saved transcript and provisional claims | `post-session` or `hybrid`; whole-transcript input |
| Meeting chat | Question, transcript, current claims and ten recent chat messages; answers and evidence IDs saved | Humain chat route; no cross-meeting retrieval |
| Project context | Explicit file allow-list, 512 KiB per file and 2 MiB total, plus Calendar/attendee context | No automatic Atlas/Blueprint search |
| Speaker labeling | Source labels live; verified local diarization after capture; V setup/review copy; manual renaming | Optional model access; no Meet participant connector. See [speaker status](speaker-identification.md) |

The Notes and Analysis tabs are generated views. `documents/*.md` files are
regenerated from the artifact; they are not an editable notebook with protected
user corrections. Action claims have text and optional person/speaker fields,
but no task lifecycle with structured assignee, deadline, completion, or sync.
The enriched JSON combines transcript and meeting data; Markdown/SRT/VTT exports
currently retain the same transcript content rather than weaving model claims
into the spoken text.

The background watcher deliberately avoids live ASR. It captures first, then
transcribes and runs configured enrichment after the meeting. Selecting hybrid
there processes observer windows after capture; it does not provide live notes
while the terminal app is closed.

## Relationship with Humain

Seashell owns audio, transcription, meeting detection, the session controller,
model selection, transcript storage, documents and the UI. Humain executes the
selected model job through its CLI, validates structured output, and stores
durable run receipts and replay identities. It is an optional execution engine,
not a recording prerequisite or a second meeting database.

The integration works in both directions:

- Seashell invokes Humain's `meeting observe`, `meeting reconcile`, and
  `meeting chat` operations for intelligence. Optional remote transcription
  also uses Humain and separately requires audio-upload consent.
- Humain can discover Seashell's capability manifest and invoke its local
  transcription and bounded capture capabilities for other workflows.

As audited, `stupart/humain-engine` is private and its package has
`private: true`. Public Seashell users cannot complete intelligence setup from
the public install alone. A private compatible tarball can now be installed with
`seashell ai install <package.tgz>`; see [Humain setup](humain-setup.md).
`ai status` checks engine/runtime presence and `ai providers` exposes discovery.
Node.js 22.13+ and a selected provider/model are still required. `HUMAIN_CLI` and
`humain` on PATH remain explicit alternatives. Public licensing/distribution and
bundling Node into an app release remain open.

Seashell exposes `codex`, `claude-code`, `openrouter`, and `local-openai` routes for
meeting intelligence. The first three send the transcript and approved context
to a remote backend. `local-openai` uses a separately configured loopback model
server supporting JSON-schema output. Recording and Whisper remain local.
Humain handles provider credentials; Seashell's configuration stores route
selection, optional per-run limits, and workflow preferences.

For an already configured Humain installation, start with final notes:

```bash
seashell meeting setup --backend codex --model <exact-model> --mode post-session
seashell meeting create <transcript-id>
seashell meeting enrich <transcript-id> --mode post-session
seashell meeting chat <transcript-id> "What decisions did we make?"
```

The audit also fixed CLI enrichment omitting configured context files. Its
default now includes those approved files and saved attendee/Calendar context,
matching the TUI. An explicit `--context <json-file>` replaces that context.
This source correction is not yet in the pinned RC6 package.

## What has been tested

The source gym tests artifact persistence, observer windows and budgets,
route selection, evidence-ID rejection, replay identity, deadlines, cancellation,
and retention of saved transcripts when optional enrichment fails. The separate
Humain gym runs the real engine CLI/compiler/store with a deterministic local
model-executable fixture. It proves protocol behavior, not answer quality.
See [the gym runbook](testing-gym.md) for reproducible commands.

A real remote model has not been evaluated end to end on a scored set of meeting
fixtures in this audit. The [changelog](../CHANGELOG.md#earlier-development-checks)
records an earlier live OpenRouter enrichment canary and a separate STT canary;
those small smoke checks are not a meeting-analysis quality benchmark and were
not rerun here. Citation validation confirms that an ID exists; it
does not establish that the cited words support the model's conclusion. Chat
also permits an empty citation list for abstention. A green core `doctor` result
does not currently attest Humain/provider readiness.

The audit corrections passed 187 Bun tests and 3 Python tests, TypeScript,
native compilation, accelerated 90-minute capture-storage recovery, and 100
synthetic meeting lifecycles (200 child streams, 400 verified chunks, zero
remaining capture children). The real Humain contract gym also passed with its
isolated fixture provider. New regressions first reproduced the hidden-checkout
discovery and missing CLI context, then passed after the fixes.

## Remaining work

1. **Reliable evidence through finalization.** Live drafts can be resegmented or
   reordered by final ASR. Source now binds meeting state to transcript content,
   archives superseded evidence, resets the cursor/claims on revision, and
   rejects stale in-flight results. This fix requires the next package revision.
   Still validate the full live-to-final journey with real diarization and AI.
2. **Supported intelligence setup.** A private packed-engine install now exists:
   `seashell ai install <package.tgz>`, `ai status`, and `ai providers` verify
   the Node/API boundary and expose provider readiness. See [setup](humain-setup.md).
   Public distribution/licensing, selected-model compatibility checks and a
   polished interactive onboarding flow remain. Transcript-only mode stays useful.
3. **Quality and long-meeting tests.** Score synthetic meetings containing
   reversals, ambiguous owners, relative dates, overlapping speakers, and
   unanswerable questions against expected claims and citations. Exercise one
   real provider with an explicit budget. Add token-aware chunking for final
   reconciliation/chat and a session-wide cost limit; the current observer run
   cap and optional per-run limits are not a whole-meeting budget.
4. **Usable review and correction.** Show provisional/final state and clickable
   transcript evidence, preserve manual note edits, and let users confirm or
   correct tasks, owners and dates before exporting them to external tools.
5. **Optional integrations.** Meet participant evidence, approved Atlas/company
   context retrieval, task proposals, and cross-meeting search. These are future
   adapters; none should be required for local capture or silently write to
   external systems.
