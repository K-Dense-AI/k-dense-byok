import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResearchPickerBody } from "./research-picker";
import { memoryHit, memorySearch } from "@/test/memory-fixture";
import type { ResearchRef } from "@/lib/composer-context";

vi.mock("@/lib/projects", async (original) => ({ ...await original<typeof import("@/lib/projects")>(), apiFetch: vi.fn() }));
const { apiFetch } = await import("@/lib/projects");
const fetch = vi.mocked(apiFetch);
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

const notebook = {
  entries: [
    { id: "h1", type: "hypothesis", title: "Old hypothesis", timestamp: 1, sessionId: "s-a" },
    { id: "h2", type: "hypothesis", title: "Revised hypothesis", timestamp: 3, sessionId: "s-a", supersedes: "h1", body: "Cells cluster by batch." },
    { id: "o1", type: "observation", title: "Batch dominates PC1", timestamp: 2, sessionId: "s-b" },
  ],
};
const sessions = [
  { id: "current", name: null, modified: 5, messageCount: 4, firstMessage: "This chat" },
  { id: "older", name: null, modified: 4, messageCount: 6, firstMessage: "Run QC on counts.csv" },
  { id: "empty", name: null, modified: 3, messageCount: 0, firstMessage: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  fetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith("/memory/search")) return json(memorySearch);
    if (u.endsWith("/notebook")) return json(notebook);
    if (u === "/sessions") return json(sessions);
    return json({}, false);
  });
});

function setup(selected: ResearchRef[] = []) {
  const onChange = vi.fn();
  render(<ResearchPickerBody projectId="project-a" currentSessionId="current" selected={selected} onChange={onChange} />);
  return { onChange, user: userEvent.setup() };
}

describe("ResearchPickerBody", () => {
  it("lists recent notebook entries newest first, hiding amended ones", async () => {
    const { onChange, user } = setup();
    await screen.findByText("Revised hypothesis");
    expect(fetch.mock.calls[0][0]).toBe("/projects/project-a/notebook");
    expect(screen.queryByText("Old hypothesis")).toBeNull();
    const rows = screen.getAllByRole("checkbox");
    expect(rows[0]).toHaveTextContent("Revised hypothesis");
    await user.click(rows[0]);
    expect(onChange).toHaveBeenCalledWith([
      { kind: "record", type: "hypothesis", title: "Revised hypothesis", source: { kind: "notebook", sessionId: "s-a", entryId: "h2" } },
    ]);
  });

  it("searches research memory and keeps the hit's source and digest", async () => {
    const { onChange, user } = setup();
    await screen.findByText("Revised hypothesis");
    await user.type(screen.getByLabelText("Search research records"), "Harmony");
    await screen.findByText(memoryHit.title);
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith("/memory/search"))!;
    expect(call[2]).toBe("project-a");
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ query: "Harmony", limit: 12 });
    await user.click(screen.getByRole("checkbox", { name: new RegExp(memoryHit.title) }));
    expect(onChange).toHaveBeenCalledWith([
      { kind: "record", type: memoryHit.type, title: memoryHit.title, source: memoryHit.source, digest: memoryHit.digest },
    ]);
  });

  it("filters by record type without a query", async () => {
    const { user } = setup();
    await screen.findByText("Revised hypothesis");
    await user.click(screen.getByRole("button", { name: "Decisions" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/memory/search"))).toBe(true));
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith("/memory/search"))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ query: "", limit: 12, type: "decision" });
  });

  it("offers earlier chats, excluding this one and empty ones, and deselects", async () => {
    const picked: ResearchRef = { kind: "chat", sessionId: "older", title: "Run QC on counts.csv" };
    const { onChange, user } = setup([picked]);
    await user.click(screen.getByRole("radio", { name: "Chats" }));
    const row = await screen.findByRole("checkbox", { name: /Run QC on counts.csv/ });
    expect(row).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("This chat")).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    await user.click(row);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("shows a search failure instead of an empty list", async () => {
    fetch.mockImplementation(async () => json({ detail: "Enter a query" }, false));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Notebook unavailable (500)");
  });
});
