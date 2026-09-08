import type { EvidencePackageManifest } from "../../../web/src/lib/evidence-packages.ts";
import { EVIDENCE_PACKAGE_NOTICE } from "../../../web/src/lib/evidence-packages.ts";
import type { PackageRecord } from "./source-graph.ts";
import type { PackageFile } from "./builder.ts";
import type { ProvenanceStep } from "../provenance/store.ts";
import { stepKey } from "./provenance.ts";
export const mdText = (s: string) => s.replace(/[\\`*_{}\[\]<>()#+.!|~\-]/g, "\\$&").replace(/[\r\n]+/g, " ");
function fence(s: string, language = "text"): string {
  const ticks = "`".repeat(Math.max(3, ...(s.match(/`+/g) ?? []).map((x) => x.length + 1)));
  return `${ticks}${language}\n${s}\n${ticks}`;
}
export function methodsScaffold(records: PackageRecord[], steps: ProvenanceStep[], includeArgs: boolean, metadataFiles: string[] = []): string {
  const lines = ["# Source-linked Methods scaffold", EVIDENCE_PACKAGE_NOTICE,
    "This is a deterministic source scaffold, not an AI-written manuscript section. Quotations are the recorded author's account, not proof of execution. Keep failed attempts, limitations and deviations explicit; edit for publication only after checking the observational provenance. Every quoted block links to its packaged source."];
  for (const r of records) {
    if (r.document.entry.proposalOnly || r.document.original?.entry.nextExperiments || r.document.original?.entry.nextExperimentDecision || !["method", "decision", "observation"].includes(r.ref.type)) continue;
    const entry = r.document.entry;
    lines.push(`\n## ${mdText(r.ref.title)}`, `Source: [${r.ref.key}](${r.ref.archivePath}) · ${r.ref.type} · ${r.ref.status} · recorded author ${mdText(r.ref.author)}`);
    if (entry.scope) lines.push(`Applicability (authored): ${mdText(entry.scope)}`);
    if (entry.revisitWhen) lines.push(`Revisit condition, not an action performed: ${mdText(entry.revisitWhen)}`);
    if (entry.outcome) lines.push(`Recorded outcome: ${entry.outcome}. Technical failure and null/inconclusive findings are not automatically refutations.`);
    for (const limitation of entry.limitations ?? []) lines.push(`Limitation: ${mdText(limitation)}`);
    const body = entry.body ?? "";
    for (const paragraph of body.slice(0, 8000).split(/\n\s*\n/).filter(Boolean)) lines.push(fence(paragraph), `[Source ${r.ref.key}](${r.ref.archivePath})`);
    if (body.length > 8000) lines.push("[Scaffold excerpt bounded; consult the full packaged source JSON.]");
    if (entry.code) lines.push(fence(entry.code.source.slice(0, 8000), "text"), `[Recorded snippet, not a replay recipe — source](${r.ref.archivePath})`);
  }
  lines.push("\n## Observed execution references", "The recorded effects/edges may be inferred, incomplete or retrospective. They do not prove every internal read or an exact reproducible environment. [Full selected provenance](metadata/provenance.json).");
  for (const step of steps) {
    lines.push(`- ${mdText(stepKey(step))}: tool ${mdText(step.toolName)}, actor ${mdText(step.role)}, ${new Date(step.timestamp).toISOString()}${step.isError ? ", recorded error" : ""}${step.environmentId ? `; environment ${step.environmentId}` : "; environment not recorded"}. [Source](metadata/provenance.json)`);
    if (includeArgs && step.args !== undefined) lines.push(fence(JSON.stringify(step.args, null, 2)), "Recorded arguments only. Never execute them automatically; source arguments may already be truncated.");
  }
  lines.push("\n## Plans, deviations and structured results", "Read these retained records before writing final Methods. Plans and approvals describe intentions, not execution; user-reported deviations and script-provided results need independent review.", ...metadataFiles.filter((name) => /metadata\/(plans|workflows|results|environments)\//.test(name)).map((name) => `- [${name}](${name})`));
  lines.push("\n## Required author review", "See [missing-information.md](missing-information.md). Random seeds, hardware, execution environments, data rights and external citations are not assumed verified. Frozen plans describe intended methods, not actions performed. No rerun has been attempted.");
  return lines.join("\n\n") + "\n";
}
export function packageReadme(manifest: EvidencePackageManifest): string {
  return [`# ${mdText(manifest.title)}`, EVIDENCE_PACKAGE_NOTICE,
    `Package ${manifest.id} · project ${manifest.projectId} · assembled ${new Date(manifest.createdAt).toISOString()}. This timestamp is local assembly, not external publication or preregistration.`,
    "## Start here", "- [Manifest and artifact-version table](manifest.json)\n- [Missing/unverified information](missing-information.md)\n- [Source-linked Methods scaffold](methods-source.md)\n- [Evidence relationships](metadata/evidence.json)\n- [Selected observational provenance](metadata/provenance.json)\n- [RO-Crate metadata](ro-crate-metadata.json)",
    "## Source records", ...manifest.records.map((r) => `- [${mdText(r.title)}](${r.archivePath}) — ${r.type}; ${r.selection}; ${r.status}; ${mdText(r.source.sessionId)}/${mdText(r.source.entryId)}. Source digest ${r.sourceDigest} (JSONL row excluding LF).`),
    "## Artifact versions", ...manifest.artifacts.map((a) => `- ${mdText(a.path)} — ${a.status}; identity basis ${a.basis}; expected ${a.expectedSha256 ?? "not recorded"}; packaged ${a.sha256 ?? "none"}${a.archivePath ? ` ([bytes](${a.archivePath}))` : ""}. ${mdText(a.reason ?? "")}`),
    "Only included-matched files with the appropriate identity basis match a recorded version. Current-unverified copies are not original evidence. Retrospective/unknown identities never become citation-time proof. Matching bytes do not prove scientific validity or execution provenance.",
    "## Integrity check (optional, manual)", "After extracting, run `python3 -I verify.py`. The static verifier hashes files only; it does not run the captured analysis, install dependencies or contact a service. Check the ZIP sha256 against the value shown by Kady before trusting a received archive. Checksums inside an archive are not a digital signature: a third party can replace both data and checksums.",
    "## Reproduction and sharing", "No scripts, shell commands, R probes, model calls or Modal jobs were executed by packaging. Code files are included as data with non-executable archive permissions. Do not execute untrusted artifacts. Reproduction requires an independently reviewed recipe/environment and explicit execution approval. Do not assume this package supplies a dataset/code license or removes sensitive information. Raw provenance arguments are excluded unless explicitly selected; notebook prose/snippets and artifact contents are not automatically redacted.",
    "## Interoperability", "This package supplies a base RO-Crate 1.1 JSON-LD descriptor and file inventory. It does not assert Workflow Run/Provenance Run Crate conformance, complete lineage or verified reproducibility. Standard JSON-LD processors may need the public RO-Crate context; package preparation itself does not fetch network resources.",
  ].join("\n\n") + "\n";
}
export function missingInformation(manifest: EvidencePackageManifest): string {
  return ["# Missing and unverified information", "These gaps are part of the evidence record, not proof that a result is false. Included/matching file bytes are not a scientific validation.",
    ...manifest.issues.map((i) => `- **${mdText(i.code)}**${i.subject ? ` (${mdText(i.subject)})` : ""}: ${mdText(i.message)}`),
    "No rerun was performed. No inference of verified absence should be made where a scan, graph walk, snapshot, schema or size budget was incomplete.",
  ].join("\n\n") + "\n";
}
export function roCrate(manifest: EvidencePackageManifest, files: PackageFile[]) {
  const payload = [...files.map((f) => ({ "@id": f.path })), { "@id": "checksums.sha256" }];
  return { "@context": ["https://w3id.org/ro/crate/1.1/context", { sha256: "urn:kady:sha256" }], "@graph": [
    { "@id": "ro-crate-metadata.json", "@type": "CreativeWork", conformsTo: { "@id": "https://w3id.org/ro/crate/1.1" }, about: { "@id": "./" } },
    { "@id": "./", "@type": "Dataset", name: manifest.title, description: "Local reviewer evidence snapshot; not a reproduced analysis, complete execution trace or external publication. See manifest.json and missing-information.md.", datePublished: new Date(manifest.createdAt).toISOString(), license: "No license is granted by packaging. Confirm rights with data/code owners before redistribution.", hasPart: payload },
    ...files.map((f) => ({ "@id": f.path, "@type": "File", name: f.path, contentSize: String(f.size), sha256: f.sha256 })),
    { "@id": "checksums.sha256", "@type": "File", description: "Integrity inventory, including this RO-Crate descriptor; not an authenticity signature." },
  ] };
}
export const VERIFY_SOURCE = `# Static integrity verifier. It never runs captured analyses.
import sys
if not sys.flags.isolated:
    raise SystemExit("Run as: python3 -I verify.py (isolated mode required)")
import hashlib
from pathlib import Path, PurePosixPath
root = Path(__file__).resolve().parent
expected = {}
for line in (root / "checksums.sha256").read_text(encoding="utf-8").splitlines():
    digest, name = line.split("  ", 1)
    rel = PurePosixPath(name)
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest) or rel.is_absolute() or ".." in rel.parts or "\\\\" in name or name in expected:
        raise SystemExit("Invalid integrity manifest")
    expected[name] = digest
actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() or p.is_symlink()}
if actual != set(expected) | {"checksums.sha256"}:
    raise SystemExit("Unexpected or missing files; inspect the package")
total = 0
for name, digest in expected.items():
    file = root / name
    if file.is_symlink() or root not in file.resolve().parents:
        raise SystemExit("Unsafe file path")
    size = file.stat().st_size
    total += size
    if size > 268435456 or total > 268435456:
        raise SystemExit("Package exceeds verification size limit")
    h = hashlib.sha256()
    with file.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1048576), b""):
            h.update(chunk)
    if h.hexdigest() != digest:
        raise SystemExit("Checksum mismatch: " + name)
print("Verified", len(expected), "file hashes. Integrity only: not reproduced or scientifically validated.")
`;
