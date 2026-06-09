"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import {
  KeyIcon,
  PaletteIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
} from "lucide-react";

function ApiKeysPanel() {
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">API keys</h3>
        <p className="text-xs text-muted-foreground mt-1">
          K-Dense BYOK is bring-your-own-key. All model and tool calls use the
          keys defined in your{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">.env</code>{" "}
          file and run on your own machine — nothing is sent to K-Dense.
        </p>
      </div>

      <div className="rounded-lg border px-3 py-2.5 text-xs text-muted-foreground leading-relaxed">
        To add or change a key, edit{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">.env</code> in
        the project root (for example{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
          OPENROUTER_API_KEY
        </code>
        ) and restart the app. Keys are read from the environment at startup and
        never leave your device.
      </div>
    </div>
  );
}

function AppearancePanel() {
  const { theme, setTheme } = useTheme();

  const options: { value: string; label: string; icon: typeof SunIcon }[] = [
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
    { value: "system", label: "System", icon: MonitorIcon },
  ];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">Appearance</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Choose how K-Dense BYOK looks. System follows your operating
          system&apos;s theme.
        </p>
      </div>

      <div className="flex gap-2">
        {options.map((opt) => {
          const Icon = opt.icon;
          const active = theme === opt.value;
          return (
            <Button
              key={opt.value}
              variant={active ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme(opt.value)}
              className={cn("flex-1 gap-1.5 text-xs")}
            >
              <Icon className="size-3.5" />
              {opt.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "sm:max-w-2xl h-[min(560px,80dvh)] flex flex-col gap-0 p-0 overflow-hidden"
        )}
      >
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="text-xs">
            Configure your workspace preferences.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          defaultValue="api-keys"
          orientation="vertical"
          className="flex-1 min-h-0 flex flex-row gap-0"
        >
          <TabsList
            variant="line"
            className="w-44 shrink-0 border-r rounded-none px-2 py-3 items-start justify-start"
          >
            <TabsTrigger
              value="api-keys"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <KeyIcon className="size-3.5" />
              API keys
            </TabsTrigger>
            <TabsTrigger
              value="appearance"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <PaletteIcon className="size-3.5" />
              Appearance
            </TabsTrigger>
          </TabsList>

          <TabsContent value="api-keys" className="flex-1 min-h-0 p-5">
            <ApiKeysPanel />
          </TabsContent>
          <TabsContent value="appearance" className="flex-1 min-h-0 p-5">
            <AppearancePanel />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
