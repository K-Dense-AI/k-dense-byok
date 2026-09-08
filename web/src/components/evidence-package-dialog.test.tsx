import { createHash, webcrypto } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvidencePackageDialog } from "./evidence-package-dialog";
import { evidencePreview, evidenceRoot } from "@/test/evidence-package-fixture";
vi.mock("@/lib/projects", async (original) => ({ ...await original<typeof import("@/lib/projects")>(), apiFetch: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { apiFetch } = await import("@/lib/projects"); const fetch = vi.mocked(apiFetch);
const data = new Uint8Array([1, 2, 3, 4]);
const preview = { ...evidencePreview, zipBytes: data.length, zipSha256: createHash("sha256").update(data).digest("hex") };
const json = (value: unknown, ok = true) => ({ ok, json: async () => value }) as Response;
const props = { projectId: "project-a", candidates: [{ ...evidenceRoot, title: "Treatment effect", type: "hypothesis" }], initialRoot: evidenceRoot };
let downloadClick: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:package") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  downloadClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  fetch.mockImplementation(async (url) => {
    if (String(url).endsWith("/prepare")) return json(preview);
    if (String(url).endsWith("/download")) return { ok: true, headers: { get: () => preview.zipSha256 }, blob: async () => ({ size: data.length, arrayBuffer: async () => data.slice().buffer }) } as unknown as Response;
    return json({ packages: [], errors: [] });
  });
});
afterEach(() => { vi.unstubAllGlobals(); downloadClick.mockRestore(); });
async function prepare() {
  const user = userEvent.setup(); render(<EvidencePackageDialog {...props} />);
  await user.click(screen.getByRole("button", { name: "Evidence package" }));
  await user.click(screen.getByRole("button", { name: "Prepare review package" }));
  await screen.findByText(preview.manifest.title);
  return user;
}
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: /I reviewed the selected contents/ }));
  await user.click(screen.getByRole("checkbox", { name: /I understand the listed gaps/ }));
}
describe("reviewer evidence-package UI", () => {
  it("does not prepare, execute or download on render", () => {
    render(<EvidencePackageDialog {...props} />); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Evidence package" })); expect(fetch).not.toHaveBeenCalled();
  });
  it("prepares only selected roots with explicit inclusion options and presents version gaps", async () => {
    await prepare();
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ title: "Reviewer evidence package", roots: [evidenceRoot], includeArtifacts: true, includeCurrentUnverified: false, includeCommandArguments: false });
    expect(fetch.mock.calls[0][2]).toBe("project-a");
    expect(screen.getByText("Not reproduced.")).toBeInTheDocument();
    expect(screen.getByText("included-matched")).toBeInTheDocument(); expect(screen.getByText("unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download reviewed ZIP" })).toBeDisabled();
    expect(downloadClick).not.toHaveBeenCalled();
  });
  it("requires content/limitations acknowledgement and checks actual downloaded ZIP bytes", async () => {
    const user = await prepare(); await confirm(user);
    await user.click(screen.getByRole("button", { name: "Download reviewed ZIP" }));
    await waitFor(() => expect(downloadClick).toHaveBeenCalled());
    const call = fetch.mock.calls.find(([url]) => String(url).endsWith("/download"))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ digest: preview.digest, acknowledgeSensitive: true, acknowledgeLimitations: true });
  });
  it("does not save a same-size download whose checksum changed", async () => {
    const user = await prepare(); await confirm(user);
    fetch.mockResolvedValueOnce({ ok: true, headers: { get: () => preview.zipSha256 }, blob: async () => ({ size: 4, arrayBuffer: async () => new Uint8Array([9, 9, 9, 9]).buffer }) } as unknown as Response);
    await user.click(screen.getByRole("button", { name: "Download reviewed ZIP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("failed the reviewed ZIP checksum");
    expect(downloadClick).not.toHaveBeenCalled();
  });
  it("keeps pruning opt-in and distinct from removing a package", async () => {
    fetch.mockResolvedValue(json({ packages: [{ id: preview.id, title: "Saved", createdAt: 1, bytes: 100, issues: 2, available: true }], errors: [] }));
    const user = userEvent.setup(); render(<EvidencePackageDialog {...props} />);
    await user.click(screen.getByRole("button", { name: "Evidence package" }));
    await user.click(screen.getByRole("button", { name: "Saved packages / storage" }));
    await screen.findByText("Saved");
    expect(screen.getByRole("button", { name: "Prune unreferenced snapshots" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove package" }));
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    expect(fetch.mock.calls.some(([url]) => String(url).includes("prune-snapshots"))).toBe(false);
  });
});
