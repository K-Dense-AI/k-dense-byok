import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as lib from "@/lib/custom-models";
import { CustomModelsCard, providersFromDrafts } from "./custom-models-card";

afterEach(() => vi.restoreAllMocks());

describe("providersFromDrafts", () => {
  it("normalizes drafts and reports the first problem", () => {
    const ok = providersFromDrafts([
      {
        id: "HPC-VLLM",
        name: "Lab",
        baseUrl: "http://gpu:8000/v1",
        api: "openai-completions",
        apiKey: "",
        models: [
          { id: "llama", name: "", contextWindow: "128000", maxTokens: "", reasoning: true, image: false, costInput: "0.5", costOutput: "1.5" },
          { id: "  ", name: "", contextWindow: "", maxTokens: "", reasoning: false, image: false, costInput: "0", costOutput: "0" },
        ],
      },
    ]);
    expect(ok).toEqual([
      {
        id: "hpc-vllm",
        name: "Lab",
        baseUrl: "http://gpu:8000/v1",
        api: "openai-completions",
        models: [{ id: "llama", reasoning: true, input: ["text"], contextWindow: 128000, cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 } }],
      },
    ]);
    expect(providersFromDrafts([{ id: "", name: "", baseUrl: "x", api: "openai-completions", apiKey: "", models: [] }])).toMatch(/needs an id/);
    expect(providersFromDrafts([{ id: "a", name: "", baseUrl: "http://x", api: "openai-completions", apiKey: "", models: [] }])).toMatch(/at least one model/);
  });
});

describe("CustomModelsCard", () => {
  it("lists foreign providers read-only, edits a managed one and saves", async () => {
    vi.spyOn(lib, "getCustomProviders").mockResolvedValue([
      { id: "mine", baseUrl: "http://x/v1", api: "openai-completions", models: [{ id: "m" }], managed: false },
      { id: "hpc-vllm", name: "Lab", baseUrl: "http://gpu:8000/v1", api: "openai-completions", apiKey: "$K", models: [{ id: "llama", cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 } }], managed: true },
    ]);
    const save = vi.spyOn(lib, "saveCustomProviders").mockImplementation(async (providers) => ({
      providers: providers.map((p) => ({ ...p, managed: true })),
      configured: { "hpc-vllm": false },
    }));
    render(<CustomModelsCard />);
    expect(await screen.findByText("mine")).toBeInTheDocument();
    const baseUrl = screen.getByLabelText("Server 1 base URL");
    expect(baseUrl).toHaveValue("http://gpu:8000/v1");
    await userEvent.clear(baseUrl);
    await userEvent.type(baseUrl, "http://gpu-2:8000/v1");
    await userEvent.click(screen.getByRole("button", { name: "Save servers" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: "hpc-vllm", baseUrl: "http://gpu-2:8000/v1", apiKey: "$K", models: [expect.objectContaining({ id: "llama", cost: expect.objectContaining({ input: 0.5, output: 1.5 }) })] }),
    ]);
    expect(await screen.findByText(/could not resolve credentials for: hpc-vllm/)).toBeInTheDocument();
  });

  it("adds a server and refuses to save an incomplete one", async () => {
    vi.spyOn(lib, "getCustomProviders").mockResolvedValue([]);
    const save = vi.spyOn(lib, "saveCustomProviders");
    render(<CustomModelsCard />);
    await screen.findByText("Custom model servers");
    await userEvent.click(screen.getByRole("button", { name: "Add server" }));
    await userEvent.click(screen.getByRole("button", { name: "Save servers" }));
    expect(await screen.findByText("Every server needs an id")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });
});
