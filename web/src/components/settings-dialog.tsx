"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useCustomMcps } from "@/lib/use-settings";
import { cn } from "@/lib/utils";
import CodeMirror from "@uiw/react-codemirror";
import { loadLanguage } from "@uiw/codemirror-extensions-langs";
import { githubLight, githubDark } from "@uiw/codemirror-theme-github";
import { useTheme } from "next-themes";
import {
  ServerIcon,
  CheckIcon,
  LoaderCircleIcon,
  AlertCircleIcon,
} from "lucide-react";

const jsonLang = loadLanguage("json");
const cmExtensions = jsonLang ? [jsonLang] : [];

function McpServersPanel() {
  const mcps = useCustomMcps();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!mcps.loading) {
      setDraft(mcps.value);
    }
  }, [mcps.loading, mcps.value]);

  const handleSave = useCallback(async () => {
    const ok = await mcps.save(draft);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }, [mcps, draft]);

  const isDirty = draft !== mcps.value;

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium">Custom MCP Servers</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Add MCP servers that will be merged with the defaults (docling,
          parallel-search). Define each server as a key in the JSON object.
        </p>
      </div>

      <div className="flex-1 min-h-0 rounded-lg border overflow-hidden">
        {mcps.loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <LoaderCircleIcon className="mr-2 size-4 animate-spin" />
            Loading...
          </div>
        ) : (
          <CodeMirror
            value={draft}
            onChange={setDraft}
            extensions={cmExtensions}
            theme={resolvedTheme === "dark" ? githubDark : githubLight}
            height="100%"
            className="h-full text-xs [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
            placeholder='{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "my-mcp-server"]\n  }\n}'
          />
        )}
      </div>

      {mcps.error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          {mcps.error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          Changes apply to the next message.
        </p>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={mcps.saving || mcps.loading || !isDirty}
        >
          {mcps.saving ? (
            <>
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              Saving...
            </>
          ) : saved ? (
            <>
              <CheckIcon className="size-3.5" />
              Saved
            </>
          ) : (
            "Save"
          )}
        </Button>
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
          defaultValue="mcps"
          orientation="vertical"
          className="flex-1 min-h-0 flex flex-row gap-0"
        >
          <TabsList
            variant="line"
            className="w-44 shrink-0 border-r rounded-none px-2 py-3 items-start justify-start"
          >
            <TabsTrigger
              value="mcps"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <ServerIcon className="size-3.5" />
              MCP Servers
            </TabsTrigger>
          </TabsList>

          <TabsContent value="mcps" className="flex-1 min-h-0 p-5">
            <McpServersPanel />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
