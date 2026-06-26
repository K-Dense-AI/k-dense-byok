/**
 * OpenRouter Fusion bridge.
 *
 * Selecting a "Fusion" preset in the model picker must issue a REAL OpenRouter
 * Fusion request (model "openrouter/fusion" + a `plugins` array describing the
 * analysis panel and judge). Pi builds the outgoing chat/completions body from
 * the resolved Model (its `model.id` becomes `payload.model`), which is the
 * wrong shape for Fusion — so we rewrite the body via the SDK's
 * `before_provider_request` extension hook (same mechanism subagent-bridge.ts
 * uses for its hooks).
 *
 * Two pieces live here, mirroring subagent-bridge.ts:
 *  1. `buildFusionRequestBody()` — the PURE transform (no network, no Pi state),
 *     so it is unit-testable in isolation.
 *  2. `makeFusionRequestExtension()` — an ExtensionFactory that reads the
 *     stashed per-session Fusion config and applies the transform to each
 *     outgoing payload. `setFusionConfig()` lets the /run handler stash the
 *     config for the session before a run (and clear it for non-fusion runs).
 *
 * The cost side (closing the $0 spend-cap bypass) is handled separately in
 * models.ts: `payload.model` rewriting alone does NOT change billing, because
 * pi-ai computes cost from the resolved Model's `cost.input/output`, not from
 * the rewritten HTTP body. The handler therefore also resolves a fusion Model
 * carrying the summed panel price via session.setModel.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** The subset of a Fusion request body we read off the stored preset config. */
export interface FusionConfig {
  /** Optional top-level sampling temperature. */
  temperature?: number;
  /** OpenRouter reasoning effort (e.g. "xhigh"). */
  reasoning_effort?: string;
  /** The `plugins` array (a single "fusion" plugin with the analysis panel). */
  plugins?: unknown;
  [k: string]: unknown;
}

/**
 * OpenRouter's accepted reasoning effort values (per its reasoning-tokens docs):
 * "xhigh" | "high" | "medium" | "low" | "minimal" | "none". "xhigh" is the top
 * tier (~95% of max reasoning tokens; supported on Opus 4.7+, GPT-5.5, etc.), so
 * we pass the preset's value through when valid and only fall back to "high" for
 * an unrecognised value (e.g. a typo in a hand-edited preset).
 */
const OPENROUTER_EFFORTS = new Set(["xhigh", "high", "medium", "low", "minimal", "none"]);
function normalizeEffort(effort: string): string {
  const e = effort.toLowerCase();
  return OPENROUTER_EFFORTS.has(e) ? e : "high";
}

/**
 * Pure transform: given the base chat/completions payload Pi assembled and a
 * Fusion config, return the payload that runs OpenRouter Fusion. With no/empty
 * config the base payload is returned UNCHANGED (the non-fusion path).
 *
 * Uses OpenRouter's Fusion *router* form (docs: routing/routers/fusion-router):
 * model "openrouter/fusion" + a single `plugins:[{id:"fusion", ...}]` carrying
 * the panel (analysis_models), judge (model), preset, max_tool_calls, and —
 * crucially — `reasoning`/`temperature` INSIDE the plugin (top-level reasoning
 * 400s against Pi's own reasoning.effort). Fusion is a server tool the model
 * chooses to call, and the plugin only injects it when the caller isn't sending
 * its own `tools`; Pi always does, so we drop the tools array and set
 * `tool_choice:"required"` to force deterministic fusion on every message of a
 * Fusion preset. (This drops Pi's local agentic tools for the fusion turn — the
 * panel runs web search server-side.)
 */
export function buildFusionRequestBody(
  basePayload: Record<string, unknown>,
  fusionConfig: FusionConfig | null | undefined,
): Record<string, unknown> {
  if (!fusionConfig || !fusionConfig.plugins) return basePayload;

  const plugins = Array.isArray(fusionConfig.plugins) ? fusionConfig.plugins : [];
  const plugin = { ...((plugins[0] as Record<string, unknown> | undefined) ?? { id: "fusion" }) };

  // Move the preset's reasoning/temperature INSIDE the fusion plugin (the router
  // applies them to the panel + judge); normalise the effort to OpenRouter's set.
  if (fusionConfig.reasoning_effort !== undefined) {
    plugin.reasoning = { effort: normalizeEffort(String(fusionConfig.reasoning_effort)) };
  }
  if (fusionConfig.temperature !== undefined) {
    plugin.temperature = fusionConfig.temperature;
  }

  // Request-level fallback to the judge model if the openrouter/fusion router
  // call errors (downtime / rate-limit / moderation / context-length). NOTE: this
  // is a WHOLE-CALL fallback, not a per-panel-model swap — request params
  // propagate, so the retry also attempts fusion (via the judge as host).
  const judge = typeof plugin.model === "string" ? (plugin.model as string) : undefined;

  const next: Record<string, unknown> = {
    ...basePayload,
    model: "openrouter/fusion",
    plugins: [plugin],
    tool_choice: "required",
    ...(judge ? { models: ["openrouter/fusion", judge] } : {}),
  };
  // Don't send our own tools array — the fusion plugin injects openrouter:fusion
  // only when the caller isn't managing tools, and with tool_choice:"required" +
  // that single tool, fusion runs deterministically.
  delete next.tools;
  // Reasoning/temperature now live inside the plugin; remove any top-level copies
  // so OpenRouter never sees conflicting reasoning fields.
  delete next.reasoning;
  delete next.reasoning_effort;
  delete next.temperature;
  return next;
}

// Per-session Fusion config, stashed by the /run handler for the duration of a
// run. Module-level because the extension is constructed before the session
// exists (same holder pattern as subagent-bridge.ts), so it reads the live
// value here keyed by sessionId. `null` means "this session is not running a
// Fusion preset" — the extension then passes payloads through untouched.
const sessionFusionConfigs = new Map<string, FusionConfig | null>();

/** Stash (or clear, with `null`) the Fusion config for a session's next run. */
export function setFusionConfig(sessionId: string, config: FusionConfig | null): void {
  sessionFusionConfigs.set(sessionId, config);
}

/**
 * Rewrite each outgoing provider request to a Fusion request when the current
 * session has a Fusion config stashed; otherwise pass it through unchanged.
 *
 * `getSessionId` is lazy because the extension is constructed before the
 * session exists (same as makeSubagentLedgerExtension).
 */
export function makeFusionRequestExtension(getSessionId: () => string): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", async (event) => {
      const fusionConfig = sessionFusionConfigs.get(getSessionId());
      if (!fusionConfig) return event.payload;
      return buildFusionRequestBody(
        event.payload as Record<string, unknown>,
        fusionConfig,
      );
    });
  };
}
