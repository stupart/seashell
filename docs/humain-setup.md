# Meeting AI with Humain

Seashell records and transcribes without an AI provider. Optional summaries,
action items, identity suggestions and meeting chat run through Humain, a reusable
Node engine shared by other apps. Seashell finds connected providers and proposes
suitable models; confirm the provider once. It never switches accounts after a
failed call or requires a Seashell account to record or use an existing AI login.

## Install a packaged engine

The Humain repository and package are currently private. A public npm install or
bundled public Homebrew download is not available yet. Given a trusted project
package, Node 22.13+ and Seashell, install with one command:

```sh
seashell ai install /path/to/humain-engine-0.0.1.tgz
```

If Node is missing, the command explains `brew install node`. Installation runs
without package lifecycle scripts, checks the engine API under Node, and selects
it only after the check passes. It preserves the previous selected installation
on failure and stores packages in your Application Support directory. No developer
checkout, account token or microphone permission is needed for this step.

```sh
seashell ai status
seashell ai providers
```

The provider list reports local CLI authentication and configured endpoints, with
next steps when something is missing. It does not send transcripts for a test.
Readiness is not a guarantee of model quality or of every native harness feature.
Choose inside the TUI with **P → Meeting AI**, or open the same picker directly:

```sh
seashell ai setup
```

The first screen proposes a connected provider and its recommended models. Press
**Enter** to use it, **Change provider** to choose another, or **Advanced** for
individual roles and reasoning effort. When setup was opened by Ask or Generate
notes, saving resumes that action. Discovery and cancelling never change config.

An explicitly configured local server is preferred; otherwise a ready Codex login,
then Claude Code, then OpenRouter. Existing saved choices are preserved. A failed
catalog fetch is surfaced instead of quietly sending data to another provider.
The UI shows the chosen account and models before confirmation.

Model selection uses discovered IDs: fast families for live observations, deep
families for final notes, and balanced families for chat. Examples are Luna/Astra/Sol
or Haiku/Fable-or-Opus/Sonnet. These family labels are routing policy, not measured
latency, price, context-window or quality guarantees. A provider's default model is
never assumed suitable for continuous analysis. If no fast family is recognized,
recommended setup disables live analysis. Unknown cloud models require Advanced;
an explicitly configured local model may serve final notes/chat without live AI.
Models are pinned when saved; they do not silently change on subsequent launches.
**Use recommended models** refreshes an existing configuration explicitly.

In Advanced, choose **Live analysis**, **Final notes**, or **Meeting chat**, then
use **↑/↓** and **Enter** to choose provider, model and supported effort. Each role
can use a different provider. Missing authentication shows setup guidance; custom
IDs use provider-default effort. **Save choices** applies the draft. Escape returns
to the simple settings screen without applying those advanced edits.

The **Mode** row controls whether live analysis is enabled. New setups start with
**Final notes only**; select **Live analysis + final notes** for both stages, or
**Live analysis only**. Chat is available in every mode. Suggestions preserve
your selected mode when a fast model is available. Existing shared-model settings
continue to work. Advanced edits remain explicit overrides, including any choice
to use a large model for live analysis.

Effort options come from the selected model's capabilities. Haiku currently
advertises no effort control. Local/OpenRouter structured meeting adapters use
provider-default effort until Humain supports their effort contracts. Discovery
and saving make no inference calls, and recording keeps running while the picker
is open. Saving preserves compatible per-role budgets and calendar/capture settings.
Cloud roles send meeting text through the account shown in the picker.
Advanced models, including Fable, may consume paid credits depending on your plan.

The complete current workflow, exact prompt roles and proposed context/action
integration are described in [the meeting product direction](meeting-product-direction.md).

For scripted setup, choose an explicit model using the provider you want:

```sh
seashell meeting setup --backend claude-code --model sonnet --mode post-session
```

For a local model server supporting strict JSON-schema Chat Completions:

```sh
export HUMAIN_LOCAL_OPENAI_BASE_URL=http://127.0.0.1:11434/v1
seashell ai providers
seashell meeting setup --backend local-openai --model <installed-model-id> --mode post-session
```

Codex, Claude Code, OpenRouter and `local-openai` are supported meeting route
choices. Remote routes send meeting text and explicitly selected context to that
provider. Local model weights/server installation is separate; Humain does not
silently download a model or switch to a cloud model. Keep the endpoint environment
variable available to the process launching Seashell.

## After a recording

```sh
seashell library list
seashell meeting enrich <transcript-id>
seashell meeting show <transcript-id>
seashell meeting chat <transcript-id> "What did we decide?"
```

Humain returns schema-validated claims and citations, while Seashell owns the
transcript and review UI. Final ASR/speaker changes invalidate superseded evidence
and preserve prior results under the meeting's history directory. Diarization
separates voice tracks; evidence-based identity suggestions are a different step.
Neither guarantees exact participant names from Google Meet yet.

## Packaging boundary

Seashell uses Bun. Humain runs as a bounded Node child process because its durable
engine uses Node-specific facilities; no package-manager migration is needed.
The same Humain tarball is consumable by npm, pnpm or Bun. SDK consumers can use
`createHumainApp` for app/user namespaces, durable replay, telemetry and meeting
helpers, then access the existing engine for agents, skills and workflows.

Discovery order: explicit `HUMAIN_CLI`, Seashell's selected package, then `humain`
on PATH. There is no sibling-project or personal-path fallback. `SEASHELL_HUMAIN_DIR`
selects an isolated install root for tests. The install currently accepts the
0.0.1 package with the new app API; it is a private compatibility preview.

The public distribution still needs Humain licensing/release decisions. Installing
a package does not change Seashell's selected model or upload permission. Atlas
sync, hosted identities, billing and subscription features are not part of this
local installation.
