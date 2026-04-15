import type { SidebarSkill } from "../shared/sidebar-controls";
import databases from "./data/databases.json";
import modalInstances from "./data/modal-instances.json";
import models from "./data/models.json";

export type Database = {
  id: string;
  name: string;
  url: string;
  description: string;
  category: string;
  domain: "science" | "finance";
};

export type ModalInstance = {
  id: string;
  label: string;
  modalGpu: string | null;
  vram: number | null;
  pricePerHour: number;
  architecture: string | null;
  tier: "cpu" | "budget" | "mid" | "high" | "flagship" | "local";
  bestFor: string;
  description: string;
};

export type Model = {
  id: string;
  label: string;
  provider: string;
  tier: "budget" | "mid" | "high" | "flagship";
  context_length: number;
  pricing: { prompt: number; completion: number };
  modality: string | null;
  description: string;
  default?: boolean;
};

export type Skill = SidebarSkill;

export const LOCAL_INSTANCE: ModalInstance = {
  id: "local",
  label: "Local",
  modalGpu: null,
  vram: null,
  pricePerHour: 0,
  architecture: null,
  tier: "local",
  bestFor: "Default sandbox environment",
  description: "Run code in the built-in sandbox — no Modal compute needed.",
};

export const DATABASES = databases as Database[];
export const MODELS = models as Model[];
export const COMPUTE_INSTANCES = modalInstances as ModalInstance[];
export const DEFAULT_MODEL = MODELS.find((model) => model.default) ?? MODELS[0];

export function buildDatabaseContext(selected: Database[]): string {
  if (selected.length === 0) return "";
  const lines = selected.map((db) => `- ${db.name} (${db.url}): ${db.description}`);
  return `\n\n[Data Sources Available]\n${lines.join("\n")}`;
}

export function buildComputeContext(instance: ModalInstance | null): string {
  if (!instance) return "";
  if (instance.id === "cpu") {
    return "\n\n[Compute Instance]\nUse Modal with CPU-only compute (no GPU). Specify no gpu argument in @app.function().";
  }
  return `\n\n[Compute Instance]\nUse Modal with a ${instance.label} GPU (${instance.vram}GB VRAM, $${instance.pricePerHour}/hr). In your Modal code use gpu="${instance.modalGpu}" in @app.function(). Prefer this instance type unless the task explicitly requires a different one.`;
}

export function buildSkillsContext(selected: Skill[]): string {
  if (selected.length === 0) return "";
  const names = selected.map((skill) => `'${skill.name}'`).join(", ");
  return `\n\nMake sure to instruct the delegated expert to use the skills: ${names}`;
}

export function augmentSidebarPromptText(options: {
  text: string;
  selectedDatabases: Database[];
  selectedCompute: ModalInstance | null;
  selectedSkills: Skill[];
}): string {
  const prompt = options.text.trim();
  if (!prompt) {
    return "";
  }

  return [
    prompt,
    buildDatabaseContext(options.selectedDatabases),
    buildComputeContext(options.selectedCompute),
    buildSkillsContext(options.selectedSkills),
  ].join("");
}


export function createSidebarChatRequest(options: {
  prompt: string;
  modelId: string;
  selectedDatabases: Database[];
  selectedCompute: ModalInstance | null;
  selectedSkills: Skill[];
}) {
  return {
    text: augmentSidebarPromptText({
      text: options.prompt,
      selectedDatabases: options.selectedDatabases,
      selectedCompute: options.selectedCompute,
      selectedSkills: options.selectedSkills,
    }),
    modelId: options.modelId,
  };
}
