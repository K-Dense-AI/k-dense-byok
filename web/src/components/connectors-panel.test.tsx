import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mcp from "@/lib/mcp";
import * as useProjects from "@/lib/use-projects";
import { ConnectorsPanel } from "@/components/connectors-panel";

afterEach(() => vi.restoreAllMocks());

describe("ConnectorsPanel", () => {
  it("shows enabled + disabled connectors and re-enables one", async () => {
    vi.spyOn(useProjects, "useProjects").mockReturnValue({
      activeProject: { id: "p1", name: "P1" },
      activeProjectId: "p1",
    } as unknown as ReturnType<typeof useProjects.useProjects>);
    vi.spyOn(mcp, "getMcpListing").mockResolvedValue({
      mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } },
      disabledServers: { gh: { command: "npx", args: [] } },
    });
    const setSpy = vi.spyOn(mcp, "setConnectorEnabled").mockResolvedValue();

    render(<ConnectorsPanel />);
    expect(await screen.findByText("linear")).toBeInTheDocument();
    expect(screen.getByText("gh")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: /toggle gh/i }));
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("gh", true));
  });
});
