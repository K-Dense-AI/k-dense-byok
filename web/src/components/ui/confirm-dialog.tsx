"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title: string;
  /** Body text. Newlines render as paragraph breaks. */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive (red) action. */
  destructive?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

/**
 * An in-app replacement for `window.confirm`. The native dialog is unstyled,
 * ignores the app's theme, and — critically — blocks the whole renderer,
 * which is jarring for a long-running scientific workspace. `useConfirm`
 * returns an async `confirm()` that resolves true/false once the user picks,
 * plus the `<ConfirmDialog/>` element to drop into the component's tree.
 *
 * Usage:
 *   const { confirm, dialog } = useConfirm();
 *   if (await confirm({ title: "Delete project?", destructive: true })) …
 *   return <>{dialog}…</>;
 */
export function useConfirm() {
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...options, resolve });
      }),
    [],
  );

  const settle = React.useCallback(
    (confirmed: boolean) => {
      setPending((current) => {
        current?.resolve(confirmed);
        return null;
      });
    },
    [],
  );

  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        // Any dismissal that isn't the confirm button is a cancel.
        if (!open) settle(false);
      }}
    >
      {pending && (
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pending.title}</DialogTitle>
            {pending.description && (
              <DialogDescription className="whitespace-pre-line leading-relaxed">
                {pending.description}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              {pending.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={pending.destructive ? "destructive" : "default"}
              onClick={() => settle(true)}
              autoFocus
            >
              {pending.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );

  return { confirm, dialog };
}
