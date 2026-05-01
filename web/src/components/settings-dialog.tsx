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
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  useBrowserUseSettings,
  useChromeProfiles,
  useCustomMcps,
  useMcpStatus,
  type McpServerStatus,
} from "@/lib/use-settings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import CodeMirror from "@uiw/react-codemirror";
import { loadLanguage } from "@uiw/codemirror-extensions-langs";
import { githubLight, githubDark } from "@uiw/codemirror-theme-github";
import { useTheme } from "next-themes";
import {
  ServerIcon,
  GlobeIcon,
  ChromeIcon,
  CheckIcon,
  LoaderCircleIcon,
  AlertCircleIcon,
  InfoIcon,
  LogInIcon,
  LogOutIcon,
  TerminalIcon,
  ExternalLinkIcon,
} from "lucide-react";

const jsonLang = loadLanguage("json");
const cmExtensions = jsonLang ? [jsonLang] : [];

function formatExpiry(epochSeconds: number | null | undefined): string | null {
  if (!epochSeconds) return null;
  const ms = epochSeconds * 1000;
  const diff = ms - Date.now();
  if (diff <= 0) return "expired";
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function McpServerRow({
  server,
  onSignIn,
  onSignOut,
  pendingAuthUrl,
  isSigningIn,
  signOutBusy,
}: {
  server: McpServerStatus;
  onSignIn: (name: string) => void;
  onSignOut: (name: string) => void;
  pendingAuthUrl: string | null;
  isSigningIn: boolean;
  signOutBusy: boolean;
}) {
  const isHttp = server.transport === "http";
  const expiresLabel = formatExpiry(server.tokenInfo?.expiresAt ?? null);

  return (
    <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            {isHttp ? (
              <GlobeIcon className="size-3.5 text-muted-foreground" />
            ) : (
              <TerminalIcon className="size-3.5 text-muted-foreground" />
            )}
            <span className="truncate">{server.name}</span>
            {server.builtin && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                built-in
              </span>
            )}
          </div>
          {server.url && (
            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
              {server.url}
            </div>
          )}
          {server.signedIn === true && (
            <div className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5 flex items-center gap-1">
              <CheckIcon className="size-3" />
              Signed in
              {expiresLabel ? (
                <span className="text-muted-foreground">
                  · token valid {expiresLabel}
                </span>
              ) : null}
            </div>
          )}
          {server.signedIn === false && server.needsAuth && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
              Sign-in required
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isHttp && server.signedIn === true && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onSignOut(server.name)}
              disabled={signOutBusy}
              className="h-7 text-[11px]"
            >
              {signOutBusy ? (
                <LoaderCircleIcon className="size-3 animate-spin" />
              ) : (
                <LogOutIcon className="size-3" />
              )}
              Sign out
            </Button>
          )}
          {isHttp && server.signedIn === false && (
            <Button
              size="sm"
              onClick={() => onSignIn(server.name)}
              disabled={isSigningIn}
              className="h-7 text-[11px]"
            >
              {isSigningIn ? (
                <LoaderCircleIcon className="size-3 animate-spin" />
              ) : (
                <LogInIcon className="size-3" />
              )}
              Sign in
            </Button>
          )}
        </div>
      </div>

      {pendingAuthUrl && (
        <div className="flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-2.5 py-2 text-[11px]">
          <InfoIcon className="size-3.5 shrink-0 mt-px text-blue-500" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">Open the auth URL to finish</div>
            <div className="text-muted-foreground mt-0.5">
              We tried to open it in a new tab. If nothing opened, click below:
            </div>
            <a
              href={pendingAuthUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400 break-all"
            >
              <ExternalLinkIcon className="size-3 shrink-0" />
              <span className="truncate">{pendingAuthUrl}</span>
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function McpServersPanel() {
  const mcps = useCustomMcps();
  const status = useMcpStatus();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [pendingAuthUrls, setPendingAuthUrls] = useState<Record<string, string>>(
    {},
  );
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState<string | null>(null);
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
      // Custom MCP edits can change the set of HTTP servers; refresh status.
      status.refresh();
    }
  }, [mcps, draft, status]);

  const handleSignIn = useCallback(
    async (name: string) => {
      setSigningIn(name);
      const url = await status.signIn(name);
      setSigningIn(null);
      if (!url) return;
      setPendingAuthUrls((prev) => ({ ...prev, [name]: url }));
      // Best-effort browser tab open. Popup blockers may swallow this --
      // the link in the row is the user-clickable fallback.
      try {
        window.open(url, "_blank", "noopener,noreferrer");
      } catch {
        /* ignored */
      }
    },
    [status],
  );

  const handleSignOut = useCallback(
    async (name: string) => {
      setSigningOut(name);
      await status.signOut(name);
      setSigningOut(null);
      setPendingAuthUrls((prev) => {
        const { [name]: _, ...rest } = prev;
        return rest;
      });
    },
    [status],
  );

  // Poll status while there's an in-flight auth so the row flips to
  // "Signed in" once the OAuth callback writes the token. Stops polling
  // as soon as every pending server reports signedIn=true.
  useEffect(() => {
    const pendingNames = Object.keys(pendingAuthUrls);
    if (pendingNames.length === 0) return;
    const interval = window.setInterval(() => {
      status.refresh();
    }, 2000);
    return () => window.clearInterval(interval);
  }, [pendingAuthUrls, status]);

  // Clear pending URLs once their server reports signedIn=true.
  useEffect(() => {
    const pendingNames = Object.keys(pendingAuthUrls);
    if (pendingNames.length === 0) return;
    const finished = pendingNames.filter(
      (name) => status.servers.find((s) => s.name === name)?.signedIn === true,
    );
    if (finished.length > 0) {
      setPendingAuthUrls((prev) => {
        const next = { ...prev };
        for (const name of finished) delete next[name];
        return next;
      });
    }
  }, [status.servers, pendingAuthUrls]);

  const isDirty = draft !== mcps.value;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">MCP Servers</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Tools the agent can call. HTTP servers may require sign-in;
          stdio servers run as local subprocesses.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {status.loading ? (
          <div className="flex items-center text-xs text-muted-foreground">
            <LoaderCircleIcon className="mr-2 size-3.5 animate-spin" />
            Loading servers...
          </div>
        ) : status.servers.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            No MCP servers configured.
          </div>
        ) : (
          status.servers.map((server) => (
            <McpServerRow
              key={server.name}
              server={server}
              onSignIn={handleSignIn}
              onSignOut={handleSignOut}
              pendingAuthUrl={pendingAuthUrls[server.name] ?? null}
              isSigningIn={signingIn === server.name}
              signOutBusy={signingOut === server.name}
            />
          ))
        )}
        {status.error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircleIcon className="size-3.5 shrink-0" />
            {status.error}
          </div>
        )}
      </div>

      <details className="rounded-lg border" open={false}>
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium hover:bg-muted/40">
          Custom MCP servers (advanced)
        </summary>
        <div className="flex flex-col gap-3 p-3 pt-2">
          <p className="text-[11px] text-muted-foreground">
            JSON object merged on top of the defaults. Each key becomes
            a server entry visible in the list above.
          </p>
          <div className="h-48 rounded-lg border overflow-hidden">
            {mcps.loading ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
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
      </details>
    </div>
  );
}

function BrowserUsePanel() {
  const bu = useBrowserUseSettings();
  const profiles = useChromeProfiles();
  const [sessionDraft, setSessionDraft] = useState("");
  const [savedSession, setSavedSession] = useState(false);
  const [advancedProfileDraft, setAdvancedProfileDraft] = useState("");

  useEffect(() => {
    if (!bu.loading) {
      setSessionDraft(bu.config.session ?? "");
      setAdvancedProfileDraft(bu.config.profile ?? "");
    }
  }, [bu.loading, bu.config.session, bu.config.profile]);

  const usingRealChrome = Boolean(bu.config.profile);
  const sessionDirty = (bu.config.session ?? "") !== sessionDraft.trim();
  const advancedProfileDirty =
    usingRealChrome &&
    (bu.config.profile ?? "") !== advancedProfileDraft.trim() &&
    advancedProfileDraft.trim() !== "";

  const handleSaveSession = useCallback(async () => {
    const next = sessionDraft.trim();
    const ok = await bu.save({ session: next === "" ? null : next });
    if (ok) {
      setSavedSession(true);
      setTimeout(() => setSavedSession(false), 2000);
    }
  }, [bu, sessionDraft]);

  const toggleRealChrome = useCallback(
    async (on: boolean) => {
      if (on) {
        const first = profiles.profiles[0]?.id ?? "Default";
        await bu.save({ profile: first, headed: true });
      } else {
        await bu.save({ profile: null });
      }
    },
    [bu, profiles.profiles],
  );

  const selectedProfile = profiles.profiles.find(
    (p) => p.id === bu.config.profile,
  );
  const profileInDetected = Boolean(selectedProfile);

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">Browser automation</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Let the agent drive a browser through the{" "}
          <a
            href="https://docs.browser-use.com/open-source/browser-use-cli"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            browser-use CLI
          </a>
          . Tools like navigate, click, type, screenshot, and eval are exposed
          to both Kady and the expert agent when enabled.
        </p>
      </div>

      {bu.loading ? (
        <div className="flex items-center text-sm text-muted-foreground">
          <LoaderCircleIcon className="mr-2 size-4 animate-spin" />
          Loading...
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-xs font-medium">
                Enable browser automation
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                Registers the browser-use MCP server for the current project.
              </div>
            </div>
            <Switch
              checked={bu.config.enabled}
              onCheckedChange={(v) => bu.save({ enabled: Boolean(v) })}
              disabled={bu.saving}
            />
          </div>

          <div
            className={cn(
              "flex flex-col gap-3 rounded-lg border px-3 py-2.5",
              !bu.config.enabled && "opacity-50",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <ChromeIcon className="size-3.5 text-muted-foreground" />
                  Use my real Chrome (with logins)
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Attach to your installed Chrome so the agent inherits your
                  cookies, sessions, and extensions. Off = a fresh sandboxed
                  Chromium with no history.
                </div>
              </div>
              <Switch
                checked={usingRealChrome}
                onCheckedChange={toggleRealChrome}
                disabled={bu.saving || !bu.config.enabled}
              />
            </div>

            {usingRealChrome && (
              <>
                <div className="flex items-start justify-between gap-3 border-t pt-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium">Chrome profile</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {profiles.loading
                        ? "Detecting profiles..."
                        : profiles.profiles.length === 0
                          ? "No Chrome profiles detected. You can still type a profile directory name below."
                          : "Pick which of your Chrome profiles to attach to."}
                    </div>
                  </div>
                  {profiles.profiles.length > 0 && (
                    <Select
                      value={profileInDetected ? bu.config.profile ?? "" : ""}
                      onValueChange={(v) => bu.save({ profile: v })}
                      disabled={bu.saving || !bu.config.enabled}
                    >
                      <SelectTrigger className="w-48 h-8 text-xs shrink-0">
                        <SelectValue placeholder="Pick profile" />
                      </SelectTrigger>
                      <SelectContent>
                        {profiles.profiles.map((p) => (
                          <SelectItem
                            key={p.id}
                            value={p.id}
                            className="text-xs"
                          >
                            <div className="flex flex-col items-start">
                              <span className="font-medium">{p.name}</span>
                              {p.email && p.email !== p.name ? (
                                <span className="text-[10px] text-muted-foreground">
                                  {p.email}
                                </span>
                              ) : null}
                              <span className="text-[10px] text-muted-foreground/70">
                                folder: {p.id}
                              </span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                <details className="text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">
                    Advanced: type a profile directory name
                  </summary>
                  <div className="mt-2 flex items-center gap-2">
                    <Input
                      value={advancedProfileDraft}
                      onChange={(e) =>
                        setAdvancedProfileDraft(e.target.value)
                      }
                      placeholder='e.g. "Default" or "Profile 1"'
                      disabled={bu.saving || !bu.config.enabled}
                      className="h-8 text-xs"
                    />
                    <Button
                      size="sm"
                      onClick={() =>
                        bu.save({
                          profile: advancedProfileDraft.trim() || null,
                        })
                      }
                      disabled={bu.saving || !advancedProfileDirty}
                    >
                      Save
                    </Button>
                  </div>
                </details>

                <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                  <InfoIcon className="size-3.5 shrink-0 mt-px" />
                  <span>
                    Close Chrome before sending a task, or the agent will fail
                    to acquire the profile's user-data lock. The window will
                    launch headed so you can watch the agent work.
                  </span>
                </div>
              </>
            )}
          </div>

          <div
            className={cn(
              "flex items-center justify-between rounded-lg border px-3 py-2.5",
              (!bu.config.enabled || usingRealChrome) && "opacity-50",
            )}
          >
            <div className="min-w-0">
              <div className="text-xs font-medium">Show browser window</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {usingRealChrome
                  ? "Real Chrome always shows its window."
                  : "Launch Chromium with a visible window. Off = headless."}
              </div>
            </div>
            <Switch
              checked={usingRealChrome ? true : bu.config.headed}
              onCheckedChange={(v) => bu.save({ headed: Boolean(v) })}
              disabled={bu.saving || !bu.config.enabled || usingRealChrome}
            />
          </div>

          <div
            className={cn(
              "flex flex-col gap-2 rounded-lg border px-3 py-2.5",
              !bu.config.enabled && "opacity-50",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">Persistent session</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Optional. Keeps the browser alive across turns under a named
                  session (e.g. <code>kady</code>). Leave blank for a fresh
                  browser per turn.
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={sessionDraft}
                onChange={(e) => setSessionDraft(e.target.value)}
                placeholder='e.g. "kady"'
                disabled={bu.saving || !bu.config.enabled}
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                onClick={handleSaveSession}
                disabled={bu.saving || !sessionDirty || !bu.config.enabled}
              >
                {bu.saving ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : savedSession ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {bu.error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          {bu.error}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground mt-auto">
        Chromium is downloaded once via <code>prep_sandbox.py</code>. Changes
        apply to the next message.
      </p>
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
            <TabsTrigger
              value="browser"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <GlobeIcon className="size-3.5" />
              Browser
            </TabsTrigger>
          </TabsList>

          <TabsContent value="mcps" className="flex-1 min-h-0 p-5">
            <McpServersPanel />
          </TabsContent>
          <TabsContent value="browser" className="flex-1 min-h-0 p-5">
            <BrowserUsePanel />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
