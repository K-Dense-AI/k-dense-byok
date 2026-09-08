/** Reviewer packages freeze evidence; they never execute or declare reproduction. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePaths } from "../projects.ts";
import { jsonDigest } from "../canonical-json.ts";
import { managedPath, approvedInputRoot, assertApprovedJob } from "../modal/approved.ts";
import { modalJobManager } from "../modal/manager.ts";
import { modalJobFiles } from "../modal/store.ts";
import { isTerminalModalState } from "../modal/types.ts";
import { notebookRobustness } from "../agent/notebook-robustness.ts";
import { normalizeRobustnessDraft } from "../../../web/src/lib/notebook-robustness.ts";
import { planDirectory, validateAnalysisPlanRecords } from "../agent/notebook-plans.ts";
import { lookupSessionResults, type Lookup } from "../agent/notebook-results.ts";
import { normalizeResultLinks } from "../../../web/src/lib/notebook-result-links.ts";
import { packageRecordGraph, type PackageRecord } from "./source-graph.ts";
import { packageProvenance, storedEnvironment, MAX_PACKAGE_STEPS, stepKey } from "./provenance.ts";
import { EvidenceBuilder } from "./builder.ts";
import { methodsScaffold, packageReadme, missingInformation, roCrate, VERIFY_SOURCE } from "./report.ts";
import { ARTIFACT_BYTES, PACKAGE_BYTES, PACKAGE_COUNT, PACKAGE_QUOTA, ZIP_BYTES, SHA256, EvidencePackageError, artifactPath, blobPath, captureBlob, evidenceExclusive, evidenceStorage, hashEvidenceFile, packageDirectory, packageIds, publishExclusiveJson, readEvidenceBytes, readPackage, verifiedEvidenceStream, type CapturedBlob, type ReadBudget } from "./storage.ts";
import { normalizeEvidencePackageRequest, type EvidenceArtifact, type EvidenceIdentityBasis, type EvidenceIssue, type EvidencePackageManifest, type EvidencePackagePreview } from "../../../web/src/lib/evidence-packages.ts";
import type { ProvenanceStep } from "../provenance/store.ts";

interface AssetRequest { row: EvidenceArtifact; at: number; depth: number; lockfile: boolean }
interface RetainedSource { absolute: string; origin: "modal-output" | "robustness-input" }
export async function prepareEvidencePackage(projectId: string, raw: unknown): Promise<EvidencePackagePreview> {
  let options;
  try { options = normalizeEvidencePackageRequest(raw); } catch (e) { throw new EvidencePackageError("INVALID_REQUEST", (e as Error).message); }
  return evidenceExclusive(projectId, async () => {
    const storage = evidenceStorage(projectId);
    if (storage.packageCount >= PACKAGE_COUNT || storage.packagesBytes >= PACKAGE_QUOTA) throw new EvidencePackageError("PACKAGE_QUOTA", "Package storage limit reached; remove an old package before preparing another", 413);
    const id = `ep_${crypto.randomUUID().replaceAll("-", "")}`; const createdAt = Date.now();
    const dir = packageDirectory(projectId, id); await fs.promises.mkdir(dir, { recursive: true });
    const builder = new EvidenceBuilder(path.join(dir, "payload"));
    const newlyCreated = new Set<string>(); const usedBlobs = new Set<string>();
    try {
      const issues: EvidenceIssue[] = [
        { code: "not-reproduced", message: "No analysis was rerun. Hash integrity and recorded provenance do not establish reproducibility or scientific validity." },
        { code: "rights-unverified", message: "No publication/data/code license or privacy clearance is inferred; review permissions and sensitive content before sharing." },
        { code: "external-citations-unverified", message: "Literature citations and scientific assertions were not independently verified." },
      ];
      const issue = (code: string, message: string, subject?: string) => { if (issues.length < 500) issues.push({ code, message, ...(subject ? { subject } : {}) }); };
      const graph = await packageRecordGraph(projectId, options.roots, issues);
      const records = graph.records;
      for (const r of records) {
        await builder.write(r.ref.archivePath, r.document.original!.json + "\n");
        for (const q of r.document.qualifiers) issue("source-qualified", q, r.ref.key);
        if (r.ref.status !== "active") issue("record-qualified", `Record status is ${r.ref.status}; inspect amendments before interpreting it`, r.ref.key);
      }
      await builder.json("metadata/evidence.json", { roots: options.roots, records: records.map((r) => r.ref), relationships: graph.relationships, coverage: graph.coverage, interpretation: "Relationships are authored interpretations. Contradictions, amendments and unresolved links are preserved; no truth score is computed." });
      const assets: AssetRequest[] = []; const assetsByKey = new Map<string, AssetRequest>();
      const metadataFiles: string[] = ["metadata/evidence.json"];
      const retained = new Map<string, RetainedSource[]>();
      const retainedKey = (p: string, sha: string) => jsonDigest([p, sha]);
      const addRetained = (p: string, sha: string, source: RetainedSource) => {
        if (!SHA256.test(sha)) return;
        const key = retainedKey(p, sha); const list = retained.get(key) ?? []; if (list.length < 8) list.push(source); retained.set(key, list);
      };
      const addAsset = (rawPath: string, expected: string | undefined, basis: EvidenceIdentityBasis, at: number, reference: string, depth = 0, lockfile = false): AssetRequest | undefined => {
        if (assets.length >= 128) { issue("artifact-graph-limit", "Artifact/input traversal stopped at 128 versioned references; additional files are not verified absent"); return; }
        let canonical: string;
        try { canonical = artifactPath(projectId, rawPath, lockfile).path; }
        catch (e) {
          const row: EvidenceArtifact = { id: `artifact-${jsonDigest([rawPath, reference]).slice(0, 24)}`, path: typeof rawPath === "string" ? rawPath.slice(0, 2000) : "invalid path", basis, status: "excluded", references: [reference], reason: (e as Error).message };
          assets.push({ row, at, depth, lockfile }); issue("unsafe-artifact", row.reason!, row.path); return;
        }
        const sha = expected && SHA256.test(expected) ? expected : undefined;
        const key = jsonDigest([canonical, sha ?? null, basis, at]);
        const old = assetsByKey.get(key); if (old) { if (!old.row.references.includes(reference)) old.row.references.push(reference); return old; }
        const row: EvidenceArtifact = { id: `artifact-${key.slice(0, 24)}`, path: canonical, ...(sha ? { expectedSha256: sha } : {}), basis, status: "unavailable", references: [reference] };
        const item = { row, at, depth, lockfile }; assets.push(item); assetsByKey.set(key, item); return item;
      };
      for (const r of records) {
        for (const p of r.document.entry.artifacts ?? []) {
          let canonical: string; try { canonical = artifactPath(projectId, p).path; } catch { addAsset(p, undefined, "unknown", r.ref.timestamp, r.ref.key); continue; }
          const snapshot = r.document.entry.artifactSnapshots?.find((s) => { try { return artifactPath(projectId, s.path).path === canonical; } catch { return false; } });
          addAsset(p, snapshot?.sha256, snapshot?.timing === "harvest" ? "retrospective" : snapshot?.timing === "output" ? "output" : snapshot?.sha256 ? "citation" : "unknown", r.ref.timestamp, r.ref.key);
        }
      }
      const metadataBudget: ReadBudget = { remaining: 16 * 1024 * 1024 };
      // Selected user comments/pins can qualify an agent's claims. Do not
      // silently export unrelated standalone notes from the whole project.
      const annotations: { sessionId: string; annotations: unknown[] }[] = [];
      for (const sid of new Set(records.map((r) => r.ref.source.sessionId))) {
        const selectedIds = new Set(records.filter((r) => r.ref.source.sessionId === sid).map((r) => r.ref.source.entryId));
        const file = managedPath(projectId, `.kady/notebook/${sid}.annotations.json`);
        if (!fs.existsSync(file)) continue;
        try {
          const data = JSON.parse((await readEvidenceBytes(projectId, file, 1024 * 1024, metadataBudget)).toString("utf8"));
          if (data.version !== 1 || !Array.isArray(data.annotations)) throw new Error("Unsupported annotation sidecar");
          annotations.push({ sessionId: sid, annotations: data.annotations.filter((a: { kind?: string; entryId?: string }) => a && (a.kind === "pin" || a.kind === "comment") && selectedIds.has(a.entryId ?? "")) });
        } catch (e) { issue("annotations-unavailable", (e as Error).message, sid); }
      }
      await builder.json("metadata/annotations.json", { scope: "Only pins/comments attached to selected notebook records; user-editable annotations, not verified findings", sessions: annotations }); metadataFiles.push("metadata/annotations.json");
      // Snapshot actual plan journals, not tool-authored 'approved' fields.
      for (const r of records.filter((r) => r.ref.type === "hypothesis")) {
        try {
          const folder = planDirectory(projectId, r.ref.source);
          if (!fs.existsSync(folder)) continue;
          const names = (await fs.promises.readdir(folder)).filter((f) => /^\d{6}\.json$/.test(f)).sort();
          if (names.length > 256) throw new Error("Plan event limit exceeded");
          const rows = [];
          for (const name of names) rows.push({ name, value: JSON.parse((await readEvidenceBytes(projectId, path.join(folder, name), 128 * 1024, metadataBudget)).toString("utf8")) });
          const history = validateAnalysisPlanRecords(r.ref.source, rows);
          const after = (await fs.promises.readdir(folder)).filter((f) => /^\d{6}\.json$/.test(f)).sort();
          if (JSON.stringify(names) !== JSON.stringify(after)) issue("plan-changed-during-capture", "Plan history changed while this package was assembled; only the captured revisions are included", r.ref.key);
          if (!history.events.length) continue;
          const name = `metadata/plans/${r.ref.key}.json`; await builder.json(name, history); metadataFiles.push(name);
          for (const event of history.events) if (event.kind === "freeze") for (const file of event.datasets) addAsset(file.path, file.sha256, file.sha256 ? "plan" : "unknown", event.recordedAt, `${name}#${event.id}`);
        } catch (e) { issue("plan-history-unavailable", (e as Error).message, r.ref.key); }
      }
      // Canonical scientific cards, resolved once per source session. No raw
      // chat transcript, user messages or auth-store files enter the package.
      const resultRefs: { record: PackageRecord; ref: ReturnType<typeof normalizeResultLinks>[number] }[] = [];
      for (const r of records) for (const ref of normalizeResultLinks(r.document.original?.entry.results, true)) {
        if (resultRefs.length < 32) resultRefs.push({ record: r, ref }); else issue("result-reference-limit", "More than 32 scientific-result references were requested; additional cards were not inspected");
      }
      const lookups = new Map<string, Map<string, Lookup>>(); const resultBudget = { bytes: 64 * 1024 * 1024 };
      for (const sid of new Set(resultRefs.filter((r) => !r.ref.childLocal).map((r) => r.ref.sessionId ?? r.record.ref.source.sessionId))) lookups.set(sid, await lookupSessionResults(projectId, sid, [...new Set(resultRefs.filter((r) => !r.ref.childLocal && (r.ref.sessionId ?? r.record.ref.source.sessionId) === sid).map((r) => r.ref.toolCallId))], resultBudget));
      for (const [index, { record, ref }] of resultRefs.entries()) {
        const sid = ref.sessionId ?? record.ref.source.sessionId;
        const lookup = ref.childLocal ? { status: "unverified", reason: "Child-local result is not indexed as parent evidence" } as Lookup : lookups.get(sid)!.get(ref.toolCallId)!;
        const snapshots = record.document.original?.entry.resultSnapshots;
        const pin = Array.isArray(snapshots) ? snapshots.find((s) => s && s.sessionId === sid && s.toolCallId === ref.toolCallId && s.sha256 && SHA256.test(s.sha256)) : undefined;
        const changed = !!pin?.sha256 && !!lookup.sha256 && pin.sha256 !== lookup.sha256;
        const verified = !changed && lookup.status === "available" && !!pin?.sha256;
        const card = !changed && (verified || options.includeCurrentUnverified) ? lookup.card : undefined;
        const status = changed ? "changed" : verified ? "matched-recorded-card" : lookup.status === "available" ? "unverified" : lookup.status;
        const name = `metadata/results/result-${index + 1}.json`;
        await builder.json(name, { notebookSource: record.ref.source, reference: { ...ref, sessionId: sid }, expectedSha256: pin?.sha256, observedSha256: lookup.sha256, status, reason: lookup.reason, ...(card ? { card } : { cardOmitted: true }) }); metadataFiles.push(name);
        if (!verified) issue("scientific-result-unverified", `${status}: a replacement/unverified card is not treated as original evidence`, name);
        if (card) {
          const paths = new Set((card.artifacts ?? []).map((a) => a.path));
          if (card.kind === "plot") for (const image of card.images) paths.add(image.path);
          if (card.kind === "artifact-list") for (const item of card.items) paths.add(item.path);
          if (card.kind === "qc-report") for (const check of card.checks) if (check.artifact) paths.add(check.artifact);
          if ((card.kind === "dataset-schema" || card.kind === "molecule") && card.path) paths.add(card.path);
          for (const p of paths) addAsset(p, undefined, "unknown", record.ref.timestamp, name);
        }
      }
      // Preserve relevant reviewed robustness definitions and every attempt.
      const hypothesisKeys = new Set(records.filter((r) => r.ref.type === "hypothesis").map((r) => JSON.stringify(r.ref.source)));
      const robustRoot = managedPath(projectId, ".kady/notebook/robustness"); let workflowCount = 0;
      if (fs.existsSync(robustRoot)) for (const rw of (await fs.promises.readdir(robustRoot)).filter((s) => /^rw_[a-f0-9]{32}$/.test(s)).slice(0, 100)) {
        try {
          const folder = path.join(robustRoot, rw);
          const p = JSON.parse((await readEvidenceBytes(projectId, path.join(folder, "preview.json"), 512 * 1024, metadataBudget)).toString("utf8"));
          const { digest, ...content } = p;
          if (p.projectId !== projectId || p.id !== rw || jsonDigest(content) !== digest) throw new Error("Workflow definition identity mismatch");
          normalizeRobustnessDraft(p.draft);
          if (!hypothesisKeys.has(JSON.stringify(p.source))) continue;
          if (!fs.existsSync(path.join(folder, "approval.json"))) continue;
          if (++workflowCount > 16) { issue("workflow-limit", "Only 16 related robustness workflows were captured"); break; }
          const workflow = notebookRobustness.get(projectId, p.source, rw);
          const name = `metadata/workflows/${rw}.json`; await builder.json(name, workflow); metadataFiles.push(name);
          if (workflow.attempts.some((a) => !a.reconciled || ["running", "preparing", "queued", "collecting", "awaiting-admission"].includes(a.state))) issue("compute-in-progress", "Workflow was not fully settled at capture; later results are not included", name);
          for (const f of p.inputFiles) {
            const request = addAsset(f.path, f.sha256, "consumed-input", workflow.approvedAt ?? p.createdAt, name);
            if (request) addRetained(request.row.path, f.sha256, { absolute: path.join(approvedInputRoot(projectId, rw), f.path), origin: "robustness-input" });
          }
          for (const attempt of workflow.attempts) {
            const job = modalJobManager.store.read(projectId, attempt.jobId); if (!job || job.approval?.batchId !== rw) continue;
            try { assertApprovedJob(job, true); } catch { issue("compute-record-unverified", "Job definition does not match its admission record", attempt.jobId); continue; }
            for (const f of job.outputFiles) {
              const request = addAsset(f.path, f.sha256, "output", job.finishedAt ?? job.updatedAt, name);
              if (request && f.sha256) addRetained(request.row.path, f.sha256, { absolute: path.join(modalJobFiles(projectId, job.id).staging, "outputs", f.path), origin: "modal-output" });
            }
          }
        } catch (e) { issue("workflow-unavailable", (e as Error).message, rw); if (metadataBudget.remaining <= 0) break; }
      }
      const steps = await packageProvenance(projectId, [...new Set(records.map((r) => r.ref.source.sessionId))], issues);
      const selectedSteps = new Map<string, ProvenanceStep>(); const lineage: { artifact: string; step: string; confidence: string; selection: string }[] = [];
      const safeRefPath = (p: string) => { try { return artifactPath(projectId, p).path; } catch { return null; } };
      const producers = new Map<string, ProvenanceStep[]>();
      for (const step of steps) for (const out of step.outputs) {
        if (out.change === "deleted" || out.change === "read") continue;
        const p = safeRefPath(out.path); if (!p) continue; const list = producers.get(p) ?? []; list.push(step); producers.set(p, list);
      }
      for (let index = 0; index < assets.length && index < 128; index++) {
        const a = assets[index]; if (a.row.status === "excluded" || a.lockfile) continue;
        const candidates = (producers.get(a.row.path) ?? []).filter((s) => s.timestamp <= a.at);
        const producer = [...candidates].reverse().find((s) => !a.row.expectedSha256 || s.outputs.some((o) => safeRefPath(o.path) === a.row.path && o.sha256 === a.row.expectedSha256));
        if (!producer) { issue("origin-unrecorded", "No matching producer was found within the recorded time/version window and scan bounds", a.row.id); continue; }
        const output = producer.outputs.find((f) => safeRefPath(f.path) === a.row.path && (!a.row.expectedSha256 || f.sha256 === a.row.expectedSha256))!;
        lineage.push({ artifact: a.row.id, step: stepKey(producer), confidence: output.confidence, selection: a.row.expectedSha256 ? "matching recorded output at-or-before use" : "time-based candidate; citation version unknown" });
        if (!a.row.expectedSha256) issue("producer-inferred", "Producer selected by time only; no citation-time identity was supplied", a.row.id);
        if (selectedSteps.size >= MAX_PACKAGE_STEPS && !selectedSteps.has(stepKey(producer))) { issue("lineage-step-limit", "Provenance selection stopped at 200 steps"); continue; }
        selectedSteps.set(stepKey(producer), producer);
        if (producer.degraded || producer.truncatedEdges) issue("provenance-degraded", `Observed step reports ${producer.degraded ?? "truncated edges"}; omitted edges ${producer.truncatedEdges ?? 0}`, stepKey(producer));
        if (output.identityAt === "harvest" || output.confidence !== "observed") issue("provenance-qualified", `Output attribution ${output.confidence}; identity measured ${output.identityAt ?? "at write"}`, stepKey(producer));
        if (producer.compute?.jobId) {
          const job = modalJobManager.store.read(projectId, producer.compute.jobId);
          if (job && isTerminalModalState(job.state)) for (const f of job.outputFiles) if (f.sha256 && safeRefPath(f.path) === a.row.path && f.sha256 === a.row.expectedSha256) addRetained(a.row.path, f.sha256, { absolute: path.join(modalJobFiles(projectId, job.id).staging, "outputs", f.path), origin: "modal-output" });
        }
        if (a.depth >= 8) { if (producer.inputs.length) issue("lineage-depth-limit", "Upstream input walk stopped at eight hops", a.row.id); continue; }
        for (const input of producer.inputs) {
          if (safeRefPath(input.path) === a.row.path && input.sha256 === a.row.expectedSha256) continue;
          const child = addAsset(input.path, input.sha256, input.identityAt === "harvest" ? "retrospective" : "consumed-input", producer.startedAt ?? producer.timestamp, `step:${stepKey(producer)}`, a.depth + 1);
          if (child && input.confidence !== "observed") issue("input-inferred", `Input edge is ${input.confidence}, not directly observed`, child.row.id);
        }
      }
      const environmentIds = [...new Set([...selectedSteps.values()].flatMap((s) => s.environmentId ? [s.environmentId] : []))];
      for (const id of environmentIds.slice(0, 32)) {
        try {
          const env = await storedEnvironment(projectId, id, metadataBudget);
          const name = `metadata/environments/${id}.json`; await builder.json(name, env); metadataFiles.push(name);
          for (const lock of env.lockfiles) addAsset(lock.path, lock.sha256, "consumed-input", env.capturedAt, name, 0, true);
          if (env.python?.packagesTruncated || env.r?.packagesTruncated) issue("environment-incomplete", "Recorded package inventory was truncated", name);
        } catch (e) { issue("environment-unavailable", (e as Error).message, id); }
      }
      if (environmentIds.length > 32) issue("environment-limit", "Additional environment snapshots were not included after 32");
      for (const step of selectedSteps.values()) {
        if (!step.environmentId) issue("environment-not-recorded", step.compute ? "Remote image recipe may be present, but an exact remote package/image inventory is not recorded" : "Execution environment snapshot is unavailable", stepKey(step));
        if (step.environmentAt === "harvest") issue("environment-retrospective", "Environment was captured later, not at execution", stepKey(step));
      }
      issue("seeds-hardware-unverified", "Ordinary provenance does not capture all random seeds/hardware; robustness seeds/resources are declared requests, not proof that every library honored them.");
      issue("opaque-execution", "File effects and inferred command-line inputs are not a complete trace of what a command did internally.");
      if (!options.includeCommandArguments) issue("arguments-excluded", "Raw provenance arguments were omitted by the privacy option; recorded notebook snippets are still present.");
      const selected = [...selectedSteps.values()];
      await builder.json("metadata/provenance.json", { steps: selected.map((s) => { const { args, ...rest } = s; return { ...rest, ...(options.includeCommandArguments ? { args } : { argsOmitted: args !== undefined }) }; }), lineage, scope: "Bounded version-aware producer candidates and upstream inputs; preserve observed/inferred/retrospective distinctions. Not an execution replay specification." }); metadataFiles.push("metadata/provenance.json");
      const artifactBudget: ReadBudget = { remaining: 512 * 1024 * 1024 };
      for (const request of assets) {
        const a = request.row; if (a.status === "excluded") continue;
        if (!options.includeArtifacts) { a.status = "excluded"; a.reason = "Artifact bytes excluded by user; identities remain in the manifest"; issue("artifact-excluded", a.reason, a.id); continue; }
        const anchored = !!a.expectedSha256 && a.basis !== "retrospective" && a.basis !== "unknown";
        let captured: CapturedBlob | undefined; let origin: EvidenceArtifact["origin"]; const failures: string[] = [];
        if (anchored) {
          const saved = blobPath(projectId, a.expectedSha256!);
          if (fs.existsSync(saved)) try {
            const identity = await hashEvidenceFile(projectId, saved, ARTIFACT_BYTES, artifactBudget);
            if (identity.sha256 !== a.expectedSha256) throw new Error("Retained content-addressed snapshot failed checksum verification");
            captured = { ...identity, absolute: saved, created: false }; origin = "retained-snapshot";
          } catch (e) { failures.push((e as Error).message); }
          if (!captured) for (const candidate of retained.get(retainedKey(a.path, a.expectedSha256!)) ?? []) {
            try { captured = await captureBlob(projectId, candidate.absolute, a.expectedSha256, false, artifactBudget); origin = candidate.origin; break; } catch (e) { failures.push((e as Error).message); }
          }
          if (!captured) try { captured = await captureBlob(projectId, artifactPath(projectId, a.path, request.lockfile).absolute, a.expectedSha256, true, artifactBudget, request.lockfile); origin = "current"; } catch (e) { failures.push((e as Error).message); }
        }
        let unverified = !anchored;
        if (!captured && options.includeCurrentUnverified) {
          try { captured = await captureBlob(projectId, artifactPath(projectId, a.path, request.lockfile).absolute, undefined, true, artifactBudget, request.lockfile); origin = "current"; unverified = true; } catch (e) { failures.push((e as Error).message); }
        }
        if (!captured) {
          a.status = anchored ? "unavailable" : "excluded";
          a.reason = anchored ? `Requested historical identity could not be recovered. ${failures.join("; ")}` : "No trustworthy citation/use-time identity; current unverified copies were not requested";
          issue(anchored ? "historical-bytes-unavailable" : "identity-unverified", a.reason, a.id); continue;
        }
        if (captured.created) newlyCreated.add(captured.sha256);
        const extension = path.extname(a.path).toLowerCase();
        const file = `artifacts/${captured.sha256}${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ".bin"}`;
        try {
          await builder.artifact(file, captured.absolute, captured.sha256, captured.size); usedBlobs.add(captured.sha256);
          a.sha256 = captured.sha256; a.size = captured.size; a.archivePath = file; a.origin = origin;
          a.status = unverified ? "included-current-unverified" : "included-matched";
          if (unverified) { a.reason = "Export-time comparison copy, not verified original citation/consumption evidence"; issue("current-copy-unverified", a.reason, a.id); }
          else a.reason = `Bytes match the recorded ${a.basis} identity; this does not verify scientific validity or causal completeness`;
        } catch (e) { a.status = "excluded"; a.reason = (e as Error).message; issue("artifact-package-limit", a.reason, a.id); }
      }
      // Diagnostics generated by filesystem operations need not reveal the
      // host's absolute project/home path. Original research text is retained
      // separately and is explicitly not advertised as automatically redacted.
      const paths = resolvePaths(projectId);
      const portable = (text: string) => text.replaceAll(paths.sandbox, "[sandbox]").replaceAll(paths.root, "[project]");
      for (const item of issues) item.message = portable(item.message);
      for (const item of assets) if (item.row.reason) item.row.reason = portable(item.row.reason);
      if (issues.length >= 500) issues.splice(499, issues.length - 499, { code: "issues-bounded", message: "Further issues were bounded; do not interpret this list as exhaustive" });
      const manifest: EvidencePackageManifest = { schemaVersion: 1, id, projectId, title: options.title, createdAt, options, records: records.map((r) => r.ref), relationships: graph.relationships, artifacts: assets.map((a) => a.row), metadataFiles, issues,
        reproduction: { status: "not-run", reason: "Packaging reads/copies stored evidence only. No analysis, environment probe, model call or remote compute was executed." }, methods: { path: "methods-source.md", kind: "source-linked-scaffold", independentlyVerified: false } };
      await builder.json("manifest.json", manifest);
      await builder.write("methods-source.md", methodsScaffold(records, selected, options.includeCommandArguments, metadataFiles));
      await builder.write("missing-information.md", missingInformation(manifest));
      await builder.write("README.md", packageReadme(manifest));
      await builder.write("verify.py", VERIFY_SOURCE);
      await builder.json("ro-crate-metadata.json", roCrate(manifest, [...builder.files.values()]));
      await builder.write("checksums.sha256", [...builder.files.values()].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.sha256}  ${f.path}\n`).join(""));
      const archive = path.join(dir, "evidence.zip"); await builder.zip(projectId, archive, createdAt);
      const zip = await hashEvidenceFile(projectId, archive, ZIP_BYTES);
      const metadataSize = [...builder.files.values()].filter((f) => !f.path.startsWith("artifacts/")).reduce((n, f) => n + f.size, 0);
      if (storage.packagesBytes + zip.size + metadataSize > PACKAGE_QUOTA) throw new EvidencePackageError("PACKAGE_QUOTA", "Retained package quota reached; remove an older package", 413);
      const value = { id, projectId, createdAt, zipSha256: zip.sha256, zipBytes: zip.size, manifest, files: [...builder.files.values()] };
      const preview = { ...value, digest: jsonDigest(value) };
      if (Buffer.byteLength(JSON.stringify(preview)) > 2 * 1024 * 1024) throw new EvidencePackageError("MANIFEST_LIMIT", "Review manifest exceeds 2 MiB; select fewer roots", 413);
      publishExclusiveJson(path.join(dir, "preview.json"), preview);
      for (const sha of newlyCreated) if (!usedBlobs.has(sha)) {
        const file = blobPath(projectId, sha); if ((await fs.promises.stat(file)).nlink <= 1) await fs.promises.rm(file, { force: true });
      }
      return preview;
    } catch (e) {
      await fs.promises.rm(dir, { recursive: true, force: true });
      for (const sha of newlyCreated) {
        const file = blobPath(projectId, sha);
        try { if ((await fs.promises.stat(file)).nlink <= 1) await fs.promises.rm(file, { force: true }); } catch { /* another retained payload may own this content */ }
      }
      throw e;
    }
  });
}
export function listEvidencePackages(projectId: string) {
  const packages: { id: string; title: string; createdAt: number; bytes: number; issues: number; available: boolean }[] = []; const errors: string[] = [];
  for (const id of packageIds(projectId)) try { const p = readPackage(projectId, id); packages.push({ id, title: p.manifest.title, createdAt: p.createdAt, bytes: p.zipBytes, issues: p.manifest.issues.length, available: true }); } catch (e) { errors.push(`${id}: ${(e as Error).message}`); packages.push({ id, title: "Unavailable/unfinished package", createdAt: 0, bytes: 0, issues: 1, available: false }); }
  let storage;
  try { storage = evidenceStorage(projectId); } catch (e) { errors.push(`Storage usage could not be fully verified: ${(e as Error).message}`); }
  return { packages: packages.sort((a, b) => b.createdAt - a.createdAt), errors, storage };
}
export async function evidencePackageDownload(projectId: string, id: string, body: unknown) {
  const input = body as { digest?: unknown; acknowledgeSensitive?: unknown; acknowledgeLimitations?: unknown } | null;
  const p = readPackage(projectId, id);
  if (input?.digest !== p.digest) throw new EvidencePackageError("PACKAGE_CHANGED", "Review the exact package before downloading", 409);
  if (input.acknowledgeSensitive !== true || input.acknowledgeLimitations !== true) throw new EvidencePackageError("REVIEW_REQUIRED", "Acknowledge sensitive data/rights and the package's limitations before downloading");
  const file = path.join(packageDirectory(projectId, id), "evidence.zip");
  const identity = await hashEvidenceFile(projectId, file, ZIP_BYTES);
  if (identity.sha256 !== p.zipSha256 || identity.size !== p.zipBytes) throw new EvidencePackageError("PACKAGE_CORRUPT", "Retained ZIP no longer matches the reviewed package; it was not regenerated", 409);
  return { preview: p, stream: verifiedEvidenceStream(projectId, file, { sha256: p.zipSha256, size: p.zipBytes }, ZIP_BYTES) };
}
export async function deleteEvidencePackage(projectId: string, id: string): Promise<void> {
  await evidenceExclusive(projectId, async () => { await fs.promises.rm(packageDirectory(projectId, id), { recursive: true, force: true }); });
}
export async function pruneEvidenceSnapshots(projectId: string, confirmed: boolean) {
  if (!confirmed) throw new EvidencePackageError("REVIEW_REQUIRED", "Explicit confirmation is required: pruning can remove historical versions no longer referenced by retained packages");
  return evidenceExclusive(projectId, async () => {
    const referenced = new Set<string>();
    // Fail closed on corrupt packages: their references cannot safely be guessed.
    for (const id of packageIds(projectId)) for (const a of readPackage(projectId, id).manifest.artifacts) if (a.archivePath && a.sha256) referenced.add(a.sha256);
    const root = managedPath(projectId, ".kady/evidence/blobs"); let removed = 0; let bytes = 0;
    if (fs.existsSync(root)) for (const name of (await fs.promises.readdir(root)).filter((n) => SHA256.test(n))) {
      if (referenced.has(name)) continue;
      const file = blobPath(projectId, name); const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new EvidencePackageError("UNSAFE_STORAGE", "Unsafe snapshot entry; no automatic removal", 503);
      await fs.promises.unlink(file); removed++; bytes += stat.size;
    }
    return { removed, bytes, storage: evidenceStorage(projectId) };
  });
}
