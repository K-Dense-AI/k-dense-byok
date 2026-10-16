/**
 * Seed the pinned plugin's prompts and complete skill trees into a project,
 * and carry unchanged copies forward when the plugin is upgraded.
 *
 * `.kady/subagent-resources.json` records the plugin version and the hash of
 * each file as Kady last wrote it. On a new plugin version a file that still
 * has its recorded hash is replaced; an edited file is left alone, a deleted
 * file or entry stays deleted, a disabled skill is upgraded where it sits in
 * `skills-disabled/`, and an entry the new version adds is seeded once.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ProjectPaths } from "../projects.ts";
import { atomicJson } from "../atomic-json.ts";

const KINDS = ["prompts", "skills"] as const;

/**
 * What pi-subagents 0.73.1 and 0.74.0 shipped, for projects seeded before the
 * marker recorded hashes (`{ version: 1 }`). A copy matching one of these is
 * unchanged since seeding and may be upgraded. Never extend this list: newer
 * seeds record their own hashes.
 */
const LEGACY_SHIPPED_HASHES: Readonly<Record<string, readonly string[]>> = {
  "prompts/council.md": ["f530f269f17453839f9303363fedfeb22bd6e1d985a6b65cbff516650d48b8c4"],
  "prompts/gather-context-and-clarify.md": ["d1eab578f7e4094a3a4265acb288b914a3e1a8ca4c9b316c5e55bcbcb6c1342b"],
  "prompts/parallel-cleanup.md": ["4491517710a21defb578c8b29a8999498ed8317ec6862678ba19ba9e0a380bec"],
  "prompts/parallel-research.md": ["7a279437a1ec4cfc442df321df7585afe0c41c0e96856bd0a02c558e6a95db19"],
  "prompts/parallel-review.md": ["035b608dad129aaf8cd73510405b5841411cf71416eb7d963427cd0dd4d62f6e"],
  "prompts/review-loop.md": ["bf2be67fbf41e08d9407799fa71d1713444525a963dda0bc4a0b38b25a7a30c1", "d2dba60159f287617b1019a7293a59568ea911cccaa7630cfd7e7fb93761ebd0"],
  "skills/council-mode/SKILL.md": ["31be86e2177a283a53d9e36044cdb655a5060cf217fcc0594d163ea44e8642e4", "e998812debc33870e5324fba20d5fe48930708e0b1498a7971504d60064881de"],
  "skills/council-mode/references/pass-contracts.md": ["f2eb16d989d4396e0fc3147ba2108db08e4e89b9020ab68629a86cb2957836a3"],
  "skills/pi-subagents/SKILL.md": ["764929498b58dab2077b8730b901767ab18cac628379697206223189414ae8c8", "41afc1f9e42006dad5188876f5af3fc5ae667d982e8d9ec88c720cbcedc35a4a"],
  "skills/pi-subagents/references/constraints-and-recipes.md": ["c2cbdaa47f3635f7916415596b0b980f8d1ffc3d6eaeab943503529238def150", "3d29b0afb85a3de811a35e9f3c02a497197cf7f06d17a2509902363819ecdee4"],
  "skills/pi-subagents/references/execution-controls.md": ["d3b9324116c312c62a4f076440f5f3591ef6740881064962e92fe9f4d709e5eb", "2bc254cd2752ca151f54123c0e712d8fe57955cee28adb2181291b3cccc8611b"],
  "skills/pi-subagents/references/management-authoring-rpc.md": ["f2805c6dc133da3764bc25b442d034d48e9025f9c0515dc397fc596f3f437a3b", "84040fea75995ffd1f31948ffc71fc029bae7ebc7c1d80a9bd4d3d73e73cad93"],
  "skills/pi-subagents/references/multi-lane-orchestration.md": ["acfa04d23b9242ad397bee6dc228e2fd25d89a6dc6f9bcbd90de0965183fdd21", "5c992895600e9db57f3f305ef956af15a5c6979b1589b622a8e4375ec1bce4a6"],
  "skills/pi-subagents/references/prompting-and-roles.md": ["35868751809d9790523fe146ba8a59321a4850c7e7afaff41f5254b4e3ef9558", "7f80966b80bd424f66749eb4139842ad7d1e51700a99136acef68d819273e4df"],
  "skills/pi-subagents/references/review-and-validation.md": ["2c41ea67edc0b9552058ae135b71d04d653d94e8180410417036e5353f8580bc"],
};

interface Marker {
  version: 2;
  plugin: string;
  /** `<kind>/<path>` → sha256 of the shipped file Kady last wrote there. */
  files: Record<string, string>;
}

const sha256 = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");

function listFiles(root: string, dir = ""): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(root, rel) : entry.isFile() ? [rel] : [];
  });
}

/** The current marker, `"legacy"` for one without hashes, or undefined when never seeded. */
function readMarker(file: string): Marker | "legacy" | undefined {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "legacy";
  }
  const marker = value as Partial<Marker> | null;
  return marker?.version === 2 && typeof marker.plugin === "string" && marker.files && typeof marker.files === "object"
    ? (marker as Marker)
    : "legacy";
}

export function seedSubagentResources(paths: ProjectPaths): void {
  const markerFile = path.join(paths.kadyDir, "subagent-resources.json");
  const packageDir = path.dirname(createRequire(import.meta.url).resolve("pi-subagents"));
  const plugin = String(JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version);
  const previous = readMarker(markerFile);
  if (previous !== undefined && previous !== "legacy" && previous.plugin === plugin) return;
  const recorded = previous === "legacy" ? LEGACY_SHIPPED_HASHES : Object.fromEntries(
    Object.entries(previous?.files ?? {}).map(([rel, hash]) => [rel, [hash]]),
  );
  const seededEntry = (kind: string, entry: string) =>
    Object.keys(recorded).some((rel) => rel === `${kind}/${entry}` || rel.startsWith(`${kind}/${entry}/`));
  const files: Record<string, string> = {};
  for (const kind of KINDS) {
    const source = path.join(packageDir, kind);
    for (const rel of listFiles(source)) {
      const key = `${kind}/${rel}`;
      const entry = rel.split("/")[0];
      const shipped = fs.readFileSync(path.join(source, rel));
      const hash = sha256(shipped);
      const disabled = kind === "skills" && !fs.existsSync(path.join(paths.sandbox, ".pi", kind, entry)) &&
        fs.existsSync(path.join(paths.sandbox, ".pi", "skills-disabled", entry));
      // A first seed never writes into a skill the project disabled under that name.
      if (disabled && !seededEntry(kind, entry)) continue;
      const dest = path.join(paths.sandbox, ".pi", disabled ? "skills-disabled" : kind, rel);
      if (fs.existsSync(dest)) {
        const current = sha256(fs.readFileSync(dest));
        if (current !== hash && recorded[key]?.includes(current)) fs.writeFileSync(dest, shipped);
        // An edited copy (or the project's own file of that name) keeps a
        // record no shipped file matches, so later upgrades leave it alone.
        files[key] = current === hash || recorded[key]?.includes(current) ? hash : recorded[key]?.[0] ?? "local";
        continue;
      }
      // Deleted since seeding: the file itself, or its whole prompt/skill.
      if (recorded[key]) {
        files[key] = recorded[key][0];
        continue;
      }
      if (seededEntry(kind, entry) && !disabled && !fs.existsSync(path.join(paths.sandbox, ".pi", kind, entry))) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, shipped);
      files[key] = hash;
    }
  }
  atomicJson(markerFile, { version: 2, plugin, files } satisfies Marker);
}
