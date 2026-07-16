import type { FastifyInstance } from "fastify";
import { emptySnapshot, isBudgetExceeded, recordRun } from "../cost/ledger.ts";
import { currentProjectId } from "../scope.ts";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_MODEL = "openai/whisper-large-v3";
export const SPEECH_SESSION_ID = "speech-transcribe";
const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/mpga",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
]);

type FetchFn = typeof fetch;

export interface SpeechTranscriptionResult {
  text: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export class SpeechTranscriptionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function baseMimeType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function extensionForMimeType(mimeType: string): string {
  switch (baseMimeType(mimeType)) {
    case "audio/flac":
      return "flac";
    case "audio/m4a":
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/mp3":
    case "audio/mpeg":
    case "audio/mpga":
      return "mp3";
    case "audio/ogg":
      return "ogg";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      return "webm";
  }
}

function providerMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (record.error && typeof record.error === "object") {
    const message = (record.error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return null;
}

function numericField(
  record: Record<string, unknown>,
  ...names: string[]
): number {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export async function transcribeAudio(
  audio: Uint8Array,
  mimeType: string,
  apiKey: string,
  fetchFn: FetchFn = fetch,
): Promise<SpeechTranscriptionResult> {
  if (audio.byteLength === 0) {
    throw new SpeechTranscriptionError(400, "The recording was empty.");
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new SpeechTranscriptionError(413, "The recording is too large (25 MB maximum).");
  }

  const normalizedMimeType = baseMimeType(mimeType);
  if (!SUPPORTED_AUDIO_TYPES.has(normalizedMimeType)) {
    throw new SpeechTranscriptionError(
      415,
      `Unsupported recording format: ${normalizedMimeType || "unknown"}.`,
    );
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([audio], { type: mimeType }),
    `dictation.${extensionForMimeType(mimeType)}`,
  );
  const requestedModel =
    process.env.SPEECH_TRANSCRIPTION_MODEL?.trim() || DEFAULT_MODEL;
  form.append("model", requestedModel);

  const baseUrl = (
    process.env.OPENROUTER_BASE_URL?.trim() ||
    "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, "");

  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    throw new SpeechTranscriptionError(
      502,
      error instanceof Error ? error.message : "The transcription provider could not be reached.",
    );
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new SpeechTranscriptionError(
      502,
      providerMessage(payload) || `Transcription failed (${response.status}).`,
    );
  }

  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const text = record.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new SpeechTranscriptionError(502, "The transcription provider returned no text.");
  }
  const usage =
    record.usage && typeof record.usage === "object"
      ? (record.usage as Record<string, unknown>)
      : {};
  const inputTokens = numericField(usage, "prompt_tokens", "input_tokens");
  const outputTokens = numericField(
    usage,
    "completion_tokens",
    "output_tokens",
  );
  const totalTokens =
    numericField(usage, "total_tokens") || inputTokens + outputTokens;
  return {
    text: text.trim(),
    model:
      typeof record.model === "string" && record.model.trim()
        ? record.model
        : requestedModel,
    costUsd: numericField(usage, "cost"),
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

export async function registerSpeechRoutes(app: FastifyInstance): Promise<void> {
  app.post("/speech/transcribe", async (req, reply) => {
    const projectId = currentProjectId();
    const budget = isBudgetExceeded(projectId);
    if (budget.exceeded) {
      reply.code(402);
      return {
        detail:
          `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
          `$${(budget.limitUsd ?? 0).toFixed(2)}). Raise the limit in project settings.`,
      };
    }

    const apiKey = (
      process.env.OPENROUTER_API_KEY || process.env.OR_API_KEY
    )?.trim();
    if (!apiKey) {
      reply.code(503);
      return {
        detail:
          "Dictation fallback requires an OpenRouter API key in Settings → API keys.",
      };
    }
    if (!req.isMultipart()) {
      reply.code(415);
      return { detail: "Expected a multipart audio upload." };
    }

    try {
      const part = await req.file({
        limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
      });
      if (!part) {
        reply.code(400);
        return { detail: "No audio recording was provided." };
      }

      const audio = await part.toBuffer();
      if (part.file.truncated) {
        throw new SpeechTranscriptionError(
          413,
          "The recording is too large (25 MB maximum).",
        );
      }

      const result = await transcribeAudio(
        new Uint8Array(audio),
        part.mimetype || "application/octet-stream",
        apiKey,
      );
      recordRun({
        sessionId: SPEECH_SESSION_ID,
        projectId,
        model: result.model,
        before: emptySnapshot(),
        after: {
          costUsd: result.costUsd,
          input: result.inputTokens,
          output: result.outputTokens,
          cacheRead: 0,
          total: result.totalTokens,
        },
      });
      return { text: result.text, costUsd: result.costUsd };
    } catch (error) {
      if (error instanceof SpeechTranscriptionError) {
        reply.code(error.status);
        return { detail: error.message };
      }
      const status =
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        (error as { statusCode?: unknown }).statusCode === 413
          ? 413
          : 500;
      reply.code(status);
      return {
        detail:
          status === 413
            ? "The recording is too large (25 MB maximum)."
            : "The recording could not be processed.",
      };
    }
  });
}
