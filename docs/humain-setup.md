# Meeting AI with Humain

Seashell records and transcribes without an AI provider. Optional summaries,
action items, identity suggestions and meeting chat run through Humain, a reusable
Node engine shared by other apps. You choose the backend and model; Seashell does
not silently change privacy or billing routes.

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

Choose **Live analysis**, **Final notes**, or **Meeting chat**, then use **↑/↓**
and **Enter** to choose its provider, model, and supported reasoning effort.
Each role can use a different provider. Humain reads model lists from your native
Codex/Claude CLI or configured local/OpenRouter catalog. Missing authentication
shows the relevant setup step. If discovery fails, update Humain/the provider CLI
or use **Enter a custom model ID**. Custom IDs use provider-default effort.

**Suggest models for all roles** fills an editable draft using models the chosen
provider advertises: a fast family for live observations, a detailed family for
final notes, and a balanced family for chat. For example, Claude can offer Haiku,
Fable/Opus, and Sonnet respectively. These are family-based starting points, not
quality or latency benchmarks, and account/model availability can change. Fable
may use paid credits under your Claude plan. No model or provider is selected
silently. Check the choices and press **Save choices** to apply them; Escape from
the role screen discards the draft.

The **Mode** row controls whether live analysis is enabled. New setups start with
**Final notes only**; select **Live analysis + final notes** for both stages, or
**Live analysis only**. Chat is available in every mode. Suggestions preserve
your selected mode. Existing shared-model settings continue to work.

Effort options come from the selected model's capabilities. Haiku currently
advertises no effort control. Local/OpenRouter structured meeting adapters use
provider-default effort until Humain supports their effort contracts. Discovery
and saving make no inference calls, and recording keeps running while the picker
is open. Saving preserves compatible per-role budgets and calendar/capture settings.
Cloud roles send meeting text through the account shown in the picker.

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
