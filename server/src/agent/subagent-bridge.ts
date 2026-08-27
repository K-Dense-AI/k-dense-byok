/**
 * Integration glue for the `pi-subagents` package (npm:pi-subagents).
 *
 * The package is a Pi extension that registers a `subagent` tool and runs each
 * delegation as a separate `pi` CLI process (the binary ships with our
 * @earendil-works/pi-coding-agent dependency, so `server/node_modules/.bin`
 * must be on PATH — ensured in session-registry).
 *
 * Three pieces live here:
 *  1. `subagentsExtensionPath()` — locates the package's extension entry so
 *     DefaultResourceLoader can load it per session.
 *  2. `makeSubagentLedgerExtension()` — our own extension that (a) blocks
 *     `subagent` calls once the project's spend cap is hit, and (b) ledgers
 *     each child run's usage (child processes have their own sessions, so
 *     their spend would otherwise be invisible to the project budget).
 *  3. `makeSubagentRefusalExtension()` — annotates a child's tool result when
 *     the model provider refused it, since that failure happens in another
 *     process and reaches us only as opaque runner text.
 * Agent definition files themselves (seeding, parsing, CRUD) live in
 * agent-files.ts; the seeding call happens in session-registry before each
 * session build.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import { boundedMapSet, boundedSetAdd } from "../bounded.ts";
import { isBudgetExceeded, recordSubagentRun } from "../cost/ledger.ts";
import {
  billingCountsTowardBudget,
  billingForProvider,
  type BillingContext,
} from "../cost/billing.ts";
import { resolvePaths } from "../projects.ts";
import { listAgents, settingsPinnedModels, subagentsPackageDir } from "./agent-files.ts";
import { isProviderRefusal, providerRefusalGuidance } from "./model-refusal.ts";
import { modelReference } from "./models.ts";
import { isSubscriptionProvider } from "./provider-auth.ts";

const require_ = createRequire(import.meta.url);

/** Entry file of the pi-subagents extension (per its package.json `pi.extensions`). */
export function subagentsExtensionPath(): string {
  const dir = subagentsPackageDir();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
    pi?: { extensions?: string[] };
  };
  const declared = manifest.pi?.extensions?.[0];
  return declared ? path.resolve(dir, declared) : require_.resolve("pi-subagents");
}

/** Shape of the pi-subagents tool result details we consume (subset). */
interface SubagentRunDetails {
  results?: Array<{
    agent?: string;
    model?: string;
    sessionFile?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: number;
    };
    modelAttempts?: SubagentModelAttempt[];
  }>;
}

interface SubagentModelAttempt {
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
}

// SUBAGENT_ASYNC_COMPLETE_EVENT in pi-subagents (src/shared/types.ts). Async
// runs return a tool result with `results: []` immediately; the real results
// arrive on this pi.events channel when the detached child finishes.
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/** Subset of the async completion payload (the runner's result-file JSON). */
interface AsyncCompletePayload {
  id?: string | null;
  results?: Array<{
    agent?: string;
    model?: string;
    sessionFile?: string;
    modelAttempts?: SubagentModelAttempt[];
  }>;
}

/**
 * Sum assistant-message usage from a child Pi session JSONL. The async result
 * payload carries no usage numbers, but it names each child's session file —
 * and Pi records per-message usage (cost included) there.
 */
export function usageFromSessionFile(
  file: string,
): {
  cost: number;
  tokens: { input: number; output: number; cacheRead: number; total: number };
  provider?: string;
  model?: string;
} | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const providers = new Set<string>();
  const models = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        message?: {
          role?: string;
          provider?: string;
          model?: string;
          usage?: Record<string, unknown>;
        };
      };
      const m = entry.message ?? (entry as {
        role?: string;
        provider?: string;
        model?: string;
        usage?: Record<string, unknown>;
      });
      if (m?.role !== "assistant" || !m.usage) continue;
      const u = m.usage as {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: { total?: number };
      };
      cost += u.cost?.total ?? 0;
      if (typeof m.provider === "string" && m.provider) providers.add(m.provider);
      if (typeof m.model === "string" && m.model) models.add(m.model);
      input += u.input ?? 0;
      output += u.output ?? 0;
      cacheRead += u.cacheRead ?? 0;
      cacheWrite += u.cacheWrite ?? 0;
    } catch {
      /* skip malformed lines */
    }
  }
  const total = input + output + cacheRead + cacheWrite;
  if (total === 0 && cost === 0) return null;
  return {
    cost,
    tokens: { input, output, cacheRead, total },
    ...(providers.size === 1 ? { provider: [...providers][0] } : {}),
    ...(models.size === 1 ? { model: [...models][0] } : {}),
  };
}

type SessionUsage = NonNullable<ReturnType<typeof usageFromSessionFile>>;
const lastLedgeredSessionUsage = new Map<
  string,
  { cost: number; input: number; output: number; cacheRead: number; total: number }
>();

const MAX_TRACKED_SESSION_FILES = 1_000;

function rememberSessionUsage(file: string, usage: SessionUsage): void {
  // Oldest-first eviction, never a wipe: forgetting a watermark makes the next
  // read look first-seen and re-ledger the child's whole cumulative usage.
  boundedMapSet(
    lastLedgeredSessionUsage,
    file,
    {
      cost: usage.cost,
      input: usage.tokens.input,
      output: usage.tokens.output,
      cacheRead: usage.tokens.cacheRead,
      total: usage.tokens.total,
    },
    MAX_TRACKED_SESSION_FILES,
  );
}

function usageDeltaFromSessionFile(file: string): SessionUsage | null {
  const current = usageFromSessionFile(file);
  if (!current) return null;
  const previous = lastLedgeredSessionUsage.get(file);
  rememberSessionUsage(file, current);
  if (!previous) return current;
  const cost = Math.max(0, current.cost - previous.cost);
  const tokens = {
    input: Math.max(0, current.tokens.input - previous.input),
    output: Math.max(0, current.tokens.output - previous.output),
    cacheRead: Math.max(0, current.tokens.cacheRead - previous.cacheRead),
    total: Math.max(0, current.tokens.total - previous.total),
  };
  if (cost === 0 && tokens.total === 0) return null;
  return {
    cost,
    tokens,
    ...(current.provider ? { provider: current.provider } : {}),
    ...(current.model ? { model: current.model } : {}),
  };
}

function billingFromModelRef(
  ref: string | undefined,
  parentModel?: Model<Api>,
  isProviderUsingOAuth: (providerId: string) => boolean = () => false,
): BillingContext {
  if (!ref) {
    if (parentModel) {
      const authType = isProviderUsingOAuth(parentModel.provider)
        ? "oauth"
        : "api_key";
      return billingForProvider(parentModel.provider, authType);
    }
    return billingForProvider("unknown", "api_key");
  }
  if (ref.startsWith("ollama/")) return billingForProvider("ollama", "local");
  if (ref.startsWith("openai-compatible/")) {
    return billingForProvider("openai-compatible", "local");
  }
  if (ref.startsWith("fusion/") || ref.startsWith("openrouter/")) {
    return billingForProvider("openrouter", "api_key");
  }
  const provider = ref.split("/", 1)[0] || "";
  if (isSubscriptionProvider(provider)) {
    return billingForProvider(
      provider,
      isProviderUsingOAuth(provider) ? "oauth" : "api_key",
    );
  }
  // Bare child model ids do not identify a provider. Inherited models are
  // pinned to canonical refs before execution, so any remaining bare value is
  // ambiguous and must default to payg to protect the project cap.
  return billingForProvider(provider || "unknown", "api_key");
}

/**
 * Child agents and models named inside a `workflowScript`.
 *
 * Since pi-subagents 0.43 the `subagent` tool has one execution surface: a
 * `workflowScript` JavaScript string whose children are declared as
 * `runs.run(key, { agent, ... })`. Top-level `agent` now only addresses
 * management actions, so a structural walk of the tool input no longer sees
 * any child — every check that guards delegation (spend cap, provider
 * support, model inheritance) would silently pass everything through.
 *
 * The script is source text, not data, so this reads the literals rather than
 * pretending to evaluate it. `dynamic` records that at least one `agent:` or
 * `model:` was computed instead of written literally: the target list is then
 * known to be incomplete, which matters for a decision that would override a
 * child's own model but not for a decision that only widens what we check.
 */
export interface WorkflowScriptTargets {
  agents: Set<string>;
  models: Set<string>;
  dynamic: boolean;
}

// A key, then either a plain string literal (captured) or anything else (a
// variable, call, or interpolated template — flagged dynamic and not captured).
const SCRIPT_TARGET_RE =
  /\b(agent|model)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$\\]*)`|(\S))/g;

/** Bounds on a model-authored string: scripts are prompt-sized, not file-sized. */
const MAX_SCRIPT_SCAN_CHARS = 200_000;
const MAX_SCRIPT_TARGETS = 200;

export function workflowScriptTargets(script: string): WorkflowScriptTargets {
  const agents = new Set<string>();
  const models = new Set<string>();
  let dynamic = script.length > MAX_SCRIPT_SCAN_CHARS;
  SCRIPT_TARGET_RE.lastIndex = 0;
  for (const match of script.slice(0, MAX_SCRIPT_SCAN_CHARS).matchAll(SCRIPT_TARGET_RE)) {
    const [, key, doubleQuoted, singleQuoted, backticked, nonLiteral] = match;
    if (nonLiteral !== undefined) {
      dynamic = true;
      continue;
    }
    const raw = doubleQuoted ?? singleQuoted ?? backticked ?? "";
    const value = raw.replace(/\\(.)/g, "$1").trim();
    if (!value) continue;
    const out = key === "agent" ? agents : models;
    if (out.size >= MAX_SCRIPT_TARGETS) {
      dynamic = true;
      continue;
    }
    out.add(value);
  }
  return { agents, models, dynamic };
}

/** Script targets for a tool input, or empty when this is not an execution call. */
function scriptTargets(input: Record<string, unknown>): WorkflowScriptTargets {
  return typeof input.workflowScript === "string"
    ? workflowScriptTargets(input.workflowScript)
    : { agents: new Set(), models: new Set(), dynamic: false };
}

function collectStringFields(
  value: unknown,
  key: "model" | "agent",
  out = new Set<string>(),
): Set<string> {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStringFields(item, key, out);
    return out;
  }
  for (const [field, child] of Object.entries(value as Record<string, unknown>)) {
    if (field === key && typeof child === "string" && child.trim()) out.add(child.trim());
    else collectStringFields(child, key, out);
  }
  return out;
}

function requestedBillings(
  projectId: string,
  input: Record<string, unknown>,
  parentModel?: Model<Api>,
  isProviderUsingOAuth: (providerId: string) => boolean = () => false,
): BillingContext[] {
  const script = scriptTargets(input);
  const explicitModels = collectStringFields(input, "model");
  for (const model of script.models) explicitModels.add(model);
  const billings = [...explicitModels].map((model) =>
    billingFromModelRef(model, parentModel, isProviderUsingOAuth),
  );
  const agents = collectStringFields(input, "agent");
  for (const agent of script.agents) agents.add(agent);
  if (agents.size > 0) {
    const definitions = new Map(
      listAgents(resolvePaths(projectId)).map((agent) => [agent.name, agent] as const),
    );
    for (const name of agents) {
      const model = definitions.get(name)?.model;
      billings.push(
        billingFromModelRef(model, parentModel, isProviderUsingOAuth),
      );
    }
  }
  if (billings.length === 0) {
    billings.push(
      billingFromModelRef(undefined, parentModel, isProviderUsingOAuth),
    );
  }
  return billings;
}

function unsupportedDirectProviders(
  projectId: string,
  input: Record<string, unknown>,
  isProviderUsingOAuth: (providerId: string) => boolean,
): string[] {
  const script = scriptTargets(input);
  const refs = collectStringFields(input, "model");
  for (const model of script.models) refs.add(model);
  const paths = resolvePaths(projectId);
  const definitions = new Map(listAgents(paths).map((agent) => [agent.name, agent] as const));
  const pinned = settingsPinnedModels(paths);
  const agents = collectStringFields(input, "agent");
  for (const agent of script.agents) agents.add(agent);
  for (const name of agents) {
    const model = definitions.get(name)?.model ?? pinned.byAgent.get(name);
    if (model) refs.add(model);
  }
  if (pinned.defaultModel && agents.size > 0) refs.add(pinned.defaultModel);
  return [
    ...new Set(
      [...refs].flatMap((ref) => {
        const provider = ref.split("/", 1)[0] ?? "";
        return isSubscriptionProvider(provider) &&
          !isProviderUsingOAuth(provider)
          ? [provider]
          : [];
      }),
    ),
  ];
}

/**
 * Make parent-model inheritance explicit before pi-subagents builds child CLI
 * arguments. Relying only on Pi's asynchronously persisted global default can
 * race immediately after a model switch and could send a child through the
 * wrong provider. A specialist's own pinned model remains authoritative.
 */
export function pinInheritedChildModels(
  projectId: string,
  input: Record<string, unknown>,
  parentModel: Model<Api> | undefined,
): void {
  if (!parentModel) return;
  const inherited = modelReference(parentModel);
  const paths = resolvePaths(projectId);
  const definitions = new Map(listAgents(paths).map((agent) => [agent.name, agent] as const));
  if (typeof input.workflowScript === "string") {
    pinWorkflowScriptModel(input, inherited, definitions, settingsPinnedModels(paths));
    return;
  }
  const apply = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) apply(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const agent = typeof record.agent === "string" ? record.agent : undefined;
    if (
      agent &&
      record.model === undefined &&
      !definitions.get(agent)?.model
    ) {
      record.model = inherited;
    }
    for (const child of Object.values(record)) apply(child);
  };
  apply(input);

  // SINGLE mode has top-level `agent` and `model`; the recursive pass above
  // handles it. Self-contained single-agent calls may omit `agent`, in which
  // case leaving the model unset is safer than guessing their configuration.
}

/**
 * Pin the parent's model for a `workflowScript` call, where children live in a
 * source string we cannot rewrite. The only lever is the top-level `model`,
 * which pi-subagents forwards to every child as a per-run override — the
 * strongest rank there is. So this pins only after establishing that nothing it
 * would outrank exists: no model literal in the script, no frontmatter or
 * settings model on any named agent, and no `subagents.defaultModel`.
 *
 * A script that computes an agent or model name leaves that list incomplete, so
 * it is left alone. Not pinning is the safe direction: pi-subagents still
 * inherits the live parent model on its own, and the pin exists to make that
 * canonical (notably for Fusion, whose id already carries a provider prefix).
 */
function pinWorkflowScriptModel(
  input: Record<string, unknown>,
  inherited: string,
  definitions: Map<string, { model?: string }>,
  pinned: { defaultModel?: string; byAgent: Map<string, string> },
): void {
  if (input.model !== undefined || pinned.defaultModel) return;
  const targets = workflowScriptTargets(input.workflowScript as string);
  if (targets.dynamic || targets.models.size > 0 || targets.agents.size === 0) return;
  for (const agent of targets.agents) {
    if (definitions.get(agent)?.model || pinned.byAgent.get(agent)) return;
  }
  input.model = inherited;
}

function recordModelAttempts(args: {
  projectId: string;
  sessionId: string;
  attempts: SubagentModelAttempt[] | undefined;
  parentModel?: Model<Api>;
  isProviderUsingOAuth: (providerId: string) => boolean;
}): boolean {
  let recorded = false;
  for (const attempt of args.attempts ?? []) {
    const usage = attempt.usage;
    if (!usage) continue;
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const cost = usage.cost ?? 0;
    if (cost === 0 && input + output + cacheRead + cacheWrite === 0) continue;
    const billing = billingFromModelRef(
      attempt.model,
      args.parentModel,
      args.isProviderUsingOAuth,
    );
    recordSubagentRun(
      args.projectId,
      args.sessionId,
      attempt.model ?? "unknown",
      {
        cost,
        tokens: {
          input,
          output,
          cacheRead,
          total: input + output + cacheRead + cacheWrite,
        },
      },
      billing,
    );
    recorded = true;
  }
  return recorded;
}

// Async completions already ledgered, keyed by run id + child session file.
// Module-level because every live session registers its own listener and
// pi-subagents may deliver the same completion to more than one of them.
const ledgeredAsyncRuns = new Set<string>();
const MAX_LEDGERED_ASYNC_RUNS = 1_000;

/**
 * Budget gate + cost ledger for subagent runs, as a Pi extension.
 *
 * `getSessionId` is lazy because the extension is constructed before the
 * session exists (same holder pattern as the old spawn tool).
 */
export function makeSubagentLedgerExtension(
  projectId: string,
  getSessionId: () => string,
  getParentModel: () => Model<Api> | undefined = () => undefined,
  isProviderUsingOAuth: (providerId: string) => boolean = () => false,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "subagent") return;
      const action =
        typeof event.input.action === "string" ? event.input.action : undefined;
      if (action && action !== "resume") return;
      const budget = isBudgetExceeded(projectId);
      if (action === "resume") {
        // A resume launches fresh model work against an existing child session,
        // but its resolved model is not present in the management payload.
        // Fail closed at the cap rather than assuming the parent's billing.
        if (budget.exceeded) {
          return {
            block: true,
            reason:
              `Delegation resume blocked: the project has reached its spend limit ` +
              `($${budget.totalUsd.toFixed(2)} / $${(budget.limitUsd ?? 0).toFixed(2)}).`,
          };
        }
        return;
      }
      const parentModel = getParentModel();
      pinInheritedChildModels(projectId, event.input, parentModel);
      const unsupportedProviders = unsupportedDirectProviders(
        projectId,
        event.input,
        isProviderUsingOAuth,
      );
      if (unsupportedProviders.length > 0) {
        return {
          block: true,
          reason:
            `Delegation blocked: ${unsupportedProviders.join(", ")} direct models ` +
            `require a connected subscription login in Settings; ambient API keys ` +
            `are not supported for this route.`,
        };
      }
      const hasBillableChild = requestedBillings(
        projectId,
        event.input,
        parentModel,
        isProviderUsingOAuth,
      ).some(billingCountsTowardBudget);
      if (hasBillableChild && budget.exceeded) {
        return {
          block: true,
          reason:
            `Delegation blocked: the project has reached its spend limit ` +
            `($${budget.totalUsd.toFixed(2)} / $${(budget.limitUsd ?? 0).toFixed(2)}). ` +
            `Finish the task without subagents or ask the user to raise the limit.`,
        };
      }
    });

    pi.on("tool_result", async (event) => {
      if (event.toolName !== "subagent") return;
      const details = event.details as SubagentRunDetails | undefined;
      for (const result of details?.results ?? []) {
        const parentModel = getParentModel();
        const sessionUsage = result.sessionFile
          ? usageFromSessionFile(result.sessionFile)
          : null;
        if (result.sessionFile && sessionUsage) {
          rememberSessionUsage(result.sessionFile, sessionUsage);
        }
        if (
          recordModelAttempts({
            projectId,
            sessionId: getSessionId(),
            attempts: result.modelAttempts,
            parentModel,
            isProviderUsingOAuth,
          })
        ) {
          continue;
        }
        const usage = result.usage;
        if (!usage) continue;
        const input = usage.input ?? 0;
        const output = usage.output ?? 0;
        const cacheRead = usage.cacheRead ?? 0;
        const cacheWrite = usage.cacheWrite ?? 0;
        const billing = billingFromModelRef(
          sessionUsage?.provider
            ? `${sessionUsage.provider}/${sessionUsage.model ?? result.model ?? ""}`
            : result.model,
          parentModel,
          isProviderUsingOAuth,
        );
        recordSubagentRun(
          projectId,
          getSessionId(),
          result.model ?? sessionUsage?.model ?? "unknown",
          {
            cost: usage.cost ?? 0,
            tokens: {
              input,
              output,
              cacheRead,
              total: input + output + cacheRead + cacheWrite,
            },
          },
          billing,
        );
      }
    });

    // Async runs bypass the tool_result path (it carries `results: []`), so
    // ledger them from the completion event, reading usage out of each child's
    // session file.
    pi.events.on(ASYNC_COMPLETE_EVENT, (data: unknown) => {
      const payload = data as AsyncCompletePayload;
      for (const [index, result] of (payload.results ?? []).entries()) {
        const key = `${payload.id ?? ""}:${result.sessionFile ?? result.agent ?? index}`;
        if (ledgeredAsyncRuns.has(key)) continue;
        boundedSetAdd(ledgeredAsyncRuns, key, MAX_LEDGERED_ASYNC_RUNS);
        const parentModel = getParentModel();
        if (
          recordModelAttempts({
            projectId,
            sessionId: getSessionId(),
            attempts: result.modelAttempts,
            parentModel,
            isProviderUsingOAuth,
          })
        ) {
          if (result.sessionFile) {
            const cumulative = usageFromSessionFile(result.sessionFile);
            if (cumulative) rememberSessionUsage(result.sessionFile, cumulative);
          }
          continue;
        }
        if (!result.sessionFile) continue;
        const usage = usageDeltaFromSessionFile(result.sessionFile);
        if (usage) {
          const billing = billingFromModelRef(
            usage.provider
              ? `${usage.provider}/${usage.model ?? result.model ?? ""}`
              : result.model,
            parentModel,
            isProviderUsingOAuth,
          );
          recordSubagentRun(
            projectId,
            getSessionId(),
            result.model ?? usage.model ?? "unknown",
            usage,
            billing,
          );
        }
      }
    });
  };
}

/** Tools whose text output can carry a child process's provider error. */
const CHILD_RESULT_TOOLS = new Set(["subagent", "subagent_wait"]);

/**
 * Explain a provider refusal that killed a child agent.
 *
 * A refused child fails inside its own `pi` process, so the only trace that
 * reaches the parent is the runner's text — "Provider finish_reason:
 * content_filter" — inside the tool result. Neither the SSE error frame nor
 * the run route ever sees it, and the lead agent, having no idea what happened,
 * tends to relay it verbatim or retry the same delegation.
 *
 * Appending the guidance to the tool result puts it in front of the lead (so
 * its summary to the user is right) and in the tool output the UI already
 * renders. It is appended, never substituted: the provider's own words stay
 * first so the underlying failure is not obscured.
 */
export function makeSubagentRefusalExtension(
  projectId: string,
  getParentModel: () => Model<Api> | undefined = () => undefined,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", async (event) => {
      if (!CHILD_RESULT_TOOLS.has(event.toolName)) return;
      const refused = event.content.some(
        (part) => part.type === "text" && isProviderRefusal(part.text),
      );
      if (!refused) return;
      const parentModel = getParentModel();
      const note: TextContent = {
        type: "text",
        text:
          `A delegated agent was refused by the model provider.\n\n` +
          providerRefusalGuidance({
            projectId,
            modelRef: parentModel ? modelReference(parentModel) : undefined,
          }),
      };
      return { content: [...event.content, note] };
    });
  };
}
