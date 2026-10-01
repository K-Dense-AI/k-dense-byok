import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mcp from "@/lib/mcp";
import * as useProjects from "@/lib/use-projects";
import { ConnectorsPanel, configFromForm, type McpFormState } from "@/components/connectors-panel";

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.spyOn(useProjects, "useProjects").mockReturnValue({
    activeProject: { id: "p1", name: "P1" },
    activeProjectId: "p1",
  } as unknown as ReturnType<typeof useProjects.useProjects>);
  vi.spyOn(mcp, "getMcpAuthProviders").mockResolvedValue([
    { id: "radius", name: "Radius", connected: true },
    { id: "github-copilot", name: "GitHub Copilot", connected: false },
  ]);
  vi.spyOn(mcp, "getRadiusConnector").mockResolvedValue({
    signedIn: false,
    configured: false,
    name: null,
    url: "https://radius.pi.dev/mcp",
  });
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
  const base: McpFormState = {
    originalName: "docs",
    base: null,
    name: "docs",
    type: "http",
    url: "https://example.com/mcp",
    bearerToken: "",
    command: "",
    args: "",
    env: "",
    exposure: "codemode",
    description: "",
    authMode: "oauth",
    authProvider: "",
    oauthClientName: "",
    oauthMetadataUrl: "",
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
      authMode: "bearer",
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

  it("writes a description and drops it when cleared", () => {
    const stored = { url: "https://example.com/mcp", description: "Old text" };
    expect(configFromForm({ ...base, base: stored, description: "  Lab issue tracker " })).toEqual({
      url: "https://example.com/mcp",
      description: "Lab issue tracker",
    });
    expect(configFromForm({ ...base, base: stored, description: "" })).toEqual({
      url: "https://example.com/mcp",
    });
    expect(
      configFromForm({ ...base, type: "stdio", command: "npx", description: "Local files" }),
    ).toEqual({ command: "npx", description: "Local files" });
  });

  it("authenticates with a signed-in provider instead of OAuth or a token", () => {
    const config = configFromForm({
      ...base,
      base: {
        url: "https://old/mcp",
        headers: { Authorization: "Bearer stale", "X-Team": "a" },
        oauth: { clientId: "abc" },
      },
      authMode: "provider",
      authProvider: "radius",
      bearerToken: "stale",
    });
    expect(config).toEqual({
      url: "https://example.com/mcp",
      headers: { "X-Team": "a" },
      auth: { provider: "radius" },
    });
    // Round trip, then switch back to OAuth: `auth` goes away.
    const name = "radius";
    const back = configFromForm({ ...base, base: config, name, authMode: "oauth" });
    expect(back).toEqual({ url: "https://example.com/mcp", headers: { "X-Team": "a" } });
    // `auth` is an HTTP-only field.
    expect(
      configFromForm({ ...base, base: config, type: "stdio", command: "npx", authMode: "provider", authProvider: "radius" }),
    ).toEqual({ command: "npx" });
  });

  it("edits advanced OAuth fields and keeps the other oauth keys", () => {
    const stored = {
      url: "https://example.com/mcp",
      oauth: { clientId: "abc", scope: "read", clientName: "old", authServerMetadataUrl: "https://old/meta" },
    };
    expect(
      configFromForm({
        ...base,
        base: stored,
        oauthClientName: " Kady ",
        oauthMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      }),
    ).toEqual({
      url: "https://example.com/mcp",
      oauth: {
        clientId: "abc",
        scope: "read",
        clientName: "Kady",
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
    });
    // Clearing both removes the keys; an oauth block left empty disappears.
    expect(configFromForm({ ...base, base: { url: "x", oauth: { clientName: "old" } } })).toEqual({
      url: "https://example.com/mcp",
    });
  });
});

describe("mcp helpers", () => {
  it("treats the codemode-deferred alias as codemode", () => {
    expect(mcp.exposureOf({ url: "x", exposure: "codemode-deferred" })).toBe("codemode");
    expect(mcp.exposureOf({ url: "x", exposure: "direct" })).toBe("direct");
    expect(mcp.MCP_EXPOSURE_OPTIONS.map((o) => o.value)).not.toContain("codemode-deferred");
  });

  it("does not treat a provider-token server as an OAuth sign-in", () => {
    expect(mcp.usesOAuth({ url: "https://radius.pi.dev/mcp" })).toBe(true);
    expect(mcp.usesOAuth({ url: "https://radius.pi.dev/mcp", auth: { provider: "radius" } })).toBe(false);
  });

  it("finds names that share a tool namespace", () => {
    expect(mcp.namespaceClash("my-server", ["my_server", "other"])).toBe("my_server");
    expect(mcp.namespaceClash("my-server", ["my-server", "other"])).toBeNull();
  });
});

describe("ConnectorsPanel provider sign-ins", () => {
  it("suggests the Radius connector once signed in to Radius", async () => {
    vi.spyOn(mcp, "getMcpListing").mockResolvedValue({ mcpServers: {}, shared: [] });
    const status = { signedIn: true, configured: false, name: null, url: "https://radius.pi.dev/mcp" };
    vi.spyOn(mcp, "getRadiusConnector")
      .mockResolvedValueOnce(status)
      .mockResolvedValue({ ...status, configured: true, name: "radius" });
    const add = vi.spyOn(mcp, "addRadiusConnector").mockResolvedValue({ name: "radius", replaced: false });
    render(<ConnectorsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Add Radius connector" }));
    await waitFor(() => expect(add).toHaveBeenCalled());
    expect(await screen.findByText(/Added the Radius connector for all projects/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Radius connector" })).not.toBeInTheDocument();
  });

  it("labels provider-token servers and offers no OAuth sign-in for them", async () => {
    vi.spyOn(mcp, "getMcpListing").mockResolvedValue({
      mcpServers: { radius: { url: "https://radius.pi.dev/mcp", auth: { provider: "radius" } } },
      shared: [],
    });
    vi.spyOn(mcp, "getMcpStatus").mockResolvedValue({
      servers: [{ name: "radius", scope: "project", enabled: true, exposure: "codemode", state: "needs-auth", tools: [] }],
      errors: [],
    });
    render(<ConnectorsPanel />);
    expect(await screen.findByText(/via Radius/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /check status/i }));
    expect(await screen.findByText("Needs sign-in")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign in$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Providers" })).toBeInTheDocument();
  });

  it("offers sign-out only for connectors Pi holds OAuth tokens for", async () => {
    vi.spyOn(mcp, "getMcpListing").mockResolvedValue({
      mcpServers: {
        docs: { url: "https://docs.example/mcp" },
        paperclip: { url: "https://paperclip.gxl.ai/mcp", headers: { "X-API-Key": "${PAPERCLIP_API_KEY}" } },
      },
      shared: [],
    });
    vi.spyOn(mcp, "getMcpStatus").mockResolvedValue({
      servers: [
        { name: "docs", scope: "project", enabled: true, exposure: "codemode", state: "connected", tools: ["a"], signedIn: true },
        { name: "paperclip", scope: "project", enabled: true, exposure: "codemode", state: "connected", tools: ["b"], signedIn: false },
      ],
      errors: [],
    });
    const logout = vi.spyOn(mcp, "mcpLogout").mockResolvedValue(undefined);
    render(<ConnectorsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /check status/i }));
    expect(await screen.findAllByText("Connected · 1 tool")).toHaveLength(2);
    const signOut = screen.getAllByRole("button", { name: /sign out/i });
    expect(signOut).toHaveLength(1);
    await userEvent.click(signOut[0]);
    await waitFor(() => expect(logout).toHaveBeenCalledWith("docs"));
  });

  it("refuses a name that folds onto an existing connector", async () => {
    vi.spyOn(mcp, "getMcpListing").mockResolvedValue({
      mcpServers: { my_server: { url: "https://a.example/mcp" } },
      shared: [],
    });
    const save = vi.spyOn(mcp, "saveMcpServers").mockResolvedValue();
    render(<ConnectorsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /add connector/i }));
    await userEvent.type(screen.getByPlaceholderText("e.g. linear"), "my-server");
    await userEvent.type(screen.getByPlaceholderText("https://mcp.example.com/mcp"), "https://b.example/mcp");
    await userEvent.click(screen.getByRole("button", { name: "Add connector" }));
    expect(await screen.findByText(/would share tool names with “my_server”/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
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
