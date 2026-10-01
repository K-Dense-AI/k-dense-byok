/**
 * `generate_image`: image generation for the lead agent, saved into the sandbox.
 *
 * Pi 1.0 runs image models (OpenRouter's, such as Gemini Flash Image and the
 * GPT Image family) through `ModelRegistry.generateImages()` with the
 * session's credentials. Pi itself reaches them only from codemode scripts,
 * which Kady's lead activates only when an MCP server needs codemode, and
 * Pi's generated images are never written to disk. This tool makes them a
 * first-class research artifact: a figure, schematic or graphical abstract
 * lands at a sandbox path (visible in the file tree and in provenance's
 * scan-diff), its pixels are returned to the model so it can check the result,
 * and its usage rides the tool result so the run ledger bills it under the
 * image model's own provider (cost/tool-usage.ts) rather than the turn's.
 *
 * Only image models with a per-token output price are offered. Several of
 * OpenRouter's image models (FLUX, Seedream, Recraft…) are priced per image,
 * which Pi's catalog records as $0 per token, and MAI-Image prices only its
 * input: running them would ledger pay-as-you-go spend as free and let it
 * bypass the project cap.
 */
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { ImageContent, ImageModel, ImageApi, TextContent, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { billingCountsTowardBudget, billingForProvider } from "../cost/billing.ts";
import { isBudgetExceeded } from "../cost/ledger.ts";
import { readAppDefaults } from "../app-settings.ts";
import { resolvePaths, touchProject } from "../projects.ts";
import { apiRelative, safePath } from "../sandbox-fs.ts";

/**
 * Built-in defaults, best first; the first one with working credentials wins.
 * A model saved in Settings → Defaults (`imageModel` in kady-settings.json)
 * is tried before these.
 */
export const DEFAULT_IMAGE_MODELS = [
  "openrouter/openai/gpt-image-2.5-sunburst",
  "openrouter/google/gemini-3.1-flash-image",
  "openrouter/google/gemini-2.5-flash-image",
  "openrouter/openai/gpt-image-1-mini",
] as const;

const MAX_REFERENCES = 4;
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
const REFERENCE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const OUTPUT_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export const GenerateImageParams = Type.Object({
  prompt: Type.String({
    minLength: 1,
    description:
      "What to draw: subject, layout, labels, style and colours. For scientific figures name every element and the exact text of any label.",
  }),
  path: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Sandbox-relative output path, e.g. figures/pipeline_overview.png. Defaults to figures/generated/<prompt-slug>.png. An existing file is never overwritten: a numbered name is used instead.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      minLength: 1,
      description: `Image model ref, e.g. ${DEFAULT_IMAGE_MODELS[0]}. Omit to use the user's default; set it only when the user asks for a specific model.`,
    }),
  ),
  references: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      maxItems: MAX_REFERENCES,
      description: "Sandbox image paths to edit or use as visual references (PNG, JPEG, WebP or GIF, ≤5 MB each).",
    }),
  ),
});
export type GenerateImageInput = Static<typeof GenerateImageParams>;

export interface GenerateImageDetails {
  /** Canonical `provider/model` ref; cost/tool-usage.ts bills by it. */
  model: string;
  files: string[];
  costUsd?: number;
}

type Registry = Pick<ExtensionContext["modelRegistry"], "getAvailableOfType" | "getModelOfType" | "generateImages">;

/** The credential type Pi resolves for a provider (`ModelRuntime.checkAuth`). */
export type ProviderAuthCheck = (provider: string) => Promise<{ type?: string } | undefined>;

/**
 * A model Kady can price: the generated image is output, so output must carry
 * a token price (MAI-Image is catalogued with input-only prices and would
 * ledger every image as nearly free), and no price may be negative.
 */
function priceable(model: ImageModel<ImageApi>): boolean {
  const { input, output } = model.cost;
  return input >= 0 && output > 0;
}

function refOf(model: ImageModel<ImageApi>): string {
  return `${model.provider}/${model.id}`;
}

function splitRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  return slash > 0 && slash < ref.length - 1 ? { provider: ref.slice(0, slash), id: ref.slice(slash + 1) } : null;
}

/** Why `ref` cannot be a default image model, or null. Credentials are not required. */
export function imageModelIssue(registry: Pick<Registry, "getModelOfType">, ref: string): string | null {
  const parts = splitRef(ref);
  const model = parts ? registry.getModelOfType("image", parts.provider, parts.id) : undefined;
  if (!model) return `"${ref}" is not an image model Pi knows`;
  if (!priceable(model)) return `"${ref}" has no per-token output price, so Kady cannot meter it against the project spend cap`;
  return null;
}

export interface ImageModelOption {
  ref: string;
  name: string;
  /** Its provider has working credentials now. */
  available: boolean;
  /** Accepts reference images. */
  imageInput: boolean;
  /** USD per million tokens. */
  cost: { input: number; output: number };
}

/** The image models Kady can meter, connected ones first (Settings → Defaults). */
export async function listImageModels(registry: Pick<Registry, "getAvailableOfType"> & {
  getModelsOfType: ExtensionContext["modelRegistry"]["getModelsOfType"];
}): Promise<ImageModelOption[]> {
  const available = new Set((await registry.getAvailableOfType("image")).map(refOf));
  return registry.getModelsOfType("image").filter(priceable)
    .map((model) => ({
      ref: refOf(model),
      name: model.name,
      available: available.has(refOf(model)),
      imageInput: model.input.includes("image"),
      cost: { input: model.cost.input, output: model.cost.output },
    }))
    .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
}

interface ChosenModel {
  model: ImageModel<ImageApi>;
  /** Why the saved default was not used, for the model to pass on. */
  note?: string;
}

async function chooseModel(
  registry: Registry,
  requested: string | undefined,
  savedDefault: string | undefined,
  signal?: AbortSignal,
): Promise<ChosenModel> {
  const available = (await registry.getAvailableOfType("image", undefined, { signal })).filter(priceable);
  const offer = () => {
    const refs = available.slice(0, 8).map(refOf);
    return refs.length ? ` Available: ${refs.join(", ")}.` : "";
  };
  if (requested) {
    const parts = splitRef(requested);
    const model = parts ? registry.getModelOfType("image", parts.provider, parts.id) : undefined;
    if (!model) throw new Error(`Unknown image model "${requested}".${offer()}`);
    if (!priceable(model)) {
      throw new Error(
        `"${requested}" has no per-token output price (it is priced per image or by input only), so Kady cannot meter it against the project spend cap; use a token-priced model.${offer()}`,
      );
    }
    if (!available.some((candidate) => refOf(candidate) === refOf(model))) {
      throw new Error(`"${requested}" has no working credentials. Connect ${model.provider} in Settings → Providers.${offer()}`);
    }
    return { model };
  }
  let note: string | undefined;
  if (savedDefault) {
    const model = available.find((candidate) => refOf(candidate) === savedDefault);
    if (model) return { model };
    note = `The default image model ${savedDefault} (Settings → Defaults) is not available — it is unknown, unmetered or not connected — so a built-in default was used.`;
  }
  for (const ref of DEFAULT_IMAGE_MODELS) {
    const model = available.find((candidate) => refOf(candidate) === ref);
    if (model) return { model, note };
  }
  if (available[0]) return { model: available[0], note };
  throw new Error(
    "Image generation needs an image model with working credentials, such as OpenRouter's. Add an OpenRouter key or sign in to OpenRouter in Settings → Providers.",
  );
}

function slug(prompt: string): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).slice(0, 6).join("_");
  return words.slice(0, 48) || "image";
}

/** A free sandbox path for output `index`, keeping the requested stem. */
function outputPath(sandbox: string, requested: string, index: number, total: number, mimeType: string): string {
  const extension = OUTPUT_EXTENSION[mimeType] ?? ".png";
  const parsed = path.parse(requested);
  const stem = total > 1 ? `${parsed.name}_${index + 1}` : parsed.name;
  for (let attempt = 1; ; attempt++) {
    const name = attempt === 1 ? `${stem}${extension}` : `${stem}_${attempt}${extension}`;
    const target = safePath(path.join(parsed.dir, name), sandbox);
    if (!fs.existsSync(target)) return target;
  }
}

function readReference(sandbox: string, rel: string): ImageContent {
  const mimeType = REFERENCE_MIME[path.extname(rel).toLowerCase()];
  if (!mimeType) throw new Error(`Reference ${rel} is not a PNG, JPEG, WebP or GIF image.`);
  const file = safePath(rel, sandbox);
  const size = fs.statSync(file).size;
  if (size > MAX_REFERENCE_BYTES) throw new Error(`Reference ${rel} is larger than 5 MB.`);
  return { type: "image", data: fs.readFileSync(file).toString("base64"), mimeType };
}

/** Billing for the image model's provider, from the credential Pi resolves. */
async function imageBilling(checkAuth: ProviderAuthCheck, provider: string) {
  const auth = await checkAuth(provider);
  return billingForProvider(provider, auth?.type === "oauth" ? "oauth" : auth ? "api_key" : "none");
}

export function makeImageTool(
  projectId: string,
  checkAuth: ProviderAuthCheck,
  savedDefault: () => string | undefined = () => readAppDefaults().imageModel,
): ToolDefinition<any> {
  const sandbox = resolvePaths(projectId).sandbox;
  const tool: ToolDefinition<typeof GenerateImageParams> = {
    name: "generate_image",
    label: "Generate image",
    description: [
      "Generate an image with an image model and save it in the sandbox: schematics, method or pipeline diagrams, graphical abstracts, illustrations, or edits of an existing image passed in `references`.",
      "The image is returned to you so you can check it, and saved at `path` (default figures/generated/<slug>.png).",
      "Image models draw; they do not compute. Never use this for plots of data — plot data with code so every value is exact and reproducible.",
      "Each call is billed by the image model's provider and counts toward the project spend cap.",
    ].join("\n"),
    promptSnippet: "generate_image: create or edit an illustration, schematic or graphical abstract and save it in the sandbox",
    promptGuidelines: [
      "Use generate_image for illustrations and schematics only. Plot data with code (matplotlib, ggplot2…), never with an image model, and never present a generated image as data or evidence.",
      "After generate_image, inspect the returned image and say where it was saved. Labels drawn by image models can be misspelled: check them, and regenerate or fix them before calling a figure final.",
    ],
    parameters: GenerateImageParams,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const registry = ctx.modelRegistry as Registry;
      const { model, note: defaultNote } = await chooseModel(registry, params.model, savedDefault(), signal);
      const billing = await imageBilling(checkAuth, model.provider);
      const budget = isBudgetExceeded(projectId);
      if (billingCountsTowardBudget(billing) && budget.exceeded) {
        throw new Error(
          `Image generation blocked: the project has reached its spend limit ($${budget.totalUsd.toFixed(2)} / $${(budget.limitUsd ?? 0).toFixed(2)}). Ask the user to raise it.`,
        );
      }
      const references = (params.references ?? []).map((rel) => readReference(sandbox, rel));
      if (references.length > 0 && !model.input.includes("image")) {
        throw new Error(`${refOf(model)} cannot take reference images; choose a model that accepts image input.`);
      }
      const requested = params.path ?? path.join("figures", "generated", `${slug(params.prompt)}.png`);
      // Fail on an unsafe path before paying for the image.
      safePath(requested, sandbox);

      const result = await registry.generateImages(model, {
        input: [{ type: "text", text: params.prompt }, ...references],
      }, { signal });
      const usage: Usage | undefined = result.usage;
      const details: GenerateImageDetails = {
        model: refOf(model),
        files: [],
        ...(usage ? { costUsd: usage.cost.total } : {}),
      };
      const images = result.output.filter((block): block is ImageContent => block.type === "image");
      const notes = result.output.filter((block): block is TextContent => block.type === "text" && Boolean(block.text.trim()));
      if (result.stopReason !== "stop" || images.length === 0) {
        const reason = result.errorMessage ?? (result.stopReason === "stop" ? "the model returned no image" : result.stopReason);
        // Returned, not thrown: the call may still have been billed, and the
        // usage only reaches the ledger on a returned result.
        return {
          content: [{ type: "text", text: `Image generation failed (${refOf(model)}): ${reason}` }, ...notes],
          details,
          ...(usage ? { usage } : {}),
          isError: true,
        };
      }
      for (const [index, image] of images.entries()) {
        const target = outputPath(sandbox, requested, index, images.length, image.mimeType);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(image.data, "base64"));
        details.files.push(apiRelative(sandbox, target));
      }
      touchProject(projectId);
      const cost = usage ? `, $${usage.cost.total.toFixed(4)}` : "";
      return {
        content: [
          { type: "text", text: `Saved ${details.files.join(", ")} (${refOf(model)}${cost}).${defaultNote ? ` ${defaultNote}` : ""}` },
          ...notes,
          ...images,
        ],
        details,
        ...(usage ? { usage } : {}),
      };
    },
  };
  return tool;
}

/** Codemode's model-running globals (Pi 1.0 `models.generateImages()` / `models.classify()`). */
const CODEMODE_MODEL_CALL = /\b(?:generateImages|classify)\b/;

/**
 * Spend-cap gate for codemode scripts that run models themselves. Their model
 * and provider are chosen inside the script, so the call cannot be priced up
 * front; over the cap, a script that names either model call is refused
 * (fail closed, like the subagent gate's unknown billing). Scripts that only
 * call tools are unaffected.
 */
export function makeCodemodeModelBudgetExtension(projectId: string): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "codemode") return;
      const code = (event.input as { code?: unknown }).code;
      if (typeof code !== "string" || !CODEMODE_MODEL_CALL.test(code)) return;
      const budget = isBudgetExceeded(projectId);
      if (!budget.exceeded) return;
      return {
        block: true,
        reason:
          `Script blocked: it runs models (models.generateImages/classify), and the project has reached its spend limit ` +
          `($${budget.totalUsd.toFixed(2)} / $${(budget.limitUsd ?? 0).toFixed(2)}). Continue without model calls or ask the user to raise the limit.`,
      };
    });
  };
}
