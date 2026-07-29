import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProvenancePanel } from "./provenance-panel";
import type {
  ArtifactProvenance,
  ArtifactRef,
  ProvenanceStep,
} from "@/lib/provenance";

const getArtifactProvenance = vi.hoisted(() => vi.fn());
vi.mock("@/lib/provenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provenance")>()),
  getArtifactProvenance,
}));

function makeRef(over: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    path: "figure_3.png",
    sha256: "a".repeat(64),
    size: 2048,
    mtimeMs: 1_700_000_000_000,
    change: "created",
    confidence: "observed",
    ...over,
  };
}

function makeStep(over: Partial<ProvenanceStep> = {}): ProvenanceStep {
  return {
    schemaVersion: 1,
    id: "tc_1",
    sessionId: "sess-abcdef12",
    runId: "run_9f8e7d6c-1111",
    timestamp: 1_700_000_000_000,
    toolName: "bash",
    role: "agent",
    model: "openrouter/anthropic/claude-opus-4",
    inputs: [],
    outputs: [makeRef()],
    ...over,
  };
}

function makeProvenance(over: Partial<ArtifactProvenance> = {}): ArtifactProvenance {
  return {
    path: "figure_3.png",
    exists: true,
    current: { sha256: "a".repeat(64), size: 2048, mtimeMs: 1_700_000_000_000 },
    producedBy: [makeStep()],
    readBy: [],
    readByTotal: 0,
    citedBy: [],
    staleness: "current",
    ...over,
  };
}

function renderPanel(data: ArtifactProvenance, props: Record<string, unknown> = {}) {
  getArtifactProvenance.mockResolvedValue(data);
  return render(
    <ProvenancePanel path={data.path} projectId="proj" {...props} />,
  );
}

beforeEach(() => {
  getArtifactProvenance.mockReset();
});

describe("ProvenancePanel", () => {
  it("shows the producing step with its tool, model and run", async () => {
    renderPanel(makeProvenance());
    expect(await screen.findByText("bash")).toBeInTheDocument();
    expect(screen.getByText("openrouter/anthropic/claude-opus-4")).toBeInTheDocument();
    expect(screen.getByText("lead agent")).toBeInTheDocument();
    expect(screen.getByText(/run 9f8e7d6c/)).toBeInTheDocument();
  });

  it("reports a current artifact as matching its producing step", async () => {
    renderPanel(makeProvenance({ staleness: "current" }));
    expect(await screen.findByText(/bytes on disk match/i)).toBeInTheDocument();
  });

  it("warns loudly when the artifact is stale", async () => {
    renderPanel(makeProvenance({ staleness: "stale" }));
    expect(
      await screen.findByText(/changed after the step that produced it/i),
    ).toBeInTheDocument();
  });

  it("does not claim verification when staleness is unknown", async () => {
    renderPanel(makeProvenance({ staleness: "unknown" }));
    expect(await screen.findByText(/sameness could not be checked/i)).toBeInTheDocument();
  });

  it("labels an inferred edge distinctly from an observed one", async () => {
    renderPanel(
      makeProvenance({
        producedBy: [makeStep({ outputs: [makeRef({ confidence: "inferred" })] })],
      }),
    );
    expect(await screen.findByText("inferred")).toBeInTheDocument();
    expect(screen.queryByText("observed")).not.toBeInTheDocument();
  });

  it("names the subagent that produced the artifact", async () => {
    renderPanel(
      makeProvenance({
        producedBy: [
          makeStep({
            toolName: "write",
            role: "subagent",
            agentName: "pipeline-engineer",
            outputs: [makeRef({ change: "wrote", identityAt: "harvest" })],
          }),
        ],
      }),
    );
    expect(await screen.findByText("subagent: pipeline-engineer")).toBeInTheDocument();
  });

  it("marks a harvested step's own hash as taken later", async () => {
    renderPanel(
      makeProvenance({
        producedBy: [
          makeStep({
            role: "subagent",
            agentName: "pipeline-engineer",
            outputs: [makeRef({ change: "wrote", identityAt: "harvest" })],
          }),
        ],
        staleness: "unknown",
      }),
    );
    // Without this the card reads as though the hash were captured at write time.
    expect(await screen.findByText("hashed later")).toBeInTheDocument();
  });

  it("does not mark a lead-agent step as hashed later", async () => {
    renderPanel(makeProvenance());
    expect(await screen.findByText("bash")).toBeInTheDocument();
    expect(screen.queryByText("hashed later")).not.toBeInTheDocument();
  });

  it("explains a harvest-time match instead of claiming it is current", async () => {
    renderPanel(
      makeProvenance({
        producedBy: [
          makeStep({
            role: "subagent",
            agentName: "pipeline-engineer",
            outputs: [makeRef({ change: "wrote", identityAt: "harvest" })],
          }),
        ],
        staleness: "unknown",
      }),
    );
    expect(
      await screen.findByText(/never hashed at the time, so a match cannot confirm/i),
    ).toBeInTheDocument();
  });

  it("explains a subagent step whose file effects could not be observed", async () => {
    renderPanel(
      makeProvenance({
        producedBy: [
          makeStep({
            role: "subagent",
            agentName: "pipeline-engineer",
            degraded: "no-scan-baseline",
            outputs: [makeRef({ change: "wrote", confidence: "inferred", identityAt: "harvest" })],
          }),
        ],
      }),
    );
    expect(
      await screen.findByText(/attributed by timing, not observation/i),
    ).toBeInTheDocument();
    expect(screen.getByText("inferred")).toBeInTheDocument();
  });

  it("surfaces a degraded scan instead of implying complete attribution", async () => {
    renderPanel(
      makeProvenance({
        producedBy: [makeStep({ degraded: "sandbox-too-large" })],
      }),
    );
    expect(
      await screen.findByText(/exceeded the scan budget/i),
    ).toBeInTheDocument();
  });

  it("reports an unhashed artifact rather than showing a bare size", async () => {
    renderPanel(
      makeProvenance({
        producedBy: [
          makeStep({
            inputs: [
              makeRef({
                path: "counts.h5ad",
                sha256: undefined,
                hashSkipped: "too-large",
                change: "read",
              }),
            ],
          }),
        ],
      }),
    );
    expect(await screen.findByText("unhashed")).toBeInTheDocument();
  });

  it("explains itself when nothing produced the file", async () => {
    renderPanel(makeProvenance({ producedBy: [], staleness: "unknown" }));
    expect(await screen.findByText(/No recorded provenance/i)).toBeInTheDocument();
  });

  it("flags a notebook citation that predates the latest version", async () => {
    renderPanel(
      makeProvenance({
        citedBy: [
          {
            id: "nb_1",
            sessionId: "sess-abcdef12",
            type: "observation",
            title: "Six clusters visible",
            timestamp: 1_699_000_000_000,
            role: "agent",
            precedesLatestOutput: true,
          },
        ],
      }),
    );
    expect(await screen.findByText("Six clusters visible")).toBeInTheDocument();
    expect(screen.getByText(/may\s+describe different bytes/i)).toBeInTheDocument();
  });

  it("opens a cited notebook entry", async () => {
    const onOpenNotebookEntry = vi.fn();
    renderPanel(
      makeProvenance({
        citedBy: [
          {
            id: "nb_1",
            sessionId: "sess-abcdef12",
            type: "decision",
            title: "Use DESeq2",
            timestamp: 1_700_000_001_000,
            role: "agent",
            precedesLatestOutput: false,
          },
        ],
      }),
      { onOpenNotebookEntry },
    );
    await userEvent.click(await screen.findByText("Use DESeq2"));
    expect(onOpenNotebookEntry).toHaveBeenCalledWith("nb_1");
  });

  it("opens an input artifact as a file tab", async () => {
    const onOpenFile = vi.fn();
    renderPanel(
      makeProvenance({
        producedBy: [
          makeStep({
            inputs: [makeRef({ path: "counts.csv", change: "read" })],
          }),
        ],
      }),
      { onOpenFile },
    );
    await userEvent.click(await screen.findByText("counts.csv"));
    expect(onOpenFile).toHaveBeenCalledWith("counts.csv");
  });

  it("reports a missing file rather than rendering an empty identity", async () => {
    renderPanel(
      makeProvenance({ exists: false, current: null, staleness: "unknown" }),
    );
    expect(await screen.findByText(/no longer exists in the sandbox/i)).toBeInTheDocument();
  });

  it("shows a retryable error when the lookup fails", async () => {
    getArtifactProvenance.mockRejectedValue(new Error("provenance 500"));
    render(<ProvenancePanel path="figure_3.png" projectId="proj" />);
    expect(await screen.findByText("provenance 500")).toBeInTheDocument();

    getArtifactProvenance.mockResolvedValue(makeProvenance());
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText("bash")).toBeInTheDocument());
  });

  it("caps the read list and says how many more there are", async () => {
    renderPanel(
      makeProvenance({
        readBy: [makeStep({ id: "r1", toolName: "read", outputs: [] })],
        readByTotal: 7,
      }),
    );
    expect(await screen.findByText("read")).toBeInTheDocument();
    expect(screen.getByText("+ 6 more")).toBeInTheDocument();
  });
});
