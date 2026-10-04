import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DelegatePickerBody } from "./delegate-picker";
import { EMPTY_DELEGATION, type DelegationChoice } from "@/lib/composer-context";
import type { AgentFile } from "@/lib/agents";

vi.mock("@/lib/agents", () => ({ getAgents: vi.fn() }));
vi.mock("@/lib/settings-nav", () => ({ openSettings: vi.fn() }));
const { getAgents } = await import("@/lib/agents");
const { openSettings } = await import("@/lib/settings-nav");

const agent = (name: string, extra: Partial<AgentFile> = {}): AgentFile => ({
  name, description: `${name} does things`, source: "builtin", systemPrompt: "", ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAgents).mockResolvedValue([
    agent("scout"),
    agent("reviewer", { verifier: true }),
    agent("evidence-auditor", { verifier: true }),
    agent("claude-code", { enabled: false }),
  ]);
});

let latest: DelegationChoice = EMPTY_DELEGATION;
function Harness({ initial = EMPTY_DELEGATION }: { initial?: DelegationChoice }) {
  const [value, setValue] = useState(initial);
  latest = value;
  return <DelegatePickerBody value={value} onChange={setValue} />;
}

describe("DelegatePickerBody", () => {
  it("lists enabled specialists and flags verifiers", async () => {
    render(<Harness />);
    await screen.findByText("scout");
    expect(screen.queryByText("claude-code")).toBeNull();
    expect(screen.getAllByText("verifier")).toHaveLength(2);
    expect(screen.getByText(/best-suited verifier specialist \(2 enabled\)/)).toBeInTheDocument();
  });

  it("keeps 'Kady chooses' and named specialists mutually exclusive", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByText("scout");
    await user.click(screen.getByRole("checkbox", { name: /Let Kady choose/ }));
    expect(latest).toMatchObject({ auto: true, specialists: [] });
    await user.click(screen.getByRole("checkbox", { name: /^scout/ }));
    expect(latest).toMatchObject({ auto: false, specialists: ["scout"] });
    await user.click(screen.getByRole("checkbox", { name: /^reviewer/ }));
    expect(latest.specialists).toEqual(["scout", "reviewer"]);
    await user.click(screen.getByRole("checkbox", { name: /^scout/ }));
    expect(latest.specialists).toEqual(["reviewer"]);
  });

  it("captures the enabled verifiers with the verification toggle", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByText("scout");
    await user.click(screen.getByRole("switch", { name: "Verify before accepting" }));
    expect(latest).toMatchObject({ verify: true, verifiers: ["evidence-auditor", "reviewer"] });
    await user.click(screen.getByRole("switch", { name: "Verify before accepting" }));
    expect(latest).toMatchObject({ verify: false, verifiers: [] });
  });

  it("fills in verifiers for a toggle set before the roster loaded", async () => {
    render(<Harness initial={{ ...EMPTY_DELEGATION, verify: true }} />);
    await screen.findByText("scout");
    expect(latest.verifiers).toEqual(["evidence-auditor", "reviewer"]);
  });

  it("links to the specialists settings", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Manage specialists" }));
    expect(openSettings).toHaveBeenCalledWith({ tab: "specialists" });
  });
});
