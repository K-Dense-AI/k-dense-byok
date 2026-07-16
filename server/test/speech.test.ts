import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerSpeechRoutes,
  SpeechTranscriptionError,
  transcribeAudio,
} from "../src/api/speech.ts";
import {
  emptySnapshot,
  isBudgetExceeded,
  recordRun,
} from "../src/cost/ledger.ts";
import { createProject, deleteProject } from "../src/projects.ts";
import { buildApp } from "../src/index.ts";

const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
const originalOpenRouterAlias = process.env.OR_API_KEY;
const originalOpenRouterBaseUrl = process.env.OPENROUTER_BASE_URL;
const originalSpeechModel = process.env.SPEECH_TRANSCRIPTION_MODEL;

afterEach(() => {
  if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  if (originalOpenRouterAlias === undefined) delete process.env.OR_API_KEY;
  else process.env.OR_API_KEY = originalOpenRouterAlias;
  if (originalOpenRouterBaseUrl === undefined) {
    delete process.env.OPENROUTER_BASE_URL;
  } else {
    process.env.OPENROUTER_BASE_URL = originalOpenRouterBaseUrl;
  }
  if (originalSpeechModel === undefined) {
    delete process.env.SPEECH_TRANSCRIPTION_MODEL;
  } else {
    process.env.SPEECH_TRANSCRIPTION_MODEL = originalSpeechModel;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("speech transcription", () => {
  it("preserves the browser recording type and returns trimmed text", async () => {
    process.env.OPENROUTER_BASE_URL = "https://speech.example.test/v1/";
    process.env.SPEECH_TRANSCRIPTION_MODEL = "test-transcriber";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
      expect(form.get("model")).toBe("test-transcriber");
      const file = form.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect((file as Blob).type).toBe("audio/mp4;codecs=mp4a.40.2");
      return new Response(
        JSON.stringify({
          text: "  dictated text  ",
          model: "resolved-transcriber",
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
            cost: 0.001,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const text = await transcribeAudio(
      new Uint8Array([1, 2, 3]),
      "audio/mp4;codecs=mp4a.40.2",
      "test-key",
      fetchMock,
    );

    expect(text).toEqual({
      text: "dictated text",
      model: "resolved-transcriber",
      costUsd: 0.001,
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://speech.example.test/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects unsupported formats before contacting the provider", async () => {
    const fetchMock = vi.fn();
    await expect(
      transcribeAudio(
        new Uint8Array([1]),
        "application/octet-stream",
        "test-key",
        fetchMock,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SpeechTranscriptionError>>({
        status: 415,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a configuration error before accepting an upload", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OR_API_KEY;
    const app = Fastify();
    await app.register(multipart);
    await registerSpeechRoutes(app);

    const response = await app.inject({
      method: "POST",
      url: "/speech/transcribe",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().detail).toMatch(/OpenRouter API key/i);
    await app.close();
  });

  it("blocks transcription when the project spend limit is reached", async () => {
    const projectId = "speech-budget-test";
    try {
      deleteProject(projectId);
    } catch {
      // The project normally does not exist.
    }
    createProject({
      name: "Speech budget test",
      projectId,
      spendLimitUsd: 0.001,
    });
    recordRun({
      sessionId: "existing-spend",
      projectId,
      model: "test",
      before: emptySnapshot(),
      after: { ...emptySnapshot(), costUsd: 0.001 },
    });
    expect(isBudgetExceeded(projectId).exceeded).toBe(true);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/speech/transcribe",
      headers: { "x-project-id": projectId },
    });

    expect(response.statusCode).toBe(402);
    expect(response.json().detail).toMatch(/spend limit reached/i);
    await app.close();
    deleteProject(projectId);
  });

  it("accepts a browser recording through the multipart route", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            text: "route transcript",
            usage: { total_tokens: 2, cost: 0.0002 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    const app = Fastify();
    await app.register(multipart);
    await registerSpeechRoutes(app);
    const boundary = "kady-speech-boundary";
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="audio"; filename="dictation.webm"',
        "Content-Type: audio/webm;codecs=opus",
        "",
        "recorded audio",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/speech/transcribe",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      text: "route transcript",
      costUsd: 0.0002,
    });
    expect(fetch).toHaveBeenCalledOnce();
    await app.close();
  });
});
