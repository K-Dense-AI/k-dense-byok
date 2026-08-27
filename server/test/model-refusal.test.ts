// server/test/model-refusal.test.ts
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  KNOWN_REFUSAL_TRIGGER_SKILLS,
  explainProviderRefusal,
  isProviderRefusal,
  providerRefusalGuidance,
} from "../src/agent/model-refusal.ts";
import { toClientFrame } from "../src/agent/events.ts";
import { makeSubagentRefusalExtension } from "../src/agent/subagent-bridge.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

function installSkill(skillsDir: string, name: string): void {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill\n---\n\nBody.\n`,
    "utf-8",
  );
}

beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("isProviderRefusal", () => {
  it("recognizes the strings providers and Pi actually emit", () => {
    // Pi's openai-completions API maps OpenRouter's finish_reason verbatim.
    expect(isProviderRefusal("Provider finish_reason: content_filter")).toBe(true);
    expect(isProviderRefusal("finish_reason: refusal")).toBe(true);
    expect(isProviderRefusal('stop_reason: "refusal"')).toBe(true);
    expect(isProviderRefusal("Content Filter triggered")).toBe(true);
  });

  it("does not fire on other provider failures", () => {
    expect(isProviderRefusal("Provider finish_reason: network_error")).toBe(false);
    expect(isProviderRefusal("429 rate limit exceeded")).toBe(false);
    expect(isProviderRefusal(undefined)).toBe(false);
    expect(isProviderRefusal("")).toBe(false);
  });

  it("ignores the bare word in prose, which would attach misleading advice", () => {
    expect(isProviderRefusal("The tool returned a refusal from the remote host")).toBe(
      false,
    );
  });
});

describe("providerRefusalGuidance", () => {
  it("names the enabled skills known to trigger a refusal", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    installSkill(paths.skillsDir, KNOWN_REFUSAL_TRIGGER_SKILLS[0]);
    installSkill(paths.skillsDir, "statistical-analysis");

    const text = providerRefusalGuidance({
      projectId: "p1",
      modelRef: "openrouter/anthropic/claude-fable-5",
    });
    expect(text).toContain(KNOWN_REFUSAL_TRIGGER_SKILLS[0]);
    expect(text).not.toContain("statistical-analysis");
    expect(text).toContain("Settings → Skills");
    // The model is named so the user can tell it is not their message at fault.
    expect(text).toContain("openrouter/anthropic/claude-fable-5");
  });

  it("points elsewhere when no known trigger is enabled", () => {
    ensureProjectExists("p2");
    installSkill(resolvePaths("p2").skillsDir, "statistical-analysis");

    const text = providerRefusalGuidance({ projectId: "p2" });
    expect(text).toContain("No skill known to trigger this is enabled");
    expect(text).not.toContain("Settings → Skills");
  });

  it("survives a project with no skills directory at all", () => {
    // Guidance decorates an error that already happened; it must never throw.
    expect(() => providerRefusalGuidance({ projectId: "missing-project" })).not.toThrow();
  });
});

describe("explainProviderRefusal", () => {
  it("appends guidance without discarding the provider's own words", () => {
    ensureProjectExists("p3");
    installSkill(resolvePaths("p3").skillsDir, KNOWN_REFUSAL_TRIGGER_SKILLS[0]);

    const out = explainProviderRefusal("Provider finish_reason: content_filter", {
      projectId: "p3",
      modelRef: "openrouter/anthropic/claude-fable-5",
    });
    expect(out.startsWith("Provider finish_reason: content_filter")).toBe(true);
    expect(out).toContain("refused this request before generating anything");
  });

  it("passes unrelated errors through byte-for-byte", () => {
    const message = "Provider finish_reason: network_error";
    expect(explainProviderRefusal(message, { projectId: "p4" })).toBe(message);
  });
});

describe("toClientFrame error mapping", () => {
  it("carries the provider's errorMessage instead of a generic label", () => {
    const frame = toClientFrame({
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { errorMessage: "Provider finish_reason: content_filter" },
      },
    } as never);
    expect(frame).toEqual({
      type: "error",
      message: "Model error: Provider finish_reason: content_filter",
      reason: "error",
    });
  });

  it("falls back to the reason when the provider said nothing", () => {
    const frame = toClientFrame({
      type: "message_update",
      assistantMessageEvent: { type: "error", reason: "aborted", error: {} },
    } as never);
    expect(frame).toEqual({ type: "error", message: "Model error (aborted)", reason: "aborted" });
  });
});

/** Fake ExtensionAPI capturing the handlers the extension registers. */
function fakePi() {
  const onHandlers: Record<string, (e: unknown) => unknown> = {};
  return {
    onHandlers,
    api: {
      on: (name: string, h: (e: unknown) => unknown) => {
        onHandlers[name] = h;
      },
      events: { on: () => {} },
      registerTool: () => {},
    },
  };
}

describe("makeSubagentRefusalExtension", () => {
  it("appends guidance to a refused child's tool result, keeping the original text", async () => {
    ensureProjectExists("p5");
    installSkill(resolvePaths("p5").skillsDir, KNOWN_REFUSAL_TRIGGER_SKILLS[0]);

    const pi = fakePi();
    makeSubagentRefusalExtension("p5", () => ({
      provider: "openrouter",
      id: "anthropic/claude-fable-5",
    }) as never)(pi.api as never);

    const result = (await pi.onHandlers.tool_result({
      toolName: "subagent",
      content: [{ type: "text", text: "Provider finish_reason: content_filter" }],
      isError: true,
    })) as { content: Array<{ type: string; text: string }> };

    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toBe("Provider finish_reason: content_filter");
    expect(result.content[1].text).toContain(KNOWN_REFUSAL_TRIGGER_SKILLS[0]);
    expect(result.content[1].text).toContain("openrouter/anthropic/claude-fable-5");
  });

  it("covers subagent_wait, where async children report their failure", async () => {
    ensureProjectExists("p6");
    const pi = fakePi();
    makeSubagentRefusalExtension("p6")(pi.api as never);

    const result = await pi.onHandlers.tool_result({
      toolName: "subagent_wait",
      content: [{ type: "text", text: "run failed: Provider finish_reason: content_filter" }],
      isError: true,
    });
    expect(result).toBeTruthy();
  });

  it("leaves other tools and non-refusal failures untouched", async () => {
    ensureProjectExists("p7");
    const pi = fakePi();
    makeSubagentRefusalExtension("p7")(pi.api as never);

    expect(
      await pi.onHandlers.tool_result({
        toolName: "bash",
        content: [{ type: "text", text: "Provider finish_reason: content_filter" }],
        isError: true,
      }),
    ).toBeUndefined();
    expect(
      await pi.onHandlers.tool_result({
        toolName: "subagent",
        content: [{ type: "text", text: "child finished: 3 files reviewed" }],
        isError: false,
      }),
    ).toBeUndefined();
  });
});
