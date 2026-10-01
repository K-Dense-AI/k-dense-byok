import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as projectsLib from "@/lib/projects";
import * as useProjectsLib from "@/lib/use-projects";
import { ServicesPanel } from "@/components/settings/services-panel";

type Connector = {
  keySet: boolean;
  name: string | null;
  usesKey: boolean;
  enabled: boolean;
  url: string;
};

const URL_ = "https://paperclip.gxl.ai/mcp";
let connector: Connector;
let credentials: Record<string, { set: boolean; masked: string | null }>;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  connector = { keySet: false, name: null, usesKey: false, enabled: false, url: URL_ };
  credentials = { paperclip: { set: false, masked: null } };
  fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/credentials" && init?.method === "PUT") {
      credentials = { paperclip: { set: true, masked: "gxl_…6789" } };
      connector = { keySet: true, name: "paperclip", usesKey: true, enabled: true, url: URL_ };
      return json(credentials);
    }
    if (path === "/credentials") return json(credentials);
    if (path === "/mcp/paperclip" && init?.method === "POST") {
      connector = { ...connector, name: connector.name ?? "paperclip", usesKey: true, enabled: true };
      return json({ ok: true, name: connector.name, replaced: false });
    }
    if (path === "/mcp/paperclip") return json(connector);
    if (path === "/modal/cache") return json({ cache: null });
    return json({});
  });
  vi.spyOn(projectsLib, "apiFetch").mockImplementation(fetchMock as typeof projectsLib.apiFetch);
  vi.spyOn(useProjectsLib, "useProjects").mockReturnValue({
    activeProject: { id: "default", name: "Default" },
    activeProjectId: "default",
  } as unknown as ReturnType<typeof useProjectsLib.useProjects>);
});
afterEach(() => vi.restoreAllMocks());

const card = async () => {
  const legend = await screen.findByText("Paperclip literature search");
  return legend.closest("fieldset")!;
};

describe("Paperclip card", () => {
  it("links to where a key is issued, and to Connectors sign-in when there is no key", async () => {
    render(<ServicesPanel />);
    const scope = within(await card());
    const getKey = scope.getByRole("link", { name: /Get a key \(Paperclip API key\) at paperclip\.gxl\.ai/ });
    expect(getKey).toHaveAttribute("href", "https://paperclip.gxl.ai/keys");
    expect(getKey).toHaveAttribute("target", "_blank");
    expect(getKey).toHaveAttribute("rel", "noopener noreferrer");
    expect(await scope.findByText(/No key\?/)).toBeInTheDocument();
    expect(scope.getByRole("button", { name: "Connectors" })).toBeInTheDocument();
  });

  it("saving a key reports the connector it turned on", async () => {
    const user = userEvent.setup();
    render(<ServicesPanel />);
    const scope = within(await card());
    await user.type(scope.getByLabelText("Paperclip API key"), "gxl_test_key_6789");
    await user.click(scope.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/credentials",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ paperclipApiKey: "gxl_test_key_6789" }) }),
      ),
    );
    expect(await scope.findByText(/New chat tabs can search Paperclip/)).toBeInTheDocument();
    expect(await scope.findByRole("status")).toHaveTextContent("Connector paperclip is on for every project.");
  });

  it("drops a rejected key's error once the field is edited", async () => {
    const user = userEvent.setup();
    const base = fetchMock.getMockImplementation() as (path: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (path: string, init?: RequestInit) =>
      path === "/credentials" && init?.method === "PUT"
        ? json({ detail: "Paperclip rejected this API key. Check it at https://paperclip.gxl.ai/keys." }, 400)
        : base(path, init),
    );
    render(<ServicesPanel />);
    const scope = within(await card());
    const input = scope.getByLabelText("Paperclip API key");
    await user.type(input, "gxl_wrong");
    await user.click(scope.getByRole("button", { name: "Save" }));
    expect(await scope.findByText(/Paperclip rejected this API key/)).toBeInTheDocument();
    await user.clear(input);
    expect(scope.queryByText(/Paperclip rejected this API key/)).not.toBeInTheDocument();
  });

  it("turns a disabled key-backed connector back on", async () => {
    const user = userEvent.setup();
    credentials = { paperclip: { set: true, masked: "gxl_…6789" } };
    connector = { keySet: true, name: "paperclip", usesKey: true, enabled: false, url: URL_ };
    render(<ServicesPanel />);
    const scope = within(await card());
    expect(await scope.findByRole("status")).toHaveTextContent("Connector paperclip is turned off.");
    await user.click(scope.getByRole("button", { name: "Turn on" }));
    expect(await scope.findByText(/is on for every project/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/mcp/paperclip", { method: "POST" });
  });
});
