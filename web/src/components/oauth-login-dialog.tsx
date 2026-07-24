"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  notifyProviderAuthChanged,
  type ModelProviderStatus,
  type ProviderAuthFlow,
} from "@/lib/use-provider-auth";

interface OAuthLoginDialogProps {
  provider: ModelProviderStatus | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  start: (providerId: ModelProviderStatus["id"]) => Promise<ProviderAuthFlow>;
  poll: (flowId: string) => Promise<ProviderAuthFlow>;
  respond: (
    flowId: string,
    promptId: string,
    value: string,
  ) => Promise<ProviderAuthFlow>;
  cancel: (flowId: string) => Promise<ProviderAuthFlow>;
  onConnected?: () => void;
}

const TERMINAL = new Set<ProviderAuthFlow["status"]>([
  "complete",
  "error",
  "cancelled",
  "expired",
]);

export function OAuthLoginDialog({
  provider,
  open,
  onOpenChange,
  start,
  poll,
  respond,
  cancel,
  onConnected,
}: OAuthLoginDialogProps) {
  const [flow, setFlow] = useState<ProviderAuthFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const startedProviderRef = useRef<string | null>(null);
  const connectedFlowRef = useRef<string | null>(null);
  const cancelWhenStartedRef = useRef(false);
  const mountedRef = useRef(true);
  const flowRef = useRef<ProviderAuthFlow | null>(null);
  const providerId = provider?.id;
  flowRef.current = flow;
  const applyFlow = useCallback((next: ProviderAuthFlow) => {
    setFlow((current) => {
      if (!current || current.id !== next.id) return next;
      if (TERMINAL.has(current.status) && !TERMINAL.has(next.status)) return current;
      return next.updatedAt < current.updatedAt ? current : next;
    });
  }, []);

  const cancelBestEffort = useCallback(
    async (flowId: string) => {
      try {
        await cancel(flowId);
      } catch {
        // Retry once: cancellation is idempotent, and this covers a transient
        // localhost failure while the dialog is closing/unmounting.
        window.setTimeout(() => {
          void cancel(flowId).catch(() => {
            // The backend's bounded expiry is the final cleanup fallback.
          });
        }, 1_000);
      }
    },
    [cancel],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const current = flowRef.current;
      if (current && !TERMINAL.has(current.status)) {
        void cancelBestEffort(current.id);
      } else if (startedProviderRef.current) {
        cancelWhenStartedRef.current = true;
      }
    };
  }, [cancelBestEffort]);

  useEffect(() => {
    if (!open || !providerId) {
      cancelWhenStartedRef.current = true;
      startedProviderRef.current = null;
      connectedFlowRef.current = null;
      setFlow(null);
      setError(null);
      setAnswer("");
      return;
    }
    if (startedProviderRef.current === providerId) {
      // React Strict Mode replays effect setup after a simulated cleanup. The
      // original start request is still authoritative; do not cancel it.
      cancelWhenStartedRef.current = false;
      return;
    }
    startedProviderRef.current = providerId;
    cancelWhenStartedRef.current = false;
    setFlow(null);
    setError(null);
    void start(providerId)
      .then((next) => {
        if (
          cancelWhenStartedRef.current ||
          !mountedRef.current ||
          startedProviderRef.current !== providerId
        ) {
          void cancelBestEffort(next.id);
          return;
        }
        applyFlow(next);
      })
      .catch((cause) => {
        if (mountedRef.current && !cancelWhenStartedRef.current) {
          setError(cause instanceof Error ? cause.message : "Could not start sign-in");
        }
      });
  }, [applyFlow, cancelBestEffort, open, providerId, start]);

  useEffect(() => {
    if (!open || !flow || TERMINAL.has(flow.status)) return;
    let disposed = false;
    let timer: number | undefined;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => void check(), delay);
    };
    const check = async () => {
      try {
        const next = await poll(flow.id);
        if (disposed) return;
        setError(null);
        applyFlow(next);
        if (!TERMINAL.has(next.status)) schedule(700);
      } catch (cause) {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : "Sign-in status failed");
        // Authentication may still be progressing in the backend. Keep
        // polling after transient localhost/network failures.
        schedule(1_500);
      }
    };
    schedule(700);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyFlow, flow?.id, flow?.status, open, poll]);

  useEffect(() => {
    setAnswer("");
  }, [flow?.prompt?.id]);

  useEffect(() => {
    if (flow?.status !== "complete" || connectedFlowRef.current === flow.id) return;
    connectedFlowRef.current = flow.id;
    notifyProviderAuthChanged();
    onConnected?.();
  }, [flow, onConnected]);

  const close = useCallback(
    (nextOpen: boolean) => {
      if (
        !nextOpen &&
        flow &&
        !TERMINAL.has(flow.status)
      ) {
        void cancelBestEffort(flow.id);
      } else if (!nextOpen && !flow) {
        cancelWhenStartedRef.current = true;
      }
      onOpenChange(nextOpen);
    },
    [cancelBestEffort, flow, onOpenChange],
  );

  const submitAnswer = useCallback(
    async (value: string) => {
      if (!flow?.prompt || submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);
      try {
        const next = await respond(flow.id, flow.prompt.id, value);
        setAnswer("");
        applyFlow(next);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not submit response");
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [applyFlow, flow, respond],
  );

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // The visible code/URL remains manually selectable when clipboard access
      // is unavailable.
    }
  }, []);

  const authUrl = flow?.events.findLast((event) => event.type === "auth_url");
  const deviceCode = flow?.events.findLast((event) => event.type === "device_code");
  const latestMessage = flow?.events.findLast(
    (event) => event.type === "progress" || event.type === "info",
  );
  const terminal = flow ? TERMINAL.has(flow.status) : false;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Connect {provider?.accountLabel ?? "subscription"}
          </DialogTitle>
          <DialogDescription>
            Authentication is handled directly by Pi and the provider. Tokens stay
            in Kady&apos;s local credential store.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4" aria-live="polite">
          {!flow && !error ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
              Starting sign-in…
            </div>
          ) : null}

          {error ? (
            <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          ) : null}

          {authUrl?.type === "auth_url" ? (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm">
                {authUrl.instructions ?? "Continue sign-in in your browser."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <a href={authUrl.url} target="_blank" rel="noopener noreferrer">
                    Open sign-in page
                    <ExternalLinkIcon className="size-3.5" aria-hidden />
                  </a>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copy(authUrl.url)}
                >
                  <CopyIcon className="size-3.5" aria-hidden />
                  Copy link
                </Button>
              </div>
            </div>
          ) : null}

          {deviceCode?.type === "device_code" ? (
            <div className="space-y-3 rounded-md border p-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Verification code
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="rounded bg-muted px-3 py-2 text-lg font-semibold tracking-widest">
                    {deviceCode.userCode}
                  </code>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label="Copy verification code"
                    onClick={() => void copy(deviceCode.userCode)}
                  >
                    <CopyIcon className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </div>
              <Button asChild size="sm">
                <a
                  href={deviceCode.verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open verification page
                  <ExternalLinkIcon className="size-3.5" aria-hidden />
                </a>
              </Button>
              {deviceCode.expiresInSeconds ? (
                <p className="text-xs text-muted-foreground">
                  Code expires in about {Math.ceil(deviceCode.expiresInSeconds / 60)} minutes.
                </p>
              ) : null}
            </div>
          ) : null}

          {flow?.prompt?.type === "select" ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{flow.prompt.message}</legend>
              {flow.prompt.options.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-start px-3 py-2 text-left"
                  disabled={submitting}
                  onClick={() => void submitAnswer(option.id)}
                >
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </Button>
              ))}
            </fieldset>
          ) : null}

          {flow?.prompt && flow.prompt.type !== "select" ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitAnswer(answer);
              }}
            >
              <label className="block text-sm font-medium" htmlFor="oauth-answer">
                {flow.prompt.message}
              </label>
              <Input
                id="oauth-answer"
                type={flow.prompt.type === "secret" ? "password" : "text"}
                value={answer}
                autoComplete="off"
                placeholder={flow.prompt.placeholder}
                onChange={(event) => setAnswer(event.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                disabled={
                  submitting ||
                  (flow.prompt.type !== "text" && !answer.trim())
                }
              >
                {submitting ? "Submitting…" : "Continue"}
              </Button>
            </form>
          ) : null}

          {flow?.status === "running" && !flow.prompt ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
              <span>
                {latestMessage && "message" in latestMessage
                  ? latestMessage.message
                  : "Waiting for provider confirmation…"}
              </span>
            </div>
          ) : null}

          {flow?.status === "complete" ? (
            <div className="flex gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2Icon className="size-4 shrink-0" aria-hidden />
              <span>{provider?.accountLabel} connected successfully.</span>
            </div>
          ) : null}

          {flow && flow.status !== "complete" && terminal ? (
            <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircleIcon className="size-4 shrink-0" aria-hidden />
              <span>
                {flow.error ??
                  (flow.status === "cancelled"
                    ? "Sign-in was cancelled."
                    : "Sign-in expired. Start again.")}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            variant={flow?.status === "complete" ? "default" : "outline"}
            onClick={() => close(false)}
          >
            {flow?.status === "complete" ? "Done" : terminal || error ? "Close" : "Cancel"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
