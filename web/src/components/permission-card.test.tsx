import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as projects from "@/lib/projects";
import { PermissionCard, parsePermissionPayload } from "./permission-card";
import type { ActivityItem } from "@/lib/use-agent";

const item = (overrides: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "perm_1",
  label: "Permission needed",
  status: "running",
  timestamp: 1,
  toolName: "permission",
  args: { toolCallId: "tc1", toolName: "bash", command: "rm -rf results", reason: "Destructive shell command: rm -rf results" },
  ...overrides,
});

describe("PermissionCard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses the payload defensively", () => {
    expect(parsePermissionPayload(null)).toEqual({});
    expect(parsePermissionPayload({ command: "rm -rf x", reason: 3 })).toEqual({ command: "rm -rf x", toolCallId: undefined, toolName: undefined, reason: undefined, outcome: undefined });
  });

  it("posts the decision to the permissions route", async () => {
    const calls: Array<{ path: string; body?: string }> = [];
    vi.spyOn(projects, "apiFetch").mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ ok: true }));
    });
    render(<PermissionCard item={item()} sessionId="s1" projectId="p" />);
    expect(screen.getByText("Kady wants to run a destructive command")).toBeInTheDocument();
    expect(screen.getByText("rm -rf results")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: "/sessions/s1/permissions/perm_1", body: JSON.stringify({ allow: true }) });
  });

  it("shows the outcome once resolved and hides the buttons", () => {
    render(
      <PermissionCard
        item={item({ status: "error", args: { command: "rm -rf results", outcome: "denied" } })}
        sessionId="s1"
        projectId="p"
      />,
    );
    expect(screen.getByText("Denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });
});
