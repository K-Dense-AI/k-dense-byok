/**
 * Reasoning level for Kady's budgeted one-shot model calls (Methods draft,
 * "What next?" proposals, editor LaTeX assist).
 *
 * These calls go through `ModelRuntime.completeSimple` rather than `complete`
 * on purpose: `complete` is the raw provider stream, and when no reasoning
 * effort is given Pi's OpenAI-compatible adapter sends OpenRouter an explicit
 * `reasoning: { effort: "none" }` for any reasoning-capable model. Models whose
 * reasoning cannot be switched off (e.g. GPT-6 Astra, the default model)
 * reject that with `400 Reasoning is mandatory for this endpoint and cannot be
 * disabled`, so the one-shot features failed outright while ordinary chats —
 * which always carry the tab's thinking level — kept working.
 *
 * `completeSimple` maps a provider-neutral level onto whatever field the
 * provider expects and clamps it to the model's supported levels (a model with
 * no reasoning support simply gets no reasoning parameter), so one constant is
 * safe across OpenRouter, OAuth providers, NIM and local servers.
 */
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const ONE_SHOT_REASONING: ThinkingLevel = "medium";
