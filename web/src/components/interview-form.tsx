"use client";

/**
 * Inline interview form — the chat-side half of the backend `interview` tool
 * (server/src/agent/interview.ts, modeled on pi.dev/packages/pi-interview).
 *
 * The agent's tool call arrives as a `tool_start` SSE frame whose args carry
 * the full question payload; this component renders the form inside the
 * assistant message and POSTs the structured answers to
 * `/sessions/:id/interview/:toolCallId`, which unblocks the agent's run.
 */
import { CheckIcon, ClipboardListIcon, UploadIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { API_BASE, apiFetch } from "@/lib/projects";
import type { ActivityItem } from "@/lib/use-agent";
import { cn } from "@/lib/utils";

// Mirrors the backend caps in server/src/agent/interview.ts.
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface InterviewOption {
  label: string;
  content?: string;
}

export interface InterviewMedia {
  type: "image" | "table" | "chart" | "mermaid" | "html";
  src?: string;
  headers?: string[];
  rows?: string[][];
  config?: unknown;
  caption?: string;
}

export interface InterviewQuestion {
  id: string;
  type: "single" | "multi" | "text" | "image" | "info";
  question: string;
  options?: (string | InterviewOption)[];
  recommended?: string | string[];
  conviction?: "strong" | "slight";
  weight?: "critical" | "minor";
  context?: string;
  content?: { source: string; lang?: string; file?: string };
  media?: InterviewMedia | InterviewMedia[];
}

export interface InterviewPayload {
  title: string;
  description?: string;
  questions: InterviewQuestion[];
}

interface UploadedImage {
  name: string;
  dataUrl: string;
  mimeType: string;
}

/** Parse tool args into a payload; null when they don't look like one. */
export function parseInterviewPayload(args: unknown): InterviewPayload | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.title !== "string" || !Array.isArray(a.questions)) return null;
  return a as unknown as InterviewPayload;
}

const normalizeOption = (o: string | InterviewOption): InterviewOption =>
  typeof o === "string" ? { label: o } : o;

const recommendedSet = (q: InterviewQuestion): Set<string> =>
  new Set(
    q.recommended === undefined
      ? []
      : Array.isArray(q.recommended)
        ? q.recommended
        : [q.recommended],
  );

/** Markdown fence long enough to wrap `source` even if it contains backticks. */
function fence(source: string, lang = ""): string {
  const longest = (source.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 2);
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${source}\n${f}`;
}

/** Resolve a media image src: URLs/data URIs pass through, sandbox paths go
 *  through the backend raw endpoint (project scoping rides the cookie). */
function imageSrc(src: string): string {
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  return `${API_BASE}/sandbox/raw?path=${encodeURIComponent(src)}`;
}

function ChartMedia({ config }: { config: unknown }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let chart: { destroy(): void } | undefined;
    let cancelled = false;
    import("chart.js/auto")
      .then(({ default: Chart }) => {
        if (cancelled || !canvasRef.current) return;
        chart = new Chart(
          canvasRef.current,
          config as ConstructorParameters<typeof Chart>[1],
        );
      })
      .catch(() => setError(true));
    return () => {
      cancelled = true;
      chart?.destroy();
    };
  }, [config]);
  if (error)
    return <div className="text-xs text-muted-foreground">(chart unavailable)</div>;
  return <canvas ref={canvasRef} className="max-h-72 w-full" />;
}

function MediaBlock({ media }: { media: InterviewMedia }) {
  switch (media.type) {
    case "image":
      return media.src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageSrc(media.src)}
          alt={media.caption ?? "interview media"}
          className="max-h-80 rounded-md border object-contain"
        />
      ) : null;
    case "table":
      return (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            {media.headers && (
              <thead>
                <tr className="border-b bg-muted/50">
                  {media.headers.map((h, i) => (
                    <th key={i} className="px-2 py-1.5 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {(media.rows ?? []).map((row, i) => (
                <tr key={i} className="border-b last:border-0">
                  {row.map((cell, j) => (
                    <td key={j} className="px-2 py-1.5">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "mermaid":
      return media.src ? (
        <MessageResponse>{fence(media.src, "mermaid")}</MessageResponse>
      ) : null;
    case "chart":
      return media.config ? <ChartMedia config={media.config} /> : null;
    case "html":
      return media.src ? (
        <iframe
          sandbox=""
          srcDoc={media.src}
          className="h-64 w-full rounded-md border bg-white"
          title={media.caption ?? "interview html"}
        />
      ) : null;
    default:
      return null;
  }
}

function MediaList({ media }: { media?: InterviewMedia | InterviewMedia[] }) {
  if (!media) return null;
  const items = Array.isArray(media) ? media : [media];
  return (
    <div className="space-y-2">
      {items.map((m, i) => (
        <figure key={i} className="space-y-1">
          <MediaBlock media={m} />
          {m.caption && (
            <figcaption className="text-[11px] text-muted-foreground">
              {m.caption}
            </figcaption>
          )}
        </figure>
      ))}
    </div>
  );
}

function ContentBlock({
  content,
}: {
  content: NonNullable<InterviewQuestion["content"]>;
}) {
  const lang = content.lang ?? "";
  const body =
    lang === "md" ? (
      <MessageResponse>{content.source}</MessageResponse>
    ) : (
      <MessageResponse>{fence(content.source, lang)}</MessageResponse>
    );
  return (
    <div className="space-y-1">
      {content.file && (
        <div className="font-mono text-[11px] text-muted-foreground">{content.file}</div>
      )}
      {body}
    </div>
  );
}

function OptionRow({
  option,
  selected,
  recommended,
  multi,
  disabled,
  onToggle,
}: {
  option: InterviewOption;
  selected: boolean;
  recommended: boolean;
  multi: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors",
        selected ? "border-primary bg-primary/5" : "hover:bg-muted/50",
        disabled && "cursor-default opacity-80 hover:bg-transparent",
      )}
      aria-pressed={selected}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
          multi ? "rounded-sm" : "rounded-full",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
        )}
      >
        {selected && <CheckIcon className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{option.label}</span>
          {recommended && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              Recommended
            </Badge>
          )}
        </span>
        {option.content && (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {option.content}
          </span>
        )}
      </span>
    </button>
  );
}

interface QuestionState {
  value: string | string[];
  images: UploadedImage[];
}

function initialState(q: InterviewQuestion): QuestionState {
  const rec = recommendedSet(q);
  // pi-interview semantics: a recommendation pre-selects unless conviction is
  // only "slight" (then it's badge-only and the user must choose).
  const preselect = rec.size > 0 && q.conviction !== "slight";
  if (q.type === "single")
    return { value: preselect ? [...rec][0] : "", images: [] };
  if (q.type === "multi") return { value: preselect ? [...rec] : [], images: [] };
  return { value: "", images: [] };
}

function QuestionCard({
  question: q,
  index,
  state,
  disabled,
  onChange,
}: {
  question: InterviewQuestion;
  index: number;
  state: QuestionState;
  disabled: boolean;
  onChange: (next: QuestionState) => void;
}) {
  const rec = recommendedSet(q);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const addImages = async (files: FileList | null) => {
    if (!files) return;
    setImageError(null);
    const next = [...state.images];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        setImageError(`${file.name} is over ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`);
        continue;
      }
      if (next.length >= MAX_IMAGES) {
        setImageError(`At most ${MAX_IMAGES} images`);
        break;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      next.push({ name: file.name, dataUrl, mimeType: file.type });
    }
    onChange({ ...state, images: next, value: next.map((i) => i.name) });
  };

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        q.weight === "critical" && "border-primary/50 ring-1 ring-primary/20",
        q.weight === "minor" && "opacity-90",
        q.type === "info" && "bg-muted/30",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="text-sm font-medium leading-snug">
          {q.type !== "info" && (
            <span className="mr-1.5 text-muted-foreground">{index + 1}.</span>
          )}
          {q.question}
        </span>
        {q.weight === "critical" && (
          <Badge variant="destructive" className="ml-auto h-4 shrink-0 px-1.5 text-[10px]">
            critical
          </Badge>
        )}
      </div>
      {q.context && <p className="text-xs text-muted-foreground">{q.context}</p>}
      {q.content && <ContentBlock content={q.content} />}
      <MediaList media={q.media} />

      {(q.type === "single" || q.type === "multi") && (
        <div className="space-y-1.5">
          {(q.options ?? []).map((raw, i) => {
            const option = normalizeOption(raw);
            const selected =
              q.type === "single"
                ? state.value === option.label
                : Array.isArray(state.value) && state.value.includes(option.label);
            return (
              <OptionRow
                key={`${option.label}-${i}`}
                option={option}
                selected={selected}
                recommended={rec.has(option.label)}
                multi={q.type === "multi"}
                disabled={disabled}
                onToggle={() => {
                  if (q.type === "single") {
                    onChange({ ...state, value: option.label });
                  } else {
                    const cur = Array.isArray(state.value) ? state.value : [];
                    onChange({
                      ...state,
                      value: selected
                        ? cur.filter((v) => v !== option.label)
                        : [...cur, option.label],
                    });
                  }
                }}
              />
            );
          })}
        </div>
      )}

      {q.type === "text" && (
        <Textarea
          value={typeof state.value === "string" ? state.value : ""}
          onChange={(e) => onChange({ ...state, value: e.target.value })}
          disabled={disabled}
          placeholder="Type your answer…"
          className="min-h-16 text-sm"
        />
      )}

      {q.type === "image" && (
        <div className="space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => void addImages(e.target.files)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadIcon className="size-3.5" />
            Upload images
          </Button>
          {imageError && <p className="text-xs text-destructive">{imageError}</p>}
          {state.images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {state.images.map((img, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    className="size-16 rounded-md border object-cover"
                  />
                  {!disabled && (
                    <button
                      type="button"
                      onClick={() =>
                        onChange({
                          ...state,
                          images: state.images.filter((_, j) => j !== i),
                          value: state.images
                            .filter((_, j) => j !== i)
                            .map((x) => x.name),
                        })
                      }
                      className="absolute -right-1.5 -top-1.5 rounded-full border bg-background p-0.5"
                      aria-label={`Remove ${img.name}`}
                    >
                      <XIcon className="size-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact read-only rendering of submitted answers (after tool_end). */
function SubmittedSummary({
  payload,
  result,
}: {
  payload: InterviewPayload;
  result?: string;
}) {
  const responses = useMemo(() => {
    try {
      const parsed = JSON.parse(result ?? "") as {
        responses?: { id: string; value: string | string[] }[];
      };
      return parsed.responses ?? null;
    } catch {
      return null;
    }
  }, [result]);
  if (!responses)
    return (
      <p className="text-xs text-muted-foreground">
        {result?.includes("dismissed")
          ? "Dismissed — the agent proceeded with its recommendations."
          : result
            ? "Answers submitted."
            : "Interview closed."}
      </p>
    );
  const questionFor = (id: string) =>
    payload.questions.find((q) => q.id === id)?.question ?? id;
  return (
    <dl className="space-y-1.5">
      {responses.map((r) => (
        <div key={r.id} className="text-xs">
          <dt className="text-muted-foreground">{questionFor(r.id)}</dt>
          <dd className="font-medium">
            {Array.isArray(r.value) ? r.value.join(", ") : r.value || "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function InterviewCard({
  item,
  sessionId,
}: {
  item: ActivityItem;
  sessionId: string | null;
}) {
  const payload = useMemo(() => parseInterviewPayload(item.args), [item.args]);
  const [states, setStates] = useState<Record<string, QuestionState>>(() => {
    const init: Record<string, QuestionState> = {};
    for (const q of payload?.questions ?? []) init[q.id] = initialState(q);
    return init;
  });
  const [phase, setPhase] = useState<"editing" | "submitting" | "submitted">("editing");
  const [error, setError] = useState<string | null>(null);

  if (!payload) return null;

  const finished = item.status !== "running";
  const locked = finished || phase !== "editing";

  const post = async (body: unknown): Promise<void> => {
    if (!sessionId) return;
    setPhase("submitting");
    setError(null);
    try {
      const res = await apiFetch(`/sessions/${sessionId}/interview/${item.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
        setError(detail?.detail ?? `Submission failed (${res.status})`);
        setPhase("editing");
        return;
      }
      setPhase("submitted");
    } catch {
      setError("Submission failed — is the backend running?");
      setPhase("editing");
    }
  };

  const submit = () =>
    void post({
      responses: payload.questions
        .filter((q) => q.type !== "info")
        .map((q) => {
          const s = states[q.id] ?? { value: "", images: [] };
          return {
            id: q.id,
            value: s.value,
            ...(s.images.length
              ? {
                  attachments: s.images.map((img) => ({
                    // strip the "data:<mime>;base64," prefix
                    data: img.dataUrl.slice(img.dataUrl.indexOf(",") + 1),
                    mimeType: img.mimeType,
                  })),
                }
              : {}),
          };
        }),
    });

  return (
    <div
      className={cn(
        "my-2 space-y-3 rounded-lg border bg-background p-3.5 shadow-sm",
        !finished && "border-primary/40",
      )}
    >
      <div className="flex items-center gap-2">
        <ClipboardListIcon className="size-4 shrink-0 text-primary" />
        <span className="text-sm font-semibold">{payload.title}</span>
        {finished ? (
          item.status === "error" ? (
            <Badge variant="outline" className="ml-auto h-5 text-[10px] text-destructive">
              expired
            </Badge>
          ) : (
            <Badge variant="outline" className="ml-auto h-5 text-[10px] text-emerald-600">
              answered
            </Badge>
          )
        ) : (
          <Badge variant="outline" className="ml-auto h-5 text-[10px]">
            waiting for you
          </Badge>
        )}
      </div>
      {payload.description && (
        <p className="text-xs text-muted-foreground">{payload.description}</p>
      )}

      {finished && item.status !== "error" ? (
        <SubmittedSummary payload={payload} result={item.result} />
      ) : item.status === "error" ? (
        <p className="text-xs text-muted-foreground">
          This interview is no longer waiting for answers.
        </p>
      ) : (
        <>
          <div className="space-y-2.5">
            {payload.questions.map((q, i) => (
              <QuestionCard
                key={q.id}
                question={q}
                index={i}
                state={states[q.id] ?? { value: "", images: [] }}
                disabled={locked}
                onChange={(next) => setStates((prev) => ({ ...prev, [q.id]: next }))}
              />
            ))}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={submit} disabled={locked || !sessionId}>
              {phase === "submitting" ? "Submitting…" : "Submit answers"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={locked || !sessionId}
              onClick={() => void post({ cancelled: true })}
            >
              Skip
            </Button>
            {phase === "submitted" && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <CheckIcon className="size-3 text-emerald-500" /> Sent — the agent is
                continuing…
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
