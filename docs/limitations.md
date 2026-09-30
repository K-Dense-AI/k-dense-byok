# Current limitations

## Models and tools

Tool execution and skill use depend on the selected model. A model can ignore
instructions, misuse tools or report unsupported conclusions. Check consequential
outputs against code, data and observed [provenance](provenance.md).

Providers may refuse a whole request, including enabled skill descriptions.
Kady surfaces refusal guidance, but a suggested trigger is not a verified current
provider rule. Review unnecessary skills in Settings, open a new chat after
changes, or choose another available model. Model availability and quotas are
controlled by the provider.

[Fusion](openrouter-fusion.md) has no local file/shell tools. Local server
compatibility depends on tool-calling support. Server-side speech transcription
and Fusion still require an OpenRouter key.

## Local shell trust boundary

Tools run as the backend host's OS user. The project sandbox is a workspace,
not process isolation: a same-user shell can read other accessible files and
credentials. API tokens and owner-only file permissions protect other boundaries,
not the agent from its own account. Use a separate account/container/VM for
adversarial content or stronger credential isolation.

The [raw-data guard](data-guard.md) recognizes common destructive patterns; it
cannot inspect every script's effects. Keep backups. Skills and persistent
specialist memory are instructions with the agent's permissions. Third-party
installed skills require review and are not automatically updated; catalogue
skills follow the [catalogue sync policy](skill-management.md).

## Cost and data handling

- Project caps use recorded prices and estimates, not provider invoices. Concurrent/in-flight model calls can overshoot; quotas and overages remain external.
- Local-model $0 accounting does not cover a paid hosted gateway. Use a priced custom server for that case.
- External-CLI specialists bypass Kady's ledger and cap and are disabled by default.
- Hosted models, web search, connectors and Modal can receive task data. A local installation or local preview does not make every workflow offline.

See [billing](model-selection.md#billing-and-budgets) and [Security](security.md).

## Sessions, specialists and automation

- Ten chat tabs per project; all share project files, so concurrent edits can conflict.
- Browser reconnect preserves active turns only while the backend stays running. Backend restarts end ordinary active turns; Modal has separate recovery.
- Skills, specialist definitions and MCP configuration generally apply to new chats. Specialists can use MCP, but explicit tool restrictions still apply.
- Child questions go through the lead with a timeout. Specialist memory and watchdog findings are model-authored and can be wrong. Watchdog failures can be silent; inspect its status command.
- Schedules require the server. Missed slots follow catch-up policy, and overlapping fires are skipped. Panel management needs an available resident session.

## Research records

The notebook is authored; provenance observes bounded effects. Neither verifies
scientific claims or captures complete execution IO. Nested child work is not
harvested, and retrospective hashes do not prove citation-time identity.
Compaction summaries can omit details. Artifact versions overwritten before
retention cannot be reconstructed from hashes. See [Notebook](lab-notebook.md),
[Provenance](provenance.md) and [Evidence packages](evidence-packages.md).

## External services and platform boundaries

Web search without a key uses a shared fallback that can rate-limit; video
understanding needs Gemini. PDF text extraction does not OCR scanned pages.
Modal cost is estimated, multi-GPU work stays within one sandbox, and remote
package inventories/per-job egress controls are incomplete; see [Modal](modal-compute.md).

Native Windows requires Git Bash. Scientific previews have format/size limits;
see [File previews](file-previews.md). Dedicated literature/regulatory search,
document conversion and browser automation require appropriate tools/connectors.
Citation checking by a specialist is not automatic independent verification.
