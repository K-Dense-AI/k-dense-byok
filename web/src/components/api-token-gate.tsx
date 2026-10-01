"use client";

/**
 * Asks for the backend access token when the server demands one (see
 * lib/api-auth.ts). Invisible on a default install: it only opens after a
 * request comes back 401 with `X-Kady-Auth: required`.
 */
import { useEffect, useState } from "react";
import { KeyRoundIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AUTH_REQUIRED_EVENT, getApiToken, setApiToken } from "@/lib/api-auth";

export function ApiTokenGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [hadToken, setHadToken] = useState(false);

  useEffect(() => {
    const onRequired = () => {
      setHadToken(Boolean(getApiToken()));
      setOpen(true);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired);
  }, []);

  const submit = () => {
    if (!value.trim()) return;
    setApiToken(value);
    // Every hook re-fetches with the token on a clean load.
    window.location.reload();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-4" /> Access token required
          </DialogTitle>
          <DialogDescription>
            {hadToken
              ? "The Kady server rejected the saved access token (it changes each time Kady restarts unless KADY_AUTH_TOKEN is set). "
              : "This Kady server is protected with an access token. "}
            Open the link printed in the terminal that started Kady, or paste the
            link or token here.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://localhost:3000/#kady-token=… or the token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Access token"
          />
        </form>
        <DialogFooter>
          <Button onClick={submit} disabled={!value.trim()}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
