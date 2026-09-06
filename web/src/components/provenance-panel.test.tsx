import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProvenancePanel } from "./provenance-panel";
import type {
  ArtifactProvenance,
  ArtifactRef,
  EnvironmentSnapshot,
  Lineage,
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
    lineage: { nodes: [], edges: [], steps: {}, truncated: false },
    environments: {},
    ...over,
  };
}

function makeEnv(over: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return {
    schemaVersion: 1,
    id: "e".repeat(64),
    capturedAt: 1_700_000_000_000,
    os: { platform: "darwin", release: "25.6.0", arch: "arm64" },
    python: {
      version: "3.12.4",
      source: "venv",
      packages: [
        { name: "pandas", version: "2.2.2" },
        { name: "scanpy", version: "1.10.1" },
      ],
    },
    lockfiles: [{ path: "uv.lock", sha256: "f".repeat(64) }],
    ...over,
  };
}

/** figure_3.png <- de.py (write) + counts.csv (bash) <- user_data/raw.csv (upload). */
function makeLineage(): Lineage {
  const upload = makeStep({
    id: "u1",
    sessionId: "user-actions",
    role: "user",
    toolName: "upload",
    model: undefined,
    runId: undefined,
    outputs: [makeRef({ path: "user_data/raw.csv" })],
  });
  const script = makeStep({ id: "w1", toolName: "write", outputs: [makeRef({ path: "de.py" })] });
  const counts = makeStep({
    id: "b1",
    inputs: [makeRef({ path: "user_data/raw.csv", change: "read", confidence: "inferred" })],
    outputs: [makeRef({ path: "counts.csv" })],
  });
  const figure = makeStep({
    id: "b2",
    inputs: [
      makeRef({ path: "de.py", change: "read", confidence: "inferred" }),
      makeRef({ path: "counts.csv", change: "read", confidence: "inferred" }),
    ],
  });
  return {
    nodes: [
      { path: "figure_3.png", depth: 0, stepId: "b2", current: { size: 1, mtimeMs: 1 } },
      { path: "de.py", depth: 1, stepId: "w1", current: { size: 1, mtimeMs: 1 }, changedSinceUse: false },
      { path: "counts.csv", depth: 1, stepId: "b1", current: { size: 1, mtimeMs: 1 }, changedSinceUse: true },
      {
        path: "user_data/raw.csv",
        depth: 2,
        stepId: "u1",
        root: "upload",
        current: { size: 1, mtimeMs: 1 },
        changedSinceUse: false,
      },
    ],
    edges: [
      { from: "de.py", to: "figure_3.png", stepId: "b2", confidence: "inferred" },
      { from: "counts.csv", to: "figure_3.png", stepId: "b2", confidence: "inferred" },
      { from: "user_data/raw.csv", to: "counts.csv", stepId: "b1", confidence: "inferred" },
    ],
    steps: { u1: upload, w1: script, b1: counts, b2: figure },
    truncated: false,
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

  it("renders the upstream lineage back to the upload, flagging changed inputs", async () => {
    renderPanel(makeProvenance({ producedBy: [makeLineage().steps.b2], lineage: makeLineage() }));
    expect(await screen.findByText("Lineage")).toBeInTheDocument();
    const tree = within(screen.getByTestId("provenance-lineage"));
    expect(tree.getByText("de.py")).toBeInTheDocument();
    expect(tree.getByText("counts.csv")).toBeInTheDocument();
    expect(tree.getByText("user_data/raw.csv")).toBeInTheDocument();
    expect(tree.getByText("uploaded by you")).toBeInTheDocument();
    // counts.csv was rewritten after the figure consumed it.
    expect(tree.getAllByText(/changed since use/i)).toHaveLength(1);
    // An inferred input is labelled as such, not laundered into fact.
    expect(tree.getAllByText("inferred").length).toBeGreaterThan(0);
  });

  it("does not show a lineage section when the artifact has no upstream inputs", async () => {
    renderPanel(makeProvenance());
    expect(await screen.findByText("bash")).toBeInTheDocument();
    expect(screen.queryByText("Lineage")).not.toBeInTheDocument();
  });

  it("labels a user save and a remote compute step by actor", async () => {
    renderPanel(
      makeProvenance({
        producedBy: [
          makeStep({
            id: "m1",
            toolName: "modal_job",
            role: "compute",
            model: undefined,
            compute: {
              provider: "modal",
              jobId: "job_abcdef123",
              state: "succeeded",
              instance: "gpu-a100",
              gpu: "A100",
              exitCode: 0,
              missingOutputs: ["extra.csv"],
            },
            outputs: [makeRef({ change: "wrote" })],
          }),
          makeStep({
            id: "s1",
            sessionId: "user-actions",
            toolName: "save",
            role: "user",
            model: undefined,
            runId: undefined,
            outputs: [makeRef({ change: "modified" })],
          }),
        ],
      }),
    );
    expect(await screen.findByText("remote compute")).toBeInTheDocument();
    expect(screen.getByText(/gpu-a100 · A100 · exit 0 · job job_abcd/)).toBeInTheDocument();
    expect(screen.getByText(/never produced extra.csv/)).toBeInTheDocument();
    expect(screen.getByText("saved by you in the editor")).toBeInTheDocument();
  });

  it("shows the environment a step ran in and expands to the package list", async () => {
    const env = makeEnv();
    renderPanel(
      makeProvenance({
        producedBy: [makeStep({ environmentId: env.id })],
        environments: { [env.id]: env },
      }),
    );
    expect(await screen.findByText(/Python 3.12.4 · 2 packages · uv.lock ffffffff/)).toBeInTheDocument();
    await userEvent.click(screen.getByText(/Python 3.12.4/));
    expect(screen.getByText("scanpy==1.10.1")).toBeInTheDocument();
  });

  it("marks a harvest-time environment as captured later", async () => {
    const env = makeEnv();
    renderPanel(
      makeProvenance({
        producedBy: [
          makeStep({ role: "subagent", agentName: "analyst", environmentId: env.id, environmentAt: "harvest" }),
        ],
        environments: { [env.id]: env },
      }),
    );
    expect(await screen.findByText("(captured later)")).toBeInTheDocument();
  });
});
