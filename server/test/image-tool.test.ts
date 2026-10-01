/**
 * generate_image: Pi 1.0 image models saved into the sandbox, billed by their
 * own provider, gated by the spend cap and the raw-data guard.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { recordRun } from "../src/cost/ledger.ts";
import { makeCodemodeModelBudgetExtension, makeImageTool } from "../src/agent/image-tool.ts";
import { makeDataGuardExtension } from "../src/agent/data-guard.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const imageModel = (id: string, cost: { input: number; output: number }, input: ("text" | "image")[] = ["text", "image"]) => ({
  type: "image", provider: "openrouter", id, name: id, api: "openrouter-images", input, output: ["image"],
  cost: { ...cost, cacheRead: 0, cacheWrite: 0 },
});
const CATALOG = [
  imageModel("black-forest-labs/flux.2-pro", { input: 0, output: 0 }),
  imageModel("google/gemini-2.5-flash-image", { input: 0.3, output: 2.5 }),
  imageModel("openrouter/auto", { input: -1_000_000, output: -1_000_000 }),
  imageModel("microsoft/mai-image-2.6", { input: 5, output: 0 }),
  imageModel("text-only/painter", { input: 1, output: 1 }, ["text"]),
];
const usage = { input: 20, output: 1290, cacheRead: 0, cacheWrite: 0, totalTokens: 1310, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0323 } };

function registry(output: Array<Record<string, unknown>> = [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }], stopReason = "stop") {
  return {
    getAvailableOfType: vi.fn(async () => CATALOG),
    getModelOfType: vi.fn((_type: string, provider: string, id: string) => CATALOG.find((m) => m.provider === provider && m.id === id)),
    generateImages: vi.fn(async (model: { provider: string; id: string }) => ({
      api: "openrouter-images", provider: model.provider, model: model.id, output, usage, stopReason, timestamp: Date.now(),
      ...(stopReason === "stop" ? {} : { errorMessage: "content policy" }),
    })),
  };
}

const run = (projectId: string, params: Record<string, unknown>, reg = registry(), auth = { type: "api_key" }, saved?: string) =>
  makeImageTool(projectId, async () => auth, () => saved).execute("call-1", params, undefined, undefined, { modelRegistry: reg } as never);

let projectId: string;
beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  projectId = createProject({ name: "Figures" }).id;
});

describe("generate_image", () => {
  it("prefers GPT Image 2.5 Sunburst when its credentials work", async () => {
    const sunburst = imageModel("openai/gpt-image-2.5-sunburst", { input: 8, output: 8 });
    const reg = { ...registry(), getAvailableOfType: vi.fn(async () => [...CATALOG, sunburst]) };
    const result = await run(projectId, { prompt: "A schematic" }, reg);
    expect(result.details.model).toBe("openrouter/openai/gpt-image-2.5-sunburst");
  });

  it("uses the default saved in Settings, and says so when it has to fall back", async () => {
    const extra = imageModel("google/gemini-3.1-flash-image", { input: 0.5, output: 3 });
    const reg = { ...registry(), getAvailableOfType: vi.fn(async () => [...CATALOG, extra]) };
    const saved = await run(projectId, { prompt: "x" }, reg, undefined, "openrouter/google/gemini-3.1-flash-image");
    expect(saved.details.model).toBe("openrouter/google/gemini-3.1-flash-image");
    expect(saved.content[0].text).not.toMatch(/Settings → Defaults/);
    // An explicit request still wins over the saved default.
    const explicit = await run(projectId, { prompt: "x", model: "openrouter/google/gemini-2.5-flash-image" }, reg, undefined, "openrouter/google/gemini-3.1-flash-image");
    expect(explicit.details.model).toBe("openrouter/google/gemini-2.5-flash-image");
    // A saved default that is unmetered (or disconnected) falls back to the built-in order.
    const fallback = await run(projectId, { prompt: "x" }, reg, undefined, "openrouter/microsoft/mai-image-2.6");
    expect(fallback.details.model).toBe("openrouter/google/gemini-3.1-flash-image");
    expect(fallback.content[0].text).toMatch(/default image model openrouter\/microsoft\/mai-image-2.6 \(Settings → Defaults\) is not available/);
  });

  it("saves the image in the sandbox, returns it to the model and reports the model for billing", async () => {
    const reg = registry();
    const result = await run(projectId, { prompt: "A schematic of the RNA-seq pipeline" }, reg);
    // FLUX is priced per image ($0 per token) and openrouter/auto negatively: neither is metered.
    expect(reg.generateImages.mock.calls[0][0]).toMatchObject({ id: "google/gemini-2.5-flash-image" });
    expect(result.details).toEqual({ model: "openrouter/google/gemini-2.5-flash-image", files: ["figures/generated/a_schematic_of_the_rna_seq.png"], costUsd: 0.0323 });
    expect(result.usage).toEqual(usage);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Saved figures/generated/a_schematic_of_the_rna_seq.png") });
    expect(result.content.at(-1)).toMatchObject({ type: "image", mimeType: "image/png" });
    const saved = path.join(resolvePaths(projectId).sandbox, "figures/generated/a_schematic_of_the_rna_seq.png");
    expect(fs.readFileSync(saved)).toEqual(PNG);

    // Never overwrites: a second call with the same path gets a numbered name.
    const again = await run(projectId, { prompt: "x", path: "figures/generated/a_schematic_of_the_rna_seq.png" });
    expect(again.details.files).toEqual(["figures/generated/a_schematic_of_the_rna_seq_2.png"]);
  });

  it("refuses unpriceable, unknown and unsafe requests before paying", async () => {
    const reg = registry();
    await expect(run(projectId, { prompt: "x", model: "openrouter/black-forest-labs/flux.2-pro" }, reg)).rejects.toThrow(/priced per image/);
    // Input-only pricing would ledger the generated image itself at $0.
    await expect(run(projectId, { prompt: "x", model: "openrouter/microsoft/mai-image-2.6" }, reg)).rejects.toThrow(/cannot meter/);
    await expect(run(projectId, { prompt: "x", model: "openrouter/nope/none" }, reg)).rejects.toThrow(/Unknown image model/);
    await expect(run(projectId, { prompt: "x", path: "../outside.png" }, reg)).rejects.toThrow(/traversal/);
    await expect(run(projectId, { prompt: "x", references: ["notes.txt"] }, reg)).rejects.toThrow(/not a PNG/);
    await expect(run(projectId, { prompt: "x", model: "openrouter/text-only/painter", references: ["a.png"] }, reg)).rejects.toThrow();
    expect(reg.generateImages).not.toHaveBeenCalled();
    const none = { ...registry(), getAvailableOfType: vi.fn(async () => []) };
    await expect(run(projectId, { prompt: "x" }, none)).rejects.toThrow(/Settings → Providers/);
  });

  it("passes sandbox references to the model", async () => {
    const sandbox = resolvePaths(projectId).sandbox;
    fs.mkdirSync(path.join(sandbox, "figures"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "figures", "draft.png"), PNG);
    const reg = registry();
    await run(projectId, { prompt: "Fix the axis labels", references: ["figures/draft.png"] }, reg);
    expect(reg.generateImages.mock.calls[0][1]).toEqual({
      input: [{ type: "text", text: "Fix the axis labels" }, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }],
    });
  });

  it("returns a billed failure as an error result instead of throwing", async () => {
    const result = await run(projectId, { prompt: "x" }, registry([], "error"));
    expect(result.isError).toBe(true);
    expect(result.usage).toEqual(usage);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("content policy") });
  });

  it("is blocked at the spend cap unless the image provider's usage is not cap-counted", async () => {
    const capped = createProject({ name: "Capped", spendLimitUsd: 0.01 }).id;
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({ sessionId: "s", projectId: capped, model: "m", before: zero, after: { ...zero, costUsd: 0.02, total: 10 } });
    await expect(run(capped, { prompt: "x" })).rejects.toThrow(/spend limit/);
  });

  it("is covered by the raw-data guard", async () => {
    const handlers = new Map<string, (event: any) => any>();
    makeDataGuardExtension(projectId, () => "s", resolvePaths(projectId).sandbox)({
      on: (name: string, handler: (event: any) => any) => handlers.set(name, handler),
    } as never);
    const blocked = await handlers.get("tool_call")!({ toolName: "generate_image", toolCallId: "c", input: { prompt: "x", path: "user_data/raw.png" } });
    expect(blocked).toMatchObject({ block: true });
    expect(await handlers.get("tool_call")!({ toolName: "generate_image", toolCallId: "c", input: { prompt: "x" } })).toBeUndefined();
  });
});

describe("codemode model-call budget gate", () => {
  it("refuses scripts that run models only once the cap is reached", async () => {
    const handlers = new Map<string, (event: any) => any>();
    const install = (id: string) => makeCodemodeModelBudgetExtension(id)({
      on: (name: string, handler: (event: any) => any) => handlers.set(name, handler),
    } as never);
    const script = { toolName: "codemode", input: { code: 'const m = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image"); image((await models.generateImages(m, { input: [] })).output[0]);' } };
    install(projectId);
    expect(await handlers.get("tool_call")!(script)).toBeUndefined();

    const capped = createProject({ name: "Capped", spendLimitUsd: 0.01 }).id;
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({ sessionId: "s", projectId: capped, model: "m", before: zero, after: { ...zero, costUsd: 0.02, total: 10 } });
    install(capped);
    expect(await handlers.get("tool_call")!(script)).toMatchObject({ block: true, reason: expect.stringMatching(/spend limit/) });
    expect(await handlers.get("tool_call")!({ toolName: "codemode", input: { code: "return await tools.read({ path: 'a' })" } })).toBeUndefined();
  });
});
