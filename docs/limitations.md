# Known Limitations

K-Dense BYOK is in beta. The agent now runs on the [Pi coding-agent SDK](https://pi.dev) - a single flat agent with file/shell tools and a `subagent` delegation tool (pi-subagents) - which removed the old orchestrator/expert/Gemini-CLI stack and its biggest rough edges. The remaining limitations worth knowing are below.

## Skills depend on model quality

Scientific skills are markdown procedures (`SKILL.md`) the agent discovers in its sandbox and follows with its tools. How faithfully that happens depends on the selected model:

- **Skill activation is not always reliable.** Models sometimes skip a relevant skill, use it partially, or misinterpret the skill's instructions - especially complex multi-step skills that require strict adherence to a procedure.
- **Tool-calling consistency varies across models.** Some models occasionally drop tool calls or call tools with incorrect arguments, which can stall a task or produce incomplete results.
- **Long-context degradation.** When a skill injects a large amount of context (detailed protocols, multiple reference databases), models may lose track of earlier instructions.
- **Structured output can drift.** For skills that require specific output formats (tables, JSON, citations), models sometimes deviate from the requested structure.

These are limitations of the selected model, not of K-Dense BYOK itself; as model tool calling improves, skill execution improves automatically.

**Workarounds:**

- If a skill isn't behaving as expected, try **re-running the task** - results can vary between runs.
- Try a different model in the dropdown. OpenRouter entries advertise `tools` support, while connected subscription entries come from Pi's live provider catalogue; tool-calling quality still varies across both.

## Some models refuse the skills index

Anthropic's Mythos-class models run a safety classifier over the whole request before generating anything. On **Claude Fable 5** that classifier rejects a request whose system prompt lists certain seeded scientific skills — the refusal fires on the skill *description* alone, with nothing sensitive in the conversation at all.

What you see is a run that fails immediately, reporting `Provider finish_reason: content_filter` and zero input tokens. A refusal carries no token usage, so nothing is billed. It happens on the lead agent and on subagents alike (children inherit the lead's model), and it is not a K-Dense bug — the same request refuses when sent straight to the provider.

Skills verified to trigger it individually on `anthropic/claude-fable-5` (2026-08-27), all bio-design or pathogen adjacent:

`adaptyv` · `diffdock` · `ginkgo-cloud-lab` · `glycoengineering` · `pathogen-variant-surveillance` · `phylogenetics` · `tamarind`

**Workarounds:**

- **Switch the chat's model.** Claude Opus 4.8, Claude Sonnet 5, and GPT-5.5 accept the same prompt. If subagents were the ones failing, note they inherit the lead's model unless a specialist pins its own in its frontmatter.
- **Disable the skills you don't need** under Settings → Skills, then open a new chat tab — a live session keeps the skills it already loaded.

When a run fails this way, the error in the chat names the triggering skills that are currently enabled, so you do not have to bisect them by hand. That list is empirical and providers retune their classifiers, so treat it as a starting point rather than a fixed set.

## Ollama / small local models

Local models served through Ollama are supported end-to-end, but they amplify the caveats above:

- Tool-calling fidelity is noticeably weaker on sub-frontier models.
- Skills that rely on multi-tool choreography (running scripts, chaining edits, structured output) are the most fragile.

If a task loops or ignores its skill, try a **larger local model** (or temporarily switch to a frontier OpenRouter or connected subscription model) before assuming the workflow is broken. See [Local models with Ollama](./local-models-ollama.md).

## Pi subscription providers

Kady supports Pi OAuth for OpenAI Codex (ChatGPT Plus/Pro), Anthropic (Claude Pro/Max), GitHub Copilot, and xAI, with these boundaries:

- **Provider limits are external.** Kady cannot read remaining subscription quota, premium requests, overage settings, or plan eligibility. A successful OAuth login does not mean usage is free or unlimited.
- **Reference price is not an invoice.** For OpenAI Codex, Copilot, and xAI, Kady tracks tokens and Pi's list-price equivalent but excludes it from project spend caps. Check the provider for actual quota or overage status.
- **Anthropic OAuth is different.** Pi documents third-party Claude subscription access as metered extra per-token usage. Kady treats that amount as project spend and applies the cap.
- **Direct-provider entries require OAuth.** Ambient OpenAI, Anthropic, Copilot, or xAI API keys are not presented as subscription access; use OpenRouter for the supported API-key path.
- **Some features still require OpenRouter.** Fusion and server-side speech transcription are not authorized by subscription logins.

## Local shell trust boundary

Kady's agent intentionally has a powerful local shell so it can install scientific packages, run analyses, and create artifacts. The shell runs as your operating-system user; it is not an OS-level security boundary. File permissions such as `0600` prevent other users from reading credentials, but cannot prevent a process running as you from reading your own `.env`, `~/.kady`, or other local secrets.

Kady instructs newly created project agents never to inspect or transmit credentials, but instructions are not a substitute for isolation against malicious prompt injection. Do not ask Kady to process adversarial files with secrets accessible to the same account. Use an OS sandbox, container, VM, or separate user account when working with untrusted content or when a stronger credential boundary is required.

### Installed skills are instructions, not data

A skill is a procedure the agent follows using that same shell, so installing one from a third-party source widens this boundary to whoever wrote it. Kady requires an explicit acknowledgement before an install and shows the parsed skills first, but it does not audit their contents: review a source you do not already trust, and prefer pinning a branch or tag. Installed skills are deliberately never auto-updated — a new version is flagged and waits for you, because silently pulling changed instructions into a running project is worse than a stale skill. See [Skill management](./skill-management.md).

## Tabbed chats

- **Hard cap of 10 tabs per project.** This keeps the browser snappy and
  bounds the number of parallel SSE streams to the backend. Close an
  existing tab before opening a new one once you hit the limit.
- **Refresh recovery requires the backend to stay running.** Browser refreshes
  and browser-tab closes preserve project workspaces, chat tabs, drafts,
  queues, and live turns. Stopping or restarting the Kady backend still ends
  in-flight turns; completed conversation history remains on disk and can be
  reopened from Chat history.
- **Workflows launch into the active tab.** If you have a long-running
  turn streaming in tab A and click Launch on a workflow while tab B is
  active, the workflow runs in tab B. Switch to the tab you want to
  receive the workflow before launching.

## Web access

Native web access ([pi-web-access](https://github.com/nicobailon/pi-web-access)) gives Kady and the sub-agents `web_search` and `fetch_content` (pages, PDFs, GitHub repos, YouTube). A few edges:

- **No key = shared fallback.** Without an Exa / Perplexity / Gemini key (Settings → API keys), searches go through a free Exa fallback that can rate-limit under heavy use. Adding any one key removes that bottleneck.
- **Video understanding needs a Gemini key.** YouTube and local-video analysis are only available once `GEMINI_API_KEY` is set.
- **PDF extraction is text-only.** Scanned PDFs without a text layer are not OCRed.
- **Web access for sub-agents applies to new chat tabs**, same as agent and MCP edits below.

## Sub-agents

Sub-agent delegation ([docs](./sub-agents.md)) works end-to-end, with a couple of edges:

- **Sub-agents can't use MCP tools yet.** Tools from connected [MCP servers](./mcp-servers.md) are available to Kady itself but not to the sub-agents it spawns. Making them available to sub-agents is on the roadmap.
- **Per-agent model overrides must name an available model.** If you set a model on an agent in Settings → Sub-agents, use an id from the model dropdown; an unrecognized id falls back to the default model rather than failing.
- **Changes apply to new chat tabs.** Agents edited in Settings (and MCP server changes) take effect in tabs opened afterwards; already-running tabs keep the setup they started with.

## Modal compute

Modal jobs are durable, restart-recoverable, available to sub-agents, and
tracked in the center-panel Compute tab. The remaining boundaries are:

- **Displayed cost is an estimate.** Modal does not expose a generally available
  per-sandbox final invoice API. K-Dense reserves worst-case estimated cost and
  reconciles it to elapsed resource time on every terminal path.
- **Multi-GPU is single-sandbox.** K-Dense can request multiple GPUs and run
  bounded groups of independent jobs, but it does not orchestrate multi-node
  distributed training.
- **The local sandbox remains canonical.** Remote Volumes cache dependencies,
  models, and reference data; they are not a second copy of the project
  workspace.
- **Security scope is narrower than provenance scope.** Remote jobs do not
  receive model credentials by default; fine-grained egress policy and per-job
  secrets remain future work. Provenance does cover remote work: every terminal
  Modal job is recorded as a `compute` step with the transfer layer's own
  input/output hashes (see [Provenance](./provenance.md)), though the remote
  image's installed packages are not enumerated the way the local venv's are.

See [Durable Modal compute](./modal-compute.md) for lifecycle and recovery details.

## Native Windows support is new

The app now runs natively on Windows 10/11 (no WSL needed) as of this release. It goes through the same test suite as macOS/Linux, but has had less real-world mileage — if you hit something Windows-specific, please [open a GitHub issue](https://github.com/K-Dense-AI/k-dense-byok/issues). WSL remains a supported alternative.

## Features deferred during the Pi migration

First-party literature/regulatory search (Paperclip), document conversion, browser automation, citation verification, and the provenance-aware "Copy as Methods" export are not available yet in the Pi-based backend. Web research and Modal remote compute are available now, as is per-artifact [provenance](./provenance.md) — the record the Methods export will eventually draw on. In the meantime, many additional capabilities (GitHub, reference managers, databases, and more) can be added by connecting an [MCP server](./mcp-servers.md).
