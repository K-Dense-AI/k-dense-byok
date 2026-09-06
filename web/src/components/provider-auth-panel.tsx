"use client";

import { useMemo, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  LoaderCircleIcon,
  LogInIcon,
  LogOutIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  useProviderAuth,
  type ModelProviderStatus,
} from "@/lib/use-provider-auth";

export function ProviderAuthPanel() {
  const auth = useProviderAuth();
  const [selectedId, setSelectedId] = useState<ModelProviderStatus["id"] | null>(
    null,
  );
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const selected = useMemo(
    () => auth.providers.find((provider) => provider.id === selectedId) ?? null,
    [auth.providers, selectedId],
  );

  const disconnect = async (provider: ModelProviderStatus) => {
    const ok = await confirm({
      title: `Disconnect ${provider.accountLabel}?`,
      description:
        "Existing chats remain on disk, but new requests through this provider will stop working until you reconnect.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    setDisconnecting(provider.id);
    setActionError(null);
    try {
      await auth.logout(provider.id);
      await auth.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Disconnect failed");
    } finally {
      setDisconnecting(null);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {dialog}
      <div>
        <h3 className="text-sm font-medium">Model providers</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Connect an existing AI subscription. OAuth tokens stay in Kady&apos;s
          local Pi credential store, which is used by the lead agent and its
          specialist processes. OpenRouter and optional service keys remain
          under API keys.
        </p>
      </div>

      {(auth.error || actionError) ? (
        <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircleIcon className="size-4 shrink-0" aria-hidden />
          <span>{actionError ?? auth.error}</span>
        </div>
      ) : null}

      {auth.loading && auth.providers.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
          Loading providers…
        </div>
      ) : (
        <div className="space-y-3">
          {auth.providers.map((provider) => (
            <section key={provider.id} className="rounded-lg border p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-medium">{provider.name}</h4>
                    <Badge
                      variant={
                        provider.needsReauth
                          ? "destructive"
                          : provider.connected
                            ? "default"
                            : "secondary"
                      }
                    >
                      {provider.needsReauth
                        ? "Reconnect required"
                        : provider.connected
                          ? "Connected"
                          : "Not connected"}
                    </Badge>
                    <Badge variant="outline">
                      {provider.billingMode === "metered_oauth"
                        ? "Metered extra usage"
                        : "Subscription managed"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs font-medium text-muted-foreground">
                    {provider.accountLabel}
                  </p>
                  <p
                    className={
                      provider.billingMode === "metered_oauth"
                        ? "mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400"
                        : "mt-2 text-xs leading-relaxed text-muted-foreground"
                    }
                  >
                    {provider.billingNote}
                  </p>
                  {provider.connected ? (
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2Icon className="size-3.5" aria-hidden />
                      {provider.modelCount} model
                      {provider.modelCount === 1 ? "" : "s"} available
                    </p>
                  ) : null}
                </div>

                {provider.connected ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={disconnecting === provider.id}
                    onClick={() => void disconnect(provider)}
                    aria-label={`Disconnect ${provider.accountLabel}`}
                  >
                    {disconnecting === provider.id ? (
                      <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <LogOutIcon className="size-3.5" aria-hidden />
                    )}
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      setActionError(null);
                      setSelectedId(provider.id);
                    }}
                    aria-label={`${provider.needsReauth ? "Reconnect" : "Connect"} ${provider.accountLabel}`}
                  >
                    <LogInIcon className="size-3.5" aria-hidden />
                    {provider.needsReauth ? "Reconnect" : "Connect"}
                  </Button>
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Provider subscriptions have their own quotas and overage rules. Except
        for Anthropic&apos;s documented metered extra usage, Kady records tokens
        but does not treat provider-managed subscription usage as project spend.
      </p>

      <OAuthLoginDialog
        provider={selected}
        open={selectedId !== null}
        onOpenChange={(next) => {
          if (!next) setSelectedId(null);
        }}
        start={auth.start}
        poll={auth.poll}
        respond={auth.respond}
        cancel={auth.cancel}
        onConnected={() => void auth.refresh()}
      />
    </div>
  );
}
