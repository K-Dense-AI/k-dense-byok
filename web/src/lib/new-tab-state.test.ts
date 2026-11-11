import { describe, expect, it } from "vitest";
import { seedChatStateFromTab } from "@/lib/new-tab-state";
import type { ChatWorkspaceState } from "@/lib/workspace-persistence";
import type { Model } from "@/components/model-selector";
import type { ModalInstance } from "@/components/compute-selector";

const model = { id: "openrouter/anthropic/claude-opus-5", label: "Claude Opus 5" } as Model;
const compute = { id: "cpu-2", label: "CPU · 2 cores" } as ModalInstance;

const source: ChatWorkspaceState = {
  selectedModel: model,
  thinkingLevel: "low",
  selectedComputeTarget: compute,
  attachedFiles: ["user_data/a.csv"],
  selectedDatabases: [{ name: "arxiv" }] as ChatWorkspaceState["selectedDatabases"],
  selectedSkills: [{ name: "phylogenetics" }] as ChatWorkspaceState["selectedSkills"],
  queuedMessages: [{ id: "q1" }] as unknown as ChatWorkspaceState["queuedMessages"],
  composer: { text: "half-typed prompt", attachments: [] },
};

describe("seedChatStateFromTab", () => {
  it("returns null when there is no source tab", () => {
    expect(seedChatStateFromTab(undefined)).toBeNull();
  });

  it("carries over the model, thinking level, and compute target", () => {
    const seeded = seedChatStateFromTab(source)!;
    expect(seeded.selectedModel).toBe(model);
    expect(seeded.thinkingLevel).toBe("low");
    expect(seeded.selectedComputeTarget).toBe(compute);
  });

  it("does not carry over conversation-specific content", () => {
    const seeded = seedChatStateFromTab(source)!;
    expect(seeded.attachedFiles).toEqual([]);
    expect(seeded.selectedDatabases).toEqual([]);
    expect(seeded.selectedSkills).toEqual([]);
    expect(seeded.queuedMessages).toEqual([]);
    expect(seeded.composer).toEqual({ text: "", attachments: [] });
  });

  it("does not mutate the source tab's state", () => {
    seedChatStateFromTab(source);
    expect(source.attachedFiles).toEqual(["user_data/a.csv"]);
    expect(source.composer.text).toBe("half-typed prompt");
  });
});
