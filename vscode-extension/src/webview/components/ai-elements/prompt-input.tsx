import type {
  ChangeEvent,
  FormEvent,
  FormHTMLAttributes,
  HTMLAttributes,
  KeyboardEvent,
  TextareaHTMLAttributes,
} from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export type PromptInputProps = FormHTMLAttributes<HTMLFormElement>;

export function PromptInput({ className, ...props }: PromptInputProps) {
  return <form className={cn("composer-shell prompt-input", className)} {...props} />;
}

export type PromptInputTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  onSubmit?: () => void;
};

export type PromptInputAutosizeLayout = {
  maxHeight: number;
  nextHeight: number;
  overflowY: "auto" | "hidden";
};

export function getPromptInputAutosizeLayout(
  scrollHeight: number,
  viewportHeight: number,
): PromptInputAutosizeLayout {
  const safeViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 720;
  const maxHeight = Math.min(Math.max(Math.floor(safeViewportHeight * 0.24), 120), 176);
  const nextHeight = Math.min(scrollHeight, maxHeight);

  return {
    maxHeight,
    nextHeight,
    overflowY: scrollHeight > maxHeight ? "auto" : "hidden",
  };
}

export function PromptInputTextarea({
  className,
  onChange,
  onKeyDown,
  onSubmit,
  ...props
}: PromptInputTextareaProps) {
  const [isComposing, setIsComposing] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }

    node.style.height = "0px";
    const { nextHeight, overflowY } = getPromptInputAutosizeLayout(
      node.scrollHeight,
      window.innerHeight,
    );
    node.style.height = `${nextHeight}px`;
    node.style.overflowY = overflowY;
  }, [props.value]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) {
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || isComposing || event.nativeEvent.isComposing) {
        return;
      }
      event.preventDefault();
      onSubmit?.();
    },
    [isComposing, onKeyDown, onSubmit],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChange?.(event);
    },
    [onChange],
  );

  return (
    <textarea
      className={cn("composer__input", className)}
      onChange={handleChange}
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      ref={ref}
      rows={3}
      {...props}
    />
  );
}

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>;

export function PromptInputFooter({ className, ...props }: PromptInputFooterProps) {
  return <div className={cn("composer__footer", className)} {...props} />;
}

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export function PromptInputTools({ className, ...props }: PromptInputToolsProps) {
  return <div className={cn("control-strip", className)} {...props} />;
}

export type PromptInputSubmitProps = {
  disabled?: boolean;
  pending?: boolean;
  label: string;
  onClick: () => void;
};

export function PromptInputSubmit({ disabled, pending, label, onClick }: PromptInputSubmitProps) {
  const handleClick = useCallback(
    (event: FormEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (!disabled) {
        onClick();
      }
    },
    [disabled, onClick],
  );

  return (
    <button
      className="button send-button"
      data-chat-send
      disabled={disabled}
      onClick={handleClick}
      type="submit"
    >
      {pending ? "Sending…" : label}
    </button>
  );
}
