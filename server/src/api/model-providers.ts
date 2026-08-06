import type { FastifyInstance } from "fastify";
import {
  ProviderAuthError,
  ProviderAuthManager,
  SUBSCRIPTION_PROVIDERS,
  isSubscriptionProvider,
  modelForClient,
  nvidiaModelForClient,
  type ProviderAuthRuntime,
} from "../agent/provider-auth.ts";
import { getModelRuntime } from "../agent/session-registry.ts";

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
        const status = await manager.providerStatus(definition.id);
        // These direct-provider entries are intentionally OAuth-only. Ambient
        // API keys remain unsupported product surface rather than being
        // silently presented as subscription access.
        if (status.auth?.type !== "oauth" || status.needsReauth) continue;
        const available = await runtime.getAvailable(definition.id);
        models.push(...available.map((model) => modelForClient(model, definition)));
      }
      return { models };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  // NVIDIA NIM model discovery. API-key-based (not an OAuth subscription
  // provider), so it lives beside — not inside — /model-providers/models.
  // `configured` reflects whether a key resolved (env NVIDIA_API_KEY or a
  // stored Pi credential); the picker hides the section for everyone else.
  app.get("/nvidia/models", async (_req, reply) => {
    try {
      const auth = await runtime.checkAuth("nvidia");
      if (!auth) return { configured: false, models: [] };
      const available = await runtime.getAvailable("nvidia");
      return { configured: true, models: available.map(nvidiaModelForClient) };
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
