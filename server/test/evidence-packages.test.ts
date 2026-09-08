import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import AdmZip from "adm-zip";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { appendNotebookEntry, type NotebookEntry } from "../src/agent/notebook-store.ts";
import { captureNotebookArtifacts } from "../src/agent/notebook-artifacts.ts";
import { appendStep } from "../src/provenance/store.ts";
import { ModalJobStore, modalJobFiles } from "../src/modal/store.ts";
import type { ModalJob } from "../src/modal/types.ts";
import { environmentId } from "../src/provenance/environment.ts";
import { prepareEvidencePackage, evidencePackageDownload, deleteEvidencePackage, pruneEvidenceSnapshots, listEvidencePackages } from "../src/evidence/packages.ts";
import { bytesHash, blobPath, packageDirectory, readPackage, evidenceStorage, ARTIFACT_BYTES } from "../src/evidence/storage.ts";
import { previewAnalysisPlan, freezeAnalysisPlan, recordPlanDeviation } from "../src/agent/notebook-plans.ts";
import { snapshotNotebookResults } from "../src/agent/notebook-results.ts";
import { lookPath } from "../src/binaries.ts";
const project = "review";
const root = { sessionId: "s", entryId: "h" };
const request = { title: "Reviewer package", roots: [root], includeArtifacts: true, includeCurrentUnverified: false, includeCommandArguments: false };
const entry = (id: string, extra: Partial<NotebookEntry> = {}): NotebookEntry => ({ id, title: id, type: "hypothesis", role: "agent", timestamp: 1000, ...extra });
function file(name: string, text = "data") { const abs = path.join(resolvePaths(project).sandbox, name); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); return abs; }
async function cite(id = "h", name = "result.txt", time = 1000) { appendNotebookEntry("s", entry(id, { timestamp: time, artifacts: [name], artifactSnapshots: await captureNotebookArtifacts(project, [name]) }), project); }
const zipFor = (id: string) => new AdmZip(path.join(packageDirectory(project, id), "evidence.zip"));
beforeEach(() => { fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); createProject({ name: "Review", projectId: project }); });
afterEach(() => { fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); });

describe("reviewer evidence packages", () => {
  it("bundles conflicting evidence and amendments, scoped ids, source-linked Methods and RO-Crate", async () => {
    file("result.txt"); await cite();
    appendNotebookEntry("s", entry("support", { type: "observation", title: "Supporting result", timestamp: 2000, evidence: [{ entryId: "h", relation: "supports" }], body: "Recorded effect in the discovery cohort." }), project);
    appendNotebookEntry("other", entry("challenge", { type: "observation", title: "Challenging result", timestamp: 3000, evidence: [{ entryId: "h", sessionId: "s", relation: "challenges" }], outcome: "inconclusive" }), project);
    appendNotebookEntry("s", entry("amend", { type: "observation", timestamp: 4000, supersedes: "support", body: "Corrected source." }), project);
    const p = await prepareEvidencePackage(project, { ...request, reproduction: { status: "verified" } });
    expect(p.manifest.records).toHaveLength(4);
    expect(p.manifest.relationships.map((e) => e.relation)).toEqual(expect.arrayContaining(["supports", "challenges", "supersedes"]));
    expect(p.manifest.reproduction.status).toBe("not-run");
    const zip = zipFor(p.id); const names = zip.getEntries().map((e) => e.entryName);
    for (const name of ["manifest.json", "README.md", "missing-information.md", "methods-source.md", "ro-crate-metadata.json", "checksums.sha256", "verify.py"]) expect(names).toContain(name);
    expect(zip.readAsText("methods-source.md")).toContain("Supporting result");
    expect(zip.readAsText("methods-source.md")).toContain("Challenging result");
    const crate = JSON.parse(zip.readAsText("ro-crate-metadata.json"));
    expect(crate["@graph"][0]).toMatchObject({ "@id": "ro-crate-metadata.json", "@type": "CreativeWork", about: { "@id": "./" } });
    expect(crate["@graph"][1]).toMatchObject({ "@id": "./", "@type": "Dataset", license: expect.stringContaining("No license") });
    for (const f of p.files) expect(bytesHash(zip.readFile(f.path)!)).toBe(f.sha256);
    expect(p.manifest.artifacts[0]).toMatchObject({ status: "included-matched", basis: "citation" });
  });
  it("recovers an earlier package snapshot after the original is overwritten and supports two versions of one path", async () => {
    const abs = file("result.txt", "version one"); await cite();
    const first = await prepareEvidencePackage(project, request);
    fs.writeFileSync(abs, "version two"); await cite("h2", "result.txt", 2000);
    const second = await prepareEvidencePackage(project, { ...request, roots: [root, { sessionId: "s", entryId: "h2" }] });
    const versions = second.manifest.artifacts.filter((a) => a.path === "result.txt");
    expect(new Set(versions.map((a) => a.sha256)).size).toBe(2);
    expect(versions.find((a) => a.sha256 === first.manifest.artifacts[0].sha256)?.origin).toBe("retained-snapshot");
    const zip = zipFor(second.id); expect(versions.map((a) => zip.readAsText(a.archivePath!)).sort()).toEqual(["version one", "version two"]);
  });
  it("never silently replaces unavailable historical bytes with today's file", async () => {
    const abs = file("result.txt", "old"); await cite(); fs.writeFileSync(abs, "new");
    const exact = await prepareEvidencePackage(project, request);
    expect(exact.manifest.artifacts[0].status).toBe("unavailable"); expect(exact.manifest.artifacts[0].archivePath).toBeUndefined();
    const comparison = await prepareEvidencePackage(project, { ...request, includeCurrentUnverified: true });
    const artifact = comparison.manifest.artifacts[0];
    expect(artifact.status).toBe("included-current-unverified"); expect(artifact.expectedSha256).not.toBe(artifact.sha256);
    expect(zipFor(comparison.id).readAsText(artifact.archivePath!)).toBe("new");
  });
  it("recovers a selected historical compute output from retained Modal staging without contacting Modal", async () => {
    file("result.txt", "original output"); await cite(); file("result.txt", "later replacement");
    const hash = bytesHash("original output"); const jobId = "mj_" + "a".repeat(32);
    const outputs = [{ path: "result.txt", size: Buffer.byteLength("original output"), sha256: hash }];
    const job: ModalJob = { version: 1, id: jobId, projectId: project, state: "succeeded", request: { command: "python analysis.py", instance: "cpu", gpuCount: 1, timeoutSec: 60 }, owner: { sessionId: "s", submittedBy: "api" }, createdAt: 1, updatedAt: 10, queuedAt: 1, finishedAt: 10, cancelRequested: false, reservationUsd: 0.01, sandboxName: "test", sandboxTags: {}, inputFiles: [], outputFiles: outputs, missingOutputs: [], stdoutBytes: 0, stderrBytes: 0, stdoutBaseCursor: 0, stderrBaseCursor: 0, eventSeq: 0, accounting: { reconciled: true, estimatedCostUsd: 0 } };
    new ModalJobStore().create(job);
    const staged = path.join(modalJobFiles(project, jobId).staging, "outputs", "result.txt"); fs.mkdirSync(path.dirname(staged), { recursive: true }); fs.writeFileSync(staged, "original output");
    appendStep({ schemaVersion: 1, id: `modal:${jobId}`, sessionId: "s", role: "compute", toolName: "modal", timestamp: 10, startedAt: 1, inputs: [], outputs: [{ path: "result.txt", sha256: hash, size: 15, mtimeMs: 10, change: "created", confidence: "observed" }], compute: { provider: "modal", jobId, state: "succeeded" } }, project);
    const p = await prepareEvidencePackage(project, request);
    expect(p.manifest.artifacts[0].origin).toBe("modal-output");
    expect(zipFor(p.id).readAsText(p.manifest.artifacts[0].archivePath!)).toBe("original output");
  });

  it("does not upgrade unknown or harvest-time hashes into original citation proof", async () => {
    file("legacy.txt");
    appendNotebookEntry("s", entry("h", { artifacts: ["legacy.txt"], artifactSnapshots: [{ path: "legacy.txt", capturedAt: 1000, timing: "harvest", sha256: bytesHash("data") }] }), project);
    expect((await prepareEvidencePackage(project, request)).manifest.artifacts[0].status).toBe("excluded");
    expect((await prepareEvidencePackage(project, { ...request, includeCurrentUnverified: true })).manifest.artifacts[0].status).toBe("included-current-unverified");
  });
  it("selects version-aware provenance inputs and stored environments without running probes or code", async () => {
    file("result.txt", "result"); file("data.csv", "data"); file("analysis.py", "raise RuntimeError('must never execute during packaging')"); file("uv.lock", "lock"); await cite();
    const body = { schemaVersion: 1 as const, os: { platform: "test", release: "test", arch: "test" }, python: { source: "venv" as const, version: "3.13", packages: [{ name: "numpy", version: "2.1.0" }] }, lockfiles: [{ path: "uv.lock", sha256: bytesHash("lock") }] };
    const env = { ...body, id: environmentId(body), capturedAt: 5 };
    file(`.kady/environments/${env.id}.json`, JSON.stringify(env));
    appendStep({ schemaVersion: 1, id: "compute", sessionId: "s", role: "agent", toolName: "bash", timestamp: 10, startedAt: 1, environmentId: env.id, args: { command: "python analysis.py --token SECRET_ARGUMENT" }, inputs: ["analysis.py", "data.csv"].map((p) => ({ path: p, sha256: bytesHash(fs.readFileSync(path.join(resolvePaths(project).sandbox, p))), size: 4, mtimeMs: 1, confidence: "inferred" as const, change: "read" as const })), outputs: [{ path: "result.txt", sha256: bytesHash("result"), size: 6, mtimeMs: 1, change: "created", confidence: "observed" }] }, project);
    const p = await prepareEvidencePackage(project, request); const zip = zipFor(p.id);
    expect(p.manifest.artifacts.map((a) => a.path)).toEqual(expect.arrayContaining(["analysis.py", "data.csv", "uv.lock"]));
    expect(zip.readAsText("metadata/provenance.json")).not.toContain("SECRET_ARGUMENT");
    expect(p.manifest.metadataFiles).toContain(`metadata/environments/${env.id}.json`);
    expect(p.manifest.issues.some((i) => i.code === "input-inferred")).toBe(true);
    expect(p.manifest.reproduction.status).toBe("not-run");
  });
  it("includes real plan revisions/deviations and matched scientific-result cards, not raw chat transcripts", async () => {
    file("data.csv"); appendNotebookEntry("s", entry("h"), project);
    const plan = { hypothesis: "Question", primaryOutcome: "Score", exclusions: "QC", model: "Linear", multiplicity: "One", qc: "Complete", stopping: "Fixed", exposureNotes: "Unknown", datasets: ["data.csv"], intent: "exploratory", priorExposure: "unknown" };
    const prep = await previewAnalysisPlan(project, root, { plan, expectedHead: null });
    const h = await freezeAnalysisPlan(project, root, { previewId: prep.id, acknowledgeLocalFreeze: true });
    recordPlanDeviation(project, root, { expectedHead: h.head, planId: h.events[0].id, field: "model", actual: "Robust regression", reason: "Heavy tails", timing: "after-results" });
    const card = { schemaVersion: 1, kind: "table", title: "Recorded measurements", columns: [{ key: "x", label: "x" }], rows: [[42]] };
    file(".pi/sessions/s.jsonl", JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "PRIVATE_CHAT_PROMPT" }] } }) + "\n" + JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "result", toolName: "scientific_result", details: { scientificResult: card } } }) + "\n");
    const results = [{ toolCallId: "result" }];
    appendNotebookEntry("s", entry("observation", { type: "observation", timestamp: 2000, evidence: [{ entryId: "h", relation: "supports" }], results, resultSnapshots: await snapshotNotebookResults(project, "s", results) }), project);
    const p = await prepareEvidencePackage(project, request); const zip = zipFor(p.id);
    expect(p.manifest.metadataFiles.some((f) => f.startsWith("metadata/plans/"))).toBe(true);
    const result = JSON.parse(zip.readAsText("metadata/results/result-1.json")); expect(result.status).toBe("matched-recorded-card"); expect(result.card.rows).toEqual([[42]]);
    expect(zip.getEntries().some((e) => zip.readAsText(e).includes("PRIVATE_CHAT_PROMPT"))).toBe(false);
  });
  it("requires review acknowledgements and detects a corrupted retained ZIP instead of regenerating it", async () => {
    file("result.txt"); await cite(); const p = await prepareEvidencePackage(project, request);
    await expect(evidencePackageDownload(project, p.id, { digest: p.digest })).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    await expect(evidencePackageDownload(project, p.id, { digest: "wrong", acknowledgeSensitive: true, acknowledgeLimitations: true })).rejects.toMatchObject({ code: "PACKAGE_CHANGED" });
    fs.writeFileSync(path.join(packageDirectory(project, p.id), "evidence.zip"), "corrupt");
    await expect(evidencePackageDownload(project, p.id, { digest: p.digest, acknowledgeSensitive: true, acknowledgeLimitations: true })).rejects.toMatchObject({ code: "PACKAGE_CORRUPT" });
  });
  it("deletes only package copies, keeps snapshots until explicit safe pruning, and preserves originals", async () => {
    const original = file("result.txt"); await cite(); const p = await prepareEvidencePackage(project, request); const sha = p.manifest.artifacts[0].sha256!;
    expect((await pruneEvidenceSnapshots(project, true)).removed).toBe(0);
    await deleteEvidencePackage(project, p.id); expect(fs.existsSync(original)).toBe(true); expect(fs.existsSync(blobPath(project, sha))).toBe(true);
    await expect(pruneEvidenceSnapshots(project, false)).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    expect((await pruneEvidenceSnapshots(project, true)).removed).toBe(1);
    expect(fs.existsSync(original)).toBe(true); expect(evidenceStorage(project).snapshotsBytes).toBe(0);
  });
  it("supports metadata-only packages and reports oversized/missing artifacts explicitly", async () => {
    const abs = file("huge.bin"); fs.truncateSync(abs, ARTIFACT_BYTES + 1);
    appendNotebookEntry("s", entry("h", { artifacts: ["huge.bin", "missing.csv"] }), project);
    const metadata = await prepareEvidencePackage(project, { ...request, includeArtifacts: false });
    expect(metadata.manifest.artifacts.every((a) => a.status === "excluded")).toBe(true);
    const p = await prepareEvidencePackage(project, { ...request, includeCurrentUnverified: true });
    expect(p.manifest.artifacts.every((a) => !a.archivePath)).toBe(true); expect(p.manifest.issues.length).toBeGreaterThan(3);
  });
  it.skipIf(process.platform === "win32")("rejects traversal, credential files and symlink escapes without ZIP-slip names", async () => {
    const outside = path.join(PROJECTS_ROOT, "outside.txt"); fs.writeFileSync(outside, "secret"); file("auth.json", "secret"); file(".env", "secret");
    fs.symlinkSync(outside, path.join(resolvePaths(project).sandbox, "linked.txt"));
    appendNotebookEntry("s", entry("h", { artifacts: ["../outside.txt", "auth.json", ".env", "linked.txt"] }), project);
    const p = await prepareEvidencePackage(project, { ...request, includeCurrentUnverified: true });
    expect(p.manifest.artifacts.every((a) => !a.archivePath)).toBe(true);
    expect(zipFor(p.id).getEntries().every((e) => !e.entryName.includes("..") && !e.entryName.includes("\\"))).toBe(true);
  });
  it("does not accept packages copied into a different project and keeps corrupt packages removable", async () => {
    file("result.txt"); await cite(); const p = await prepareEvidencePackage(project, request);
    createProject({ name: "Other", projectId: "other" }); fs.cpSync(packageDirectory(project, p.id), packageDirectory("other", p.id), { recursive: true });
    expect(() => readPackage("other", p.id)).toThrow(/inconsistent/);
    fs.writeFileSync(path.join(packageDirectory(project, p.id), "preview.json"), "broken");
    expect(listEvidencePackages(project).packages[0].available).toBe(false);
    await expect(pruneEvidenceSnapshots(project, true)).rejects.toThrow();
    await deleteEvidencePackage(project, p.id); expect(listEvidencePackages(project).packages).toEqual([]);
  });
  it.skipIf(!lookPath("python3"))("ships a working isolated integrity checker without executing captured scripts", async () => {
    file("analysis.py", "raise RuntimeError('MUST NOT RUN')"); await cite("h", "analysis.py");
    const p = await prepareEvidencePackage(project, request); const extracted = path.join(PROJECTS_ROOT, "extracted"); zipFor(p.id).extractAllTo(extracted, true);
    const output = execFileSync(lookPath("python3")!, ["-I", path.join(extracted, "verify.py")], { encoding: "utf8" });
    expect(output).toContain("Integrity only");
    fs.writeFileSync(path.join(extracted, p.manifest.artifacts[0].archivePath!), "tampered");
    expect(() => execFileSync(lookPath("python3")!, ["-I", path.join(extracted, "verify.py")], { stdio: "pipe" })).toThrow();
  });
});
