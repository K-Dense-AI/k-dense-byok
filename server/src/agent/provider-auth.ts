import crypto from "node:crypto";
import type {
  Api,
  AuthCheck,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  CredentialInfo,
  Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const SUBSCRIPTION_PROVIDER_IDS = [
  "openai-codex",
  "anthropic",
  "github-copilot",
  "xai",
] as const;

export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];
export type ProviderBillingMode = "metered_oauth" | "subscription";

export interface SubscriptionProviderDefinition {
  id: SubscriptionProviderId;
  name: string;
  accountLabel: string;
  billingMode: ProviderBillingMode;
  billingNote: string;
}

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProviderDefinition[] = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    accountLabel: "ChatGPT Plus/Pro",
    billingMode: "subscription",
    billingNote:
      "Uses provider-managed ChatGPT subscription limits. Kady cannot read remaining quota or overages.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    accountLabel: "Claude Pro/Max",
    billingMode: "metered_oauth",
    billingNote:
      "Pi documents third-party Claude subscription use as extra usage billed per token.",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    accountLabel: "GitHub Copilot subscription",
    billingMode: "subscription",
    billingNote:
      "Uses provider-managed Copilot limits. Kady cannot read remaining premium requests or overages.",
  },
  {
    id: "xai",
    name: "xAI",
    accountLabel: "SuperGrok or X Premium",
    billingMode: "subscription",
    billingNote:
      "Uses provider-managed xAI subscription limits. Kady cannot read remaining quota or overages.",
  },
] as const;

const PROVIDER_BY_ID = new Map(
  SUBSCRIPTION_PROVIDERS.map((provider) => [provider.id, provider] as const),
);

export function isSubscriptionProvider(value: string): value is SubscriptionProviderId {
  return PROVIDER_BY_ID.has(value as SubscriptionProviderId);
}

export function subscriptionProvider(
  providerId: string,
): SubscriptionProviderDefinition | undefined {
  return PROVIDER_BY_ID.get(providerId as SubscriptionProviderId);
}

export type ProviderAuthRuntime = Pick<
  ModelRuntime,
  | "login"
  | "logout"
  | "checkAuth"
  | "getAuth"
  | "listCredentials"
  | "getAvailable"
  | "getProvider"
>;

export type PublicAuthEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export type PublicAuthPrompt =
  | {
      id: string;
      type: "text" | "secret" | "manual_code";
      message: string;
      placeholder?: string;
    }
  | {
      id: string;
      type: "select";
      message: string;
      options: { id: string; label: string; description?: string }[];
    };

export type AuthFlowStatus =
  | "running"
  | "awaiting_input"
  | "complete"
  | "error"
  | "cancelled"
  | "expired";

export interface AuthFlowSnapshot {
  id: string;
  providerId: SubscriptionProviderId;
  status: AuthFlowStatus;
  events: PublicAuthEvent[];
  prompt?: PublicAuthPrompt;
  error?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface PendingPrompt {
  id: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface AuthFlow extends AuthFlowSnapshot {
  controller: AbortController;
  running: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
  pending?: PendingPrompt;
  expiryTimer?: NodeJS.Timeout;
  removalTimer?: NodeJS.Timeout;
}

const MAX_EVENTS = 20;
const MAX_RESPONSE_LENGTH = 64 * 1024;
const DEFAULT_FLOW_TTL_MS = 20 * 60_000;
const TERMINAL_RETENTION_MS = 5 * 60_000;

function truncate(value: string | undefined, max = 4_096): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function safeUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Provider returned an unsupported authentication URL");
  }
  return parsed.toString();
}

function publicEvent(event: AuthEvent): PublicAuthEvent {
  switch (event.type) {
    case "info":
      return {
        type: "info",
        message: truncate(event.message) ?? "",
        ...(event.links?.length
          ? {
              links: event.links.slice(0, 10).map((link) => ({
                url: safeUrl(link.url),
                ...(link.label ? { label: truncate(link.label, 256) } : {}),
              })),
            }
          : {}),
      };
    case "auth_url":
      return {
        type: "auth_url",
        url: safeUrl(event.url),
        ...(event.instructions
          ? { instructions: truncate(event.instructions) }
          : {}),
      };
    case "device_code":
      return {
        type: "device_code",
        userCode: truncate(event.userCode, 512) ?? "",
        verificationUri: safeUrl(event.verificationUri),
        ...(event.intervalSeconds !== undefined
          ? { intervalSeconds: event.intervalSeconds }
          : {}),
        ...(event.expiresInSeconds !== undefined
          ? { expiresInSeconds: event.expiresInSeconds }
          : {}),
      };
    case "progress":
      return { type: "progress", message: truncate(event.message) ?? "" };
  }
}

function publicPrompt(prompt: AuthPrompt, id: string): PublicAuthPrompt {
  if (prompt.type === "select") {
    return {
      id,
      type: "select",
      message: truncate(prompt.message) ?? "",
      options: prompt.options.slice(0, 20).map((option) => ({
        id: truncate(option.id, 256) ?? "",
        label: truncate(option.label, 512) ?? "",
        ...(option.description
          ? { description: truncate(option.description, 2_048) }
          : {}),
      })),
    };
  }
  return {
    id,
    type: prompt.type,
    message: truncate(prompt.message) ?? "",
    ...(prompt.placeholder
      ? { placeholder: truncate(prompt.placeholder, 2_048) }
      : {}),
  };
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    truncate(
      raw
        .replace(
          /("(?:access_token|refresh_token|access|refresh)"\s*:\s*")[^"]+(")/gi,
          "$1[redacted]$2",
        )
        .replace(/([?&](?:code|token)=)[^&\s]+/gi, "$1[redacted]")
        .replace(/\b(?:sk|eyJ)[A-Za-z0-9._-]{16,}\b/g, "[redacted]"),
      1_000,
    ) || "Authentication failed"
  );
}

function cloneSnapshot(flow: AuthFlow): AuthFlowSnapshot {
  return {
    id: flow.id,
    providerId: flow.providerId,
    status: flow.status,
    events: flow.events.map((event) => structuredClone(event)),
    ...(flow.prompt ? { prompt: structuredClone(flow.prompt) } : {}),
    ...(flow.error ? { error: flow.error } : {}),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    expiresAt: flow.expiresAt,
  };
}

function isTerminal(status: AuthFlowStatus): boolean {
  return (
    status === "complete" ||
    status === "error" ||
    status === "cancelled" ||
    status === "expired"
  );
}

export class ProviderAuthManager {
  private readonly flows = new Map<string, AuthFlow>();
  private readonly activeByProvider = new Map<SubscriptionProviderId, string>();

  constructor(
    private readonly runtime: ProviderAuthRuntime,
    private readonly flowTtlMs = DEFAULT_FLOW_TTL_MS,
  ) {}

  getRuntime(): ProviderAuthRuntime {
    return this.runtime;
  }

  async providerStatus(providerId: SubscriptionProviderId): Promise<{
    auth: AuthCheck | undefined;
    stored: CredentialInfo | undefined;
    needsReauth: boolean;
  }> {
    const [auth, credentials] = await Promise.all([
      this.runtime.checkAuth(providerId),
      this.runtime.listCredentials(),
    ]);
    let needsReauth = false;
    if (auth?.type === "oauth") {
      try {
        needsReauth = !(await this.runtime.getAuth(providerId));
      } catch {
        needsReauth = true;
      }
    }
    return {
      auth,
      stored: credentials.find((credential) => credential.providerId === providerId),
      needsReauth,
    };
  }

  async start(providerId: string): Promise<AuthFlowSnapshot> {
    if (!isSubscriptionProvider(providerId)) {
      throw new ProviderAuthError(400, `Unsupported subscription provider: ${providerId}`);
    }
    const configured = await this.providerStatus(providerId);
    if (configured.auth?.type === "oauth" && !configured.needsReauth) {
      throw new ProviderAuthError(
        409,
        `${subscriptionProvider(providerId)?.name ?? providerId} is already connected`,
      );
    }
    if (configured.needsReauth) await this.runtime.logout(providerId);
    const activeId = this.activeByProvider.get(providerId);
    if (activeId) {
      const active = this.flows.get(activeId);
      if (active?.running) {
        throw new ProviderAuthError(
          409,
          `A ${subscriptionProvider(providerId)?.name ?? providerId} login is already in progress`,
        );
      }
      this.activeByProvider.delete(providerId);
    }

    const now = Date.now();
    let resolveSettled = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const flow: AuthFlow = {
      id: crypto.randomUUID(),
      providerId,
      status: "running",
      events: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.flowTtlMs,
      controller: new AbortController(),
      running: true,
      settled,
      resolveSettled,
    };
    flow.expiryTimer = setTimeout(() => this.expire(flow.id), this.flowTtlMs);
    flow.expiryTimer.unref?.();
    this.flows.set(flow.id, flow);
    this.activeByProvider.set(providerId, flow.id);

    void this.run(flow);
    return cloneSnapshot(flow);
  }

  get(flowId: string): AuthFlowSnapshot {
    const flow = this.requireFlow(flowId);
    if (!isTerminal(flow.status) && Date.now() >= flow.expiresAt) {
      this.expire(flow.id);
    }
    return cloneSnapshot(flow);
  }

  respond(flowId: string, promptId: string, value: string): AuthFlowSnapshot {
    const flow = this.requireFlow(flowId);
    if (flow.status !== "awaiting_input" || !flow.pending || !flow.prompt) {
      throw new ProviderAuthError(409, "This authentication flow is not awaiting input");
    }
    if (flow.pending.id !== promptId || flow.prompt.id !== promptId) {
      throw new ProviderAuthError(409, "That authentication prompt is stale");
    }
    if (typeof value !== "string" || value.length > MAX_RESPONSE_LENGTH) {
      throw new ProviderAuthError(400, "Authentication response is invalid or too large");
    }

    const pending = flow.pending;
    flow.pending = undefined;
    flow.prompt = undefined;
    flow.status = "running";
    flow.updatedAt = Date.now();
    pending.resolve(value);
    return cloneSnapshot(flow);
  }

  cancel(flowId: string): AuthFlowSnapshot {
    const flow = this.requireFlow(flowId);
    if (!isTerminal(flow.status)) {
      this.finish(flow, "cancelled");
      flow.controller.abort();
      flow.pending?.reject(new Error("Login cancelled"));
      flow.pending = undefined;
      flow.prompt = undefined;
    }
    return cloneSnapshot(flow);
  }

  async logout(providerId: string): Promise<void> {
    if (!isSubscriptionProvider(providerId)) {
      throw new ProviderAuthError(400, `Unsupported subscription provider: ${providerId}`);
    }
    const activeId = this.activeByProvider.get(providerId);
    if (activeId) {
      const flow = this.flows.get(activeId);
      if (flow) {
        this.cancel(activeId);
        // Pi persists the returned credential after the provider login
        // resolves. Wait for that mutation before deleting so a late write
        // cannot silently undo logout.
        await flow.settled;
      }
    }
    await this.runtime.logout(providerId);
  }

  dispose(): void {
    for (const flow of this.flows.values()) {
      if (!isTerminal(flow.status)) {
        flow.controller.abort();
        flow.pending?.reject(new Error("Login cancelled"));
      }
      if (flow.expiryTimer) clearTimeout(flow.expiryTimer);
      if (flow.removalTimer) clearTimeout(flow.removalTimer);
    }
    this.flows.clear();
    this.activeByProvider.clear();
  }

  private requireFlow(flowId: string): AuthFlow {
    const flow = this.flows.get(flowId);
    if (!flow) throw new ProviderAuthError(404, "No such authentication flow");
    return flow;
  }

  private async run(flow: AuthFlow): Promise<void> {
    const interaction: AuthInteraction = {
      signal: flow.controller.signal,
      notify: (event) => {
        if (isTerminal(flow.status)) return;
        try {
          flow.events.push(publicEvent(event));
          if (flow.events.length > MAX_EVENTS) {
            flow.events.splice(0, flow.events.length - MAX_EVENTS);
          }
          flow.updatedAt = Date.now();
        } catch (error) {
          this.fail(flow, error);
        }
      },
      prompt: (prompt) => this.waitForPrompt(flow, prompt),
    };

    try {
      await this.runtime.login(flow.providerId, "oauth", interaction);
      if (!isTerminal(flow.status)) {
        this.finish(flow, "complete");
      } else {
        // Cancel/expiry/error may race a provider that ignores AbortSignal and
        // returns a credential anyway. Login persists before resolving, so
        // remove that late write while this provider's active slot is held.
        await this.runtime.logout(flow.providerId);
      }
    } catch (error) {
      if (!isTerminal(flow.status)) this.fail(flow, error);
    } finally {
      flow.running = false;
      flow.resolveSettled();
      if (this.activeByProvider.get(flow.providerId) === flow.id) {
        this.activeByProvider.delete(flow.providerId);
      }
      this.scheduleRemoval(flow);
    }
  }

  private waitForPrompt(flow: AuthFlow, prompt: AuthPrompt): Promise<string> {
    if (flow.controller.signal.aborted || prompt.signal?.aborted) {
      return Promise.reject(new Error("Login cancelled"));
    }
    if (flow.pending) {
      return Promise.reject(new Error("Provider requested overlapping authentication prompts"));
    }

    const promptId = crypto.randomUUID();
    flow.prompt = publicPrompt(prompt, promptId);
    flow.status = "awaiting_input";
    flow.updatedAt = Date.now();

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        flow.controller.signal.removeEventListener("abort", onAbort);
        prompt.signal?.removeEventListener("abort", onAbort);
      };
      const settleResolve = (value: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (flow.pending?.id === promptId) flow.pending = undefined;
        if (flow.prompt?.id === promptId) flow.prompt = undefined;
        reject(error);
      };
      const onAbort = () => settleReject(new Error("Login cancelled"));
      flow.controller.signal.addEventListener("abort", onAbort, { once: true });
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      flow.pending = {
        id: promptId,
        resolve: settleResolve,
        reject: settleReject,
      };
    });
  }

  private expire(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow || isTerminal(flow.status)) return;
    this.finish(flow, "expired", "Authentication flow expired");
    flow.controller.abort();
    flow.pending?.reject(new Error("Authentication flow expired"));
    flow.pending = undefined;
    flow.prompt = undefined;
  }

  private fail(flow: AuthFlow, error: unknown): void {
    this.finish(flow, "error", safeError(error));
    flow.controller.abort();
    flow.pending?.reject(new Error("Authentication failed"));
    flow.pending = undefined;
    flow.prompt = undefined;
  }

  private finish(flow: AuthFlow, status: AuthFlowStatus, error?: string): void {
    if (isTerminal(flow.status)) return;
    flow.status = status;
    flow.error = error;
    flow.updatedAt = Date.now();
    flow.prompt = undefined;
    if (flow.expiryTimer) {
      clearTimeout(flow.expiryTimer);
      flow.expiryTimer = undefined;
    }
  }

  private scheduleRemoval(flow: AuthFlow): void {
    if (flow.removalTimer) return;
    flow.removalTimer = setTimeout(() => {
      this.flows.delete(flow.id);
    }, TERMINAL_RETENTION_MS);
    flow.removalTimer.unref?.();
  }
}

export class ProviderAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

function tierFor(model: Model<Api>): "budget" | "mid" | "high" | "flagship" {
  if (model.cost.output >= 20) return "flagship";
  if (model.cost.output >= 10) return "high";
  if (model.cost.output >= 3) return "mid";
  return "budget";
}

export interface ClientProviderModel {
  id: string;
  label: string;
  provider: string;
  sourceId: SubscriptionProviderId;
  sourceLabel: string;
  tier: "budget" | "mid" | "high" | "flagship";
  context_length: number;
  pricing: { prompt: number; completion: number };
  modality: string;
  description: string;
  reasoning: boolean;
  billingMode: ProviderBillingMode;
  available: true;
}

export function modelForClient(
  model: Model<Api>,
  definition: SubscriptionProviderDefinition,
): ClientProviderModel {
  return {
    id: `${definition.id}/${model.id}`,
    label: model.name,
    provider: definition.name,
    sourceId: definition.id,
    sourceLabel: definition.accountLabel,
    tier: tierFor(model),
    context_length: model.contextWindow,
    pricing: {
      prompt: model.cost.input,
      completion: model.cost.output,
    },
    modality: model.input.includes("image") ? "text+image->text" : "text->text",
    description: `${definition.name} via ${definition.accountLabel}`,
    reasoning: model.reasoning,
    billingMode: definition.billingMode,
    available: true,
  };
}

export interface ClientNvidiaModel
  extends Omit<ClientProviderModel, "sourceId" | "billingMode"> {
  sourceId: "nvidia";
  billingMode: "subscription";
}

/**
 * NVIDIA NIM is an API-key provider, deliberately NOT in
 * SUBSCRIPTION_PROVIDERS (no OAuth flow; the key is NVIDIA_API_KEY, managed by
 * /credentials). It still bills like the subscription providers — usage draws
 * NVIDIA-managed API credits that Kady cannot meter — so its picker entries
 * carry billingMode "subscription", matching `billingForProvider("nvidia")`.
 */
export function nvidiaModelForClient(model: Model<Api>): ClientNvidiaModel {
  return {
    id: `nvidia/${model.id}`,
    label: model.name,
    provider: "NVIDIA",
    sourceId: "nvidia",
    sourceLabel: "NVIDIA NIM",
    tier: tierFor(model),
    context_length: model.contextWindow,
    pricing: {
      prompt: model.cost.input,
      completion: model.cost.output,
    },
    modality: model.input.includes("image") ? "text+image->text" : "text->text",
    description: "NVIDIA NIM (build.nvidia.com) via NVIDIA API credits",
    reasoning: model.reasoning,
    billingMode: "subscription",
    available: true,
  };
}

export interface ClientEdenaiModel
  extends Omit<ClientProviderModel, "sourceId" | "billingMode"> {
  sourceId: "edenai";
  billingMode: "payg";
}

/**
 * Eden AI, like NVIDIA, is an API-key provider outside SUBSCRIPTION_PROVIDERS
 * (the key is EDENAI_API_KEY, managed by /credentials). Its billing is the
 * opposite of NIM's, though: Eden charges real per-token USD, published in its
 * own model catalogue, so entries carry billingMode "payg" and the usage counts
 * against the project spend cap — matching `billingForProvider("edenai")`.
 *
 * Descriptions are kept short on purpose: this list is ~850 models, it is
 * re-fetched whenever the picker opens, and the picker renders the label,
 * provider, context window, and price rather than the description.
 */
export function edenaiModelForClient(model: Model<Api>): ClientEdenaiModel {
  return {
    id: `edenai/${model.id}`,
    label: model.name,
    provider: "Eden AI",
    sourceId: "edenai",
    sourceLabel: "Eden AI",
    tier: tierFor(model),
    context_length: model.contextWindow,
    pricing: {
      prompt: model.cost.input,
      completion: model.cost.output,
    },
    modality: model.input.includes("image") ? "text+image->text" : "text->text",
    description: `Eden AI gateway → ${model.id}`,
    reasoning: model.reasoning,
    billingMode: "payg",
    available: true,
  };
}
