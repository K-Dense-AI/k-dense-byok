import type { FastifyInstance } from "fastify";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  ProviderAuthError,
  ProviderAuthManager,
  SUBSCRIPTION_PROVIDERS,
  directModelForClient,
  isSubscriptionProvider,
  modelForClient,
  type ProviderAuthRuntime,
} from "../agent/provider-auth.ts";
import {
  DIRECT_PROVIDERS,
  directProvider,
  type DirectProviderDefinition,
} from "../agent/provider-catalog.ts";
import { buildNvidiaModel, nvidiaExtraModelIds } from "../agent/models.ts";
import { getModelRuntime } from "../agent/session-registry.ts";
import { credentialFieldFor } from "./credentials.ts";

export interface RegisterModelProviderRoutesOptions {
  manager?: ProviderAuthManager;
  runtime?: ProviderAuthRuntime;
}

function errorReply(
  reply: { code(statusCode: number): unknown },
  error: unknown,
): { detail: string } {
  if (error instanceof ProviderAuthError) {
    reply.code(error.status);
    return { detail: error.message };
  }
  reply.code(500);
  return {
    detail: error instanceof Error ? error.message : "Model-provider operation failed",
  };
}

/** A configuration field of a direct provider, as the Settings UI renders it. */
export interface DirectProviderField {
  envVar: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  hint?: string;
  /** Primary API key (vs. supporting configuration). */
  isKey: boolean;
  /** Key into `GET /credentials` and the `PUT /credentials` body. */
  credentialId: string;
  bodyField: string;
}

export interface DirectProviderStatus {
  id: string;
  name: string;
  sectionLabel: string;
  hint: string;
  keysUrl?: string;
  billingMode: DirectProviderDefinition["billingMode"];
  billingNote: string;
  /** Also connectable under Settings → Model providers. */
  oauth: boolean;
  fields: DirectProviderField[];
  /** Pi resolved a credential for this provider (key, cloud creds, or OAuth). */
  configured: boolean;
  authType: "api_key" | "oauth" | null;
  /** Pi's label for where the credential came from, e.g. "ANTHROPIC_API_KEY". */
  source: string | null;
  modelCount: number;
}

function providerFields(definition: DirectProviderDefinition): DirectProviderField[] {
  const fields: DirectProviderField[] = [];
  const push = (
    envVar: string,
    base: Omit<DirectProviderField, "envVar" | "credentialId" | "bodyField">,
  ) => {
    const credential = credentialFieldFor(envVar);
    // Every catalogue env var is a managed credential by construction; a miss
    // would be a wiring bug, and hiding the field is the visible failure.
    if (!credential) return;
    fields.push({ envVar, ...base, ...credential });
  };
  if (definition.keyEnvVar) {
    push(definition.keyEnvVar, {
      label: definition.keyLabel,
      secret: true,
      required: definition.extraEnv.every((f) => !f.required) && definition.runtimeKey,
      placeholder: definition.keyPlaceholder,
      isKey: true,
    });
  }
  for (const field of definition.extraEnv) {
    push(field.envVar, {
      label: field.label,
      secret: field.secret,
      required: field.required,
      placeholder: field.placeholder,
      hint: field.hint,
      isKey: false,
    });
  }
  return fields;
}

async function safeCheckAuth(runtime: ProviderAuthRuntime, providerId: string) {
  try {
    return await runtime.checkAuth(providerId);
  } catch {
    // A provider whose ambient check throws (e.g. a malformed AWS profile) is
    // reported unconfigured; the next run surfaces the real error.
    return undefined;
  }
}

/**
 * Models for one configured direct provider, picker-shaped. NVIDIA additionally
 * appends `NVIDIA_EXTRA_MODELS` ids Pi's catalogue doesn't know (private/EA
 * endpoints), synthesized like the resolver does; catalogued ids win.
 */
async function directProviderModels(
  runtime: ProviderAuthRuntime,
  definition: DirectProviderDefinition,
): Promise<ReturnType<typeof directModelForClient>[]> {
  const available = await runtime.getAvailable(definition.id);
  const models: Model<Api>[] = [...available];
  if (definition.id === "nvidia") {
    const catalogued = new Set(available.map((model) => model.id));
    for (const id of nvidiaExtraModelIds()) {
      if (!catalogued.has(id)) models.push(buildNvidiaModel(id));
    }
  }
  return models.map((model) => directModelForClient(model, definition));
}

export async function registerModelProviderRoutes(
  app: FastifyInstance,
  options: RegisterModelProviderRoutesOptions = {},
): Promise<void> {
  const runtime = options.runtime ?? getModelRuntime();
  const manager = options.manager ?? new ProviderAuthManager(runtime);

  app.addHook("onClose", async () => {
    manager.dispose();
  });

  app.get("/model-providers", async (_req, reply) => {
    try {
      const providers = await Promise.all(
        SUBSCRIPTION_PROVIDERS.map(async (definition) => {
          const status = await manager.providerStatus(definition.id);
          const connected =
            status.auth?.type === "oauth" && !status.needsReauth;
          let modelCount = 0;
          if (connected) {
            try {
              modelCount = (await runtime.getAvailable(definition.id)).length;
            } catch {
              // A stale/expired token is still reported as configured. The next
              // request surfaces the OAuth error and the UI offers re-login.
            }
          }
          const provider = runtime.getProvider(definition.id);
          return {
            ...definition,
            connected,
            needsReauth: status.needsReauth,
            credentialType: status.stored?.type ?? status.auth?.type ?? null,
            source: status.auth?.source ?? null,
            loginLabel: provider?.auth.oauth?.loginLabel ?? null,
            modelCount,
            // Lets the UI say "or paste a key under API keys" for dual providers.
            apiKeyAlternative: directProvider(definition.id) !== undefined ||
              definition.id === "openrouter",
          };
        }),
      );
      return { providers };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.get("/model-providers/models", async (_req, reply) => {
    try {
      const models: ReturnType<typeof modelForClient>[] = [];
      for (const definition of SUBSCRIPTION_PROVIDERS) {
        // OpenRouter's rows come from the static catalogue; listing Pi's copy
        // here would show every model twice.
        if (!definition.listModels) continue;
        const status = await manager.providerStatus(definition.id);
        // Only OAuth-connected providers are listed here. A provider that also
        // takes an API key (anthropic, xai, kimi-coding) is listed by
        // /providers/models instead when it is key-configured, so each model
        // appears once, under the billing its credential implies.
        if (status.auth?.type !== "oauth" || status.needsReauth) continue;
        const available = await runtime.getAvailable(definition.id);
        models.push(...available.map((model) => modelForClient(model, definition)));
      }
      return { models };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  // Every direct (API-key / cloud-credential) provider Kady exposes, with its
  // Settings fields and whether Pi currently resolves a credential for it.
  // Never carries secrets: field values come from GET /credentials (masked).
  app.get("/providers", async (_req, reply) => {
    try {
      const providers: DirectProviderStatus[] = await Promise.all(
        DIRECT_PROVIDERS.map(async (definition) => {
          const auth = await safeCheckAuth(runtime, definition.id);
          let modelCount = 0;
          if (auth) {
            try {
              modelCount = (await runtime.getAvailable(definition.id)).length;
            } catch {
              // Configured but unlistable (network/refresh error): still shown
              // as configured so the user knows the key was picked up.
            }
          }
          return {
            id: definition.id,
            name: definition.name,
            sectionLabel: definition.sectionLabel,
            hint: definition.hint,
            keysUrl: definition.keysUrl,
            billingMode: definition.billingMode,
            billingNote: definition.billingNote,
            oauth: definition.oauth,
            fields: providerFields(definition),
            configured: auth !== undefined,
            authType: auth?.type ?? null,
            source: auth?.source ?? null,
            modelCount,
          };
        }),
      );
      return { providers };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  // Picker rows for every key-configured direct provider in one call, plus the
  // full id list so the picker can tell "provider not configured" from "ref
  // with an unknown prefix". A provider Pi resolved through OAuth is skipped:
  // /model-providers/models already lists it under its subscription billing.
  app.get("/providers/models", async (_req, reply) => {
    try {
      const providers: { id: string; configured: boolean }[] = [];
      const models: ReturnType<typeof directModelForClient>[] = [];
      for (const definition of DIRECT_PROVIDERS) {
        const auth = await safeCheckAuth(runtime, definition.id);
        providers.push({ id: definition.id, configured: auth !== undefined });
        if (!auth) continue;
        if (auth.type === "oauth" && isSubscriptionProvider(definition.id)) continue;
        try {
          models.push(...(await directProviderModels(runtime, definition)));
        } catch {
          // One provider's listing failure must not hide every other section.
        }
      }
      return { providers, models };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  // NVIDIA NIM model discovery — kept as an alias of the generic route for
  // older clients. `configured` reflects whether a key resolved (env
  // NVIDIA_API_KEY or a stored Pi credential).
  app.get("/nvidia/models", async (_req, reply) => {
    try {
      const definition = directProvider("nvidia")!;
      const auth = await safeCheckAuth(runtime, "nvidia");
      if (!auth) return { configured: false, models: [] };
      return {
        configured: true,
        models: await directProviderModels(runtime, definition),
      };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post<{ Body: { providerId?: string } | null }>(
    "/model-auth/flows",
    async (req, reply) => {
      try {
        const providerId = req.body?.providerId;
        if (!providerId) {
          reply.code(400);
          return { detail: "providerId is required" };
        }
        reply.code(202);
        return await manager.start(providerId);
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/model-auth/flows/:id",
    async (req, reply) => {
      try {
        return manager.get(req.params.id);
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { promptId?: string; value?: string } | null;
  }>("/model-auth/flows/:id/respond", async (req, reply) => {
    try {
      if (!req.body?.promptId || typeof req.body.value !== "string") {
        reply.code(400);
        return { detail: "promptId and string value are required" };
      }
      return manager.respond(req.params.id, req.body.promptId, req.body.value);
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/model-auth/flows/:id",
    async (req, reply) => {
      try {
        return manager.cancel(req.params.id);
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.delete<{ Params: { providerId: string } }>(
    "/model-providers/:providerId/credential",
    async (req, reply) => {
      try {
        if (!isSubscriptionProvider(req.params.providerId)) {
          throw new ProviderAuthError(
            400,
            `Unsupported subscription provider: ${req.params.providerId}`,
          );
        }
        await manager.logout(req.params.providerId);
        return { ok: true };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );
}
