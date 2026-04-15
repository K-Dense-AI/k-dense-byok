import type { HTMLAttributes } from "react";
import { useEffect, useRef } from "react";

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

const CONVERSATION_FOLLOW_THRESHOLD_PX = 48;

export type ConversationScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function isConversationNearBottom({
  scrollTop,
  scrollHeight,
  clientHeight,
}: ConversationScrollMetrics): boolean {
  return scrollHeight - clientHeight - scrollTop <= CONVERSATION_FOLLOW_THRESHOLD_PX;
}

export type ConversationProps = HTMLAttributes<HTMLDivElement>;

export function Conversation({ className, children, ...props }: ConversationProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const shouldFollowRef = useRef(true);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }

    const handleScroll = () => {
      shouldFollowRef.current = isConversationNearBottom(node);
    };

    node.addEventListener("scroll", handleScroll);

    return () => {
      node.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node || !shouldFollowRef.current) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [children]);

  return (
    <div className={cn("conversation-frame", className)} ref={ref} role="log" {...props}>
      {children}
    </div>
  );
}

export type ConversationContentProps = HTMLAttributes<HTMLDivElement>;

export function ConversationContent({ className, ...props }: ConversationContentProps) {
  return <div className={cn("message-list", className)} {...props} />;
}

export type ConversationEmptyStateProps = HTMLAttributes<HTMLDivElement> & {
  title?: string;
  description?: string;
};

export function ConversationEmptyState({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  ...props
}: ConversationEmptyStateProps) {
  return (
    <div className={cn("empty-state", className)} {...props}>
      <p className="empty-state__title">{title}</p>
      <p className="empty-state__copy">{description}</p>
    </div>
  );
}
