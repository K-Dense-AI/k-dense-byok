"use client";

import { HardDriveIcon, KeyRoundIcon, LogInIcon, PlugZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openSettings } from "@/lib/settings-nav";

/**
 * First-run guidance for a chat with nowhere to send it: shown in the empty
 * conversation when no model source (OpenRouter, a subscription, a direct
 * key, a local server) is usable. Each action lands on the matching part of
 * Settings → Providers.
 */
export function ConnectModelCard() {
  return (
    <div
      className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-xl border bg-card p-5 text-center"
      data-testid="connect-model-card"
    >
      <PlugZapIcon className="size-6 text-muted-foreground" aria-hidden />
      <div>
        <h3 className="text-sm font-medium">Connect a model to get started</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Kady brings your own model access. Sign in with a subscription you already have, paste an
          API key, or run a model locally — credentials stay on this machine.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" className="text-xs" onClick={() => openSettings({ tab: "providers", section: "subscriptions" })}>
          <LogInIcon className="size-3.5" />
          Sign in with a subscription
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-xs"
          onClick={() => openSettings({ tab: "providers", section: "api-keys" })}
        >
          <KeyRoundIcon className="size-3.5" />
          Add an API key
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-xs"
          onClick={() => openSettings({ tab: "providers", section: "local-servers" })}
        >
          <HardDriveIcon className="size-3.5" />
          Use a local model
        </Button>
      </div>
    </div>
  );
}
