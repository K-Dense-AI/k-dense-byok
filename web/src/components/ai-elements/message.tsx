"use client";

import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes, ReactElement } from "react";

import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { normalizeMarkdown } from "@/lib/markdown-text";
import { API_BASE, useProjectScopeId } from "@/lib/projects";
import { withApiToken } from "@/lib/api-auth";
import { sandboxMarkdownUrls } from "@/lib/sandbox-markdown";
import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import "katex/dist/katex.min.css";
import { mermaid } from "@streamdown/mermaid";
import { ChevronLeftIcon, ChevronRightIcon, WorkflowIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  asJavaScriptFence,
  parseWorkflowFence,
  workflowScriptAgents,
} from "@/lib/workflow-script";
import {
  type ReactNode,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Block, Streamdown, defaultRehypePlugins, type BlockProps } from "streamdown";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange]
  );

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children]
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  onOpenFile?: (path: string) => void;
};

const OpenMarkdownFileContext = createContext<((path: string) => void) | undefined>(undefined);

function SandboxLink({ href, children, node: _node, ...rest }: Record<string, unknown> & { children?: ReactNode; href?: string; node?: unknown }) {
  const onOpenFile = useContext(OpenMarkdownFileContext);
  const path = rest["data-kady-file"];
  return (
    <a
      {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      href={href}
      className="font-medium text-primary underline underline-offset-4"
      target="_blank"
      rel="noopener noreferrer"
      onClick={typeof path === "string" && onOpenFile ? (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpenFile(path);
      } : undefined}
    >
      {children}
    </a>
  );
}

const math = createMathPlugin({ singleDollarTextMath: true });
const streamdownPlugins = { cjk, code, math, mermaid };

const linkSafetyOff = { enabled: false } as const;

function hasImageChild(children: ReactNode): boolean {
  const arr: ReactNode[] = Array.isArray(children) ? children : [children];
  return arr.some(
    (c) =>
      isValidElement(c) &&
      (c.props as Record<string, unknown>)?.node &&
      ((c.props as Record<string, unknown>).node as { tagName?: string })
        ?.tagName === "img"
  );
}

const SafeParagraph = memo(
  ({ children, node, ...rest }: Record<string, unknown> & { children?: ReactNode; node?: unknown }) => {
    const kids = (Array.isArray(children) ? children : [children]).filter(
      (c) => c != null && c !== ""
    ) as ReactNode[];

    if (kids.length === 1 && isValidElement(kids[0])) {
      const tag = (kids[0].props as Record<string, unknown>)?.node as { tagName?: string } | undefined;
      if (tag?.tagName === "img") return <>{children}</>;
      if (tag?.tagName === "code" && "data-block" in (kids[0].props as Record<string, unknown>))
        return <>{children}</>;
    }

    if (hasImageChild(children)) {
      return <div {...(rest as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>;
    }

    return <p {...(rest as React.HTMLAttributes<HTMLParagraphElement>)}>{children}</p>;
  }
);
SafeParagraph.displayName = "SafeParagraph";

/**
 * Resolve a sandbox-relative image src (e.g. `plots/fig.png`, `./out.svg`,
 * `user_data/x.png`) to the backend raw-file endpoint so figures the agent
 * writes render inline. Absolute URLs (http/data/blob) and root-absolute paths
 * pass through untouched.
 */
function resolveImageSrc(src: unknown): string | undefined {
  if (typeof src !== "string" || !src) return undefined;
  if (/^(https?:|data:|blob:|\/\/)/i.test(src) || src.startsWith("/")) return src;
  const clean = src.replace(/^\.\//, "");
  return withApiToken(`${API_BASE}/sandbox/raw?path=${encodeURIComponent(clean)}`);
}

const SandboxImage = memo(
  ({ src, alt, node: _node, ...rest }: Record<string, unknown> & { src?: unknown; alt?: string; node?: unknown }) => {
    const resolved = resolveImageSrc(src);
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={resolved}
        alt={typeof alt === "string" ? alt : ""}
        className="my-2 max-w-full rounded-md border"
        loading="lazy"
        {...(rest as React.ImgHTMLAttributes<HTMLImageElement>)}
      />
    );
  }
);
SandboxImage.displayName = "SandboxImage";

/**
 * Streamdown block renderer that folds a pi-subagents workflow script — the
 * ```js workflow fence the agent writes before `subagent({ workflow: true })`
 * — into a collapsed "Workflow script" disclosure. Expanded, it is the normal
 * highlighted JavaScript block; every other block renders unchanged.
 */
const WorkflowAwareBlock = memo((props: BlockProps) => {
  const [open, setOpen] = useState(false);
  const fence = parseWorkflowFence(props.content);
  if (!fence) return <Block {...props} />;
  const agents = workflowScriptAgents(fence.body);
  const lines = fence.body.split("\n").filter((line) => line.trim()).length;
  const detail = agents.length > 0
    ? agents.join(" · ")
    : `${lines} line${lines === 1 ? "" : "s"}`;
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-streamdown="workflow-script">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/60">
        <ChevronRightIcon
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">Workflow script</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {fence.closed && !props.isIncomplete ? detail : "writing…"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Block {...props} content={asJavaScriptFence(props.content, fence)} />
      </CollapsibleContent>
    </Collapsible>
  );
});
WorkflowAwareBlock.displayName = "WorkflowAwareBlock";

const streamdownComponents = {
  p: SafeParagraph,
  img: SandboxImage,
  a: SandboxLink,
} as unknown as ComponentProps<typeof Streamdown>["components"];

export const MessageResponse = memo(
  ({ className, children, onOpenFile, ...props }: MessageResponseProps) => {
    const projectId = useProjectScopeId();
    const rehypePlugins = useMemo(() => [
      defaultRehypePlugins.raw,
      defaultRehypePlugins.sanitize,
      sandboxMarkdownUrls(projectId),
      defaultRehypePlugins.harden,
    ], [projectId]);
    return (
      <OpenMarkdownFileContext.Provider value={onOpenFile}>
        <Streamdown
          className={cn(
            "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            className
          )}
          components={streamdownComponents}
          BlockComponent={WorkflowAwareBlock}
          rehypePlugins={rehypePlugins}
          linkSafety={linkSafetyOff}
          plugins={streamdownPlugins}
          {...props}
        >
          {typeof children === "string" ? normalizeMarkdown(children) : children}
        </Streamdown>
      </OpenMarkdownFileContext.Provider>
    );
  },
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
