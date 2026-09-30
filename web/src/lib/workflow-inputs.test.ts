import { describe, expect, it } from "vitest";
import workflows from "@/data/workflows.json";
import { buildWorkflowPrompt } from "./workflow-inputs";

describe("workflow prompt handoff", () => {
  it("preserves the task and distinguishes project attachments from unverified references", () => {
    const task = "Analyze {literal text} without changing any numbers.";
    const prompt = buildWorkflowPrompt(task, ["user_data/a.csv", "user_data/a.csv"], " /mnt/raw/ \r\n\ns3://bucket/a.csv\n/mnt/raw/ ");
    expect(prompt.startsWith(task)).toBe(true);
    expect(prompt.match(/"user_data\/a.csv"/g)).toHaveLength(1);
    expect(prompt.match(/"\/mnt\/raw\/"/g)).toHaveLength(1);
    expect(prompt).toContain("references, not uploaded attachments");
  });

  it("encodes spaces, quotes and newlines in file names as data", () => {
    const file = 'study/a "quoted"\nfile.csv';
    const source = "C:\\Study data\\a.csv";
    const prompt = buildWorkflowPrompt("Analyze.", [file], source);
    expect(prompt).toContain(JSON.stringify(file));
    expect(prompt).toContain(JSON.stringify(source));
  });

  it("passes selected folders as distinct, deduplicated sandbox references", () => {
    const folder = 'results/a "quoted"\nstudy';
    const prompt = buildWorkflowPrompt("Analyze.", ["metadata.csv"], "/mnt/raw/", [folder, folder]);
    expect(prompt.split(JSON.stringify(folder))).toHaveLength(2);
    expect(prompt).toContain("Selected project folders (paths relative to the project sandbox)");
    expect(prompt).toContain('"metadata.csv"');
    expect(prompt).toContain('"/mnt/raw/"');
  });

  it("keeps the complete catalogue valid and independent of upload location", () => {
    expect(workflows.length).toBeGreaterThan(0);
    expect(new Set(workflows.map((w) => w.id)).size).toBe(workflows.length);
    for (const workflow of workflows) {
      expect(workflow.prompt).not.toMatch(/\buploaded\b|available local resources|exceeds local capacity/i);
      expect(workflow.description).not.toMatch(/\buploaded\b/i);
      for (const placeholder of workflow.placeholders) expect(workflow.prompt).toContain(`{${placeholder.key}}`);
    }
  });
});
