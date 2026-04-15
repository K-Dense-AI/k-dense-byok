import hljs from "highlight.js";
import katex from "katex";
import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import type { HTMLAttributes, PropsWithChildren, ReactNode } from "react";

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export type MessageProps = HTMLAttributes<HTMLElement> & {
  from: "user" | "assistant";
};

export function Message({ className, from, ...props }: MessageProps) {
  return <article className={cn("message", `message--${from}`, className)} {...props} />;
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export function MessageContent({ className, ...props }: MessageContentProps) {
  return <div className={cn("message__bubble", className)} {...props} />;
}

export type MessageResponseProps = PropsWithChildren<HTMLAttributes<HTMLParagraphElement>>;

export function MessageResponse({ className, children, ...props }: MessageResponseProps) {
  const richContent = renderRichMessage(children);

  if (richContent) {
    return (
      <div
        className={cn("message__content message__content--rich preview-markdown__body", className)}
        dangerouslySetInnerHTML={{ __html: richContent }}
        {...props}
      />
    );
  }

  return (
    <p className={cn("message__content", className)} {...props}>
      {children}
    </p>
  );
}

export function MessageReasoning({ reasoning }: { reasoning: string }) {
  return (
    <details className="message__reasoning" open>
      <summary>Reasoning</summary>
      <div className="message__reasoning-body">{reasoning}</div>
    </details>
  );
}

function renderRichMessage(children: ReactNode) {
  if (typeof children !== "string") {
    return null;
  }

  return getMarkdownRenderer().render(children);
}

let markdownRenderer: MarkdownIt | null = null;

function getMarkdownRenderer() {
  if (markdownRenderer) {
    return markdownRenderer;
  }

  const markdown = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    highlight(code, language) {
      const normalizedLanguage = language.trim().toLowerCase();

      if (normalizedLanguage === "mermaid") {
        return `<pre class="mermaid">${escapeHtml(code)}</pre>`;
      }

      const highlighted = normalizedLanguage && hljs.getLanguage(normalizedLanguage)
        ? hljs.highlight(code, { language: normalizedLanguage }).value
        : escapeHtml(code);

      const codeClass = normalizedLanguage ? ` language-${escapeHtml(normalizedLanguage)}` : "";
      return `<pre class="hljs"><code class="hljs${codeClass}">${highlighted}</code></pre>`;
    },
  });

  markdown.use(texmath, {
    delimiters: "dollars",
    engine: {
      renderToString(expression: string, options?: Record<string, unknown>) {
        return katex.renderToString(expression, {
          ...(options ?? {}),
          output: "mathml",
          throwOnError: false,
          strict: "ignore",
        });
      },
    },
  });

  markdownRenderer = markdown;
  return markdownRenderer;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
