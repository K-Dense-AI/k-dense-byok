"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 1000,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

/**
 * True when the trigger currently owns an open popover / dropdown / dialog.
 * Radix's Popover, DropdownMenu and Dialog triggers all stamp
 * `aria-expanded` on the element they render, and because every trigger in
 * this app composes via `asChild`, the tooltip trigger and the overlay
 * trigger end up on the same DOM node.
 */
function triggerIsExpanded(el: EventTarget | null): boolean {
  return el instanceof Element && el.getAttribute("aria-expanded") === "true"
}

/**
 * Radix's tooltip trigger opens on any `pointermove` and on any `focus`.
 * Two of those paths make a tooltip pile up on top of the very UI the user
 * just opened:
 *
 * 1. Hovering (or drifting back over) a trigger whose menu/popover is open
 *    draws the hint over the open menu.
 * 2. When a menu, popover or dialog closes, Radix returns focus to the
 *    trigger programmatically; the resulting `focus` event opens the tooltip
 *    even though the user only clicked.
 *
 * Radix's own handlers honour `event.defaultPrevented`, so we veto the
 * hover path while the trigger is expanded and the focus path unless the
 * focus is keyboard-driven (`:focus-visible`), which keeps the hint for
 * people tabbing through the UI.
 */
function TooltipTrigger({
  onPointerMove,
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onPointerMove={(event) => {
        onPointerMove?.(event)
        if (!event.defaultPrevented && triggerIsExpanded(event.currentTarget)) {
          event.preventDefault()
        }
      }}
      onFocus={(event) => {
        onFocus?.(event)
        if (event.defaultPrevented) return
        const target = event.currentTarget
        let keyboardFocus = false
        try {
          keyboardFocus = target.matches(":focus-visible")
        } catch {
          // Older engines without :focus-visible: fall back to Radix's default.
          keyboardFocus = true
        }
        if (!keyboardFocus || triggerIsExpanded(target)) {
          event.preventDefault()
        }
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
