# OpenRouter Fusion

Fusion sends a prompt to a panel of models and uses a judge to synthesize one
answer. Select a preset under **Openrouter Fusion** in the model picker. It
requires `OPENROUTER_API_KEY`.

## Use and configuration

Use Fusion for interpretation, synthesis and review of context already supplied
to the conversation. **Kady's local tools are disabled for the entire turn**:
Fusion cannot read project files, execute analysis code or edit outputs. Use a
normal model to gather data first.

**Settings → Fusion** shows the current panel/judge configuration and lets you
add or edit presets. Presets are stored in this browser's local storage. Updates
refresh unchanged built-ins while preserving custom presets and edited copies.
The shipped definitions live in
[`fusion-presets.ts`](../web/src/lib/fusion-presets.ts).

Every message runs the selected panel. Multiple responses are not independent
scientific evidence, and the built-in combinations carry no benchmark guarantee.
Panel web activity runs at OpenRouter and is not exposed as Kady tool provenance.

## Pricing

The picker and backend estimate each panel model once **plus the judge twice**
using catalogue token prices. Fusion counts toward the project cap, but actual
provider charges may differ. Partially missing pricing is flagged and may
underestimate spend; a wholly unpriceable configuration is rejected.

## Implementation

The browser sends `fusionConfig` with the run request. The backend resolves a
synthetic `openrouter/fusion` model, temporarily disables local tools and restores
them after the turn. The provider bridge supplies the Fusion plugin body and
puts reasoning/temperature settings inside the plugin.

Relevant code: [`models.ts`](../server/src/agent/models.ts),
[`fusion-bridge.ts`](../server/src/agent/fusion-bridge.ts),
[`sessions.ts`](../server/src/api/sessions.ts) and the
[pricing parity test](../server/test/fusion-pricing.test.ts).
