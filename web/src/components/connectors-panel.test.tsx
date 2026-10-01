import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mcp from "@/lib/mcp";
import * as useProjects from "@/lib/use-projects";
import { ConnectorsPanel, configFromForm } from "@/components/connectors-panel";

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.spyOn(useProjects, "useProjects").mockReturnValue({
    activeProject: { id: "p1", name: "P1" },
    activeProjectId: "p1",
  } as unknown as ReturnType<typeof useProjects.useProjects>);
});

describe("ConnectorsPanel", () => {
  it("lists enabled and disabled connectors in one list and re-enables one", async () => {
    vi.spyOn(mcp, "getMcpListing").mockResolvedValue({
      mcpServers: {
        linear: { url: "https://mcp.linear.app/mcp" },
        gh: { command: "npx", args: [], enabled: false },
      },
      shared: [],
    });
    const setSpy = vi.spyOn(mcp, "setConnectorEnabled").mockResolvedValue();

    render(<ConnectorsPanel />);
    expect(await screen.findByText("linear")).toBeInTheDocument();
    expect(screen.getByText("gh")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /toggle linear/i })).toBeChecked();

    await userEvent.click(screen.getByRole("switch", { name: /toggle gh/i }));
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("gh", true, "project"));
  });

  it("switches to the all-projects scope", async () => {
    const listing = vi.spyOn(mcp, "getMcpListing").mockResolvedValue({ mcpServers: {}, shared: [] });
    render(<ConnectorsPanel />);
    await screen.findByText(/No connectors configured for this project/);
    await userEvent.click(screen.getByRole("button", { name: "All projects" }));
    await waitFor(() => expect(listing).toHaveBeenLastCalledWith("global"));
    expect(await screen.findByText(/No connectors shared across projects/)).toBeInTheDocument();
  });

  it("shows live status and offers sign-in for servers that need it", async () => {
    vi.spyOn(mcp, "getMcpListing").mockResolvedValue({
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" }, fs: { command: "npx" } },
      shared: [],
    });
    vi.spyOn(mcp, "getMcpStatus").mockResolvedValue({
      servers: [
        { name: "sentry", scope: "project", enabled: true, exposure: "codemode", state: "needs-auth", tools: [] },
        { name: "fs", scope: "project", enabled: true, exposure: "codemode", state: "connected", tools: ["read", "list"] },
      ],
      errors: [],
    });
    const login = vi.spyOn(mcp, "startMcpLogin").mockResolvedValue({
      status: "running",
      authorizationUrl: "https://auth.example/authorize",
    });
    vi.spyOn(mcp, "getMcpLogin").mockResolvedValue({ status: "running" });

    render(<ConnectorsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /check status/i }));
    expect(await screen.findByText("Connected · 2 tools")).toBeInTheDocument();
    expect(screen.getByText("Needs sign-in")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("sentry"));
    expect(await screen.findByRole("link", { name: /open the sign-in page/i })).toHaveAttribute(
      "href",
      "https://auth.example/authorize",
    );
  });
});

describe("configFromForm", () => {
  const base = {
    originalName: "docs",
    name: "docs",
    type: "http" as const,
    url: "https://example.com/mcp",
    bearerToken: "",
    command: "",
    args: "",
    env: "",
    exposure: "codemode" as const,
  };

  it("keeps Pi fields the form does not edit and drops the default exposure", () => {
    const config = configFromForm({
      ...base,
      base: {
        url: "https://old.example/mcp",
        headers: { "X-Team": "a", Authorization: "Bearer old" },
        oauth: { scope: "read" },
        toolExposure: { "delete_*": "hidden" },
        exposure: "direct",
        timeout: 30,
        enabled: false,
      },
      bearerToken: "new",
    });
    expect(config).toEqual({
      url: "https://example.com/mcp",
      headers: { "X-Team": "a", Authorization: "Bearer new" },
      oauth: { scope: "read" },
      toolExposure: { "delete_*": "hidden" },
      timeout: 30,
      enabled: false,
    });
  });

  it("drops the other transport's fields when switching type", () => {
    const config = configFromForm({
      ...base,
      base: { url: "https://x/mcp", type: "http", headers: { A: "b" }, oauth: {}, timeout: 5 },
      type: "stdio",
      command: "uvx",
      args: "tools-mcp --flag",
      env: "KEY=${TOOLS_KEY}",
      exposure: "deferred",
    });
    expect(config).toEqual({
      command: "uvx",
      args: ["tools-mcp", "--flag"],
      env: { KEY: "${TOOLS_KEY}" },
      timeout: 5,
      exposure: "deferred",
    });
  });
});

describe("ConnectorsPanel removal", () => {
  it("asks before removing a connector", async () => {
    vi.spyOn(mcp, "getMcpListing").mockResolvedValue({
      mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } },
      shared: [],
    });
    const save = vi.spyOn(mcp, "saveMcpServers").mockResolvedValue();
    render(<ConnectorsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove linear" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(save).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove linear" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({}, "project"));
  });
});
