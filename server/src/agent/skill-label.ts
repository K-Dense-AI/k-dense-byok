/**
 * Resolve a skill's display name from a `read` tool call.
 *
 * Pi has no "skill invoked" event: skills are advertised in the system prompt
 * and the agent activates one by reading its `SKILL.md` (or, for single-file
 * skills, the `.md` directly under a skills root). When a read targets such a
 * file, the emitters attach the skill's name to the `tool_start` client frame
 * (`skill` field) so the chat UI can label the row as a skill activation.
 *
 * The authoritative name is the frontmatter `name:` — parsed with Pi's own
 * skill loader so the label always matches what the system prompt advertises
 * to the model. The directory (or file) basename is the fallback when the
 * file is gone or its frontmatter carries no usable name.
 */
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

/**
 * Path-shape detection + fallback name. Mirrored client-side in
 * `web/src/lib/skill-invocation.ts` (which acts as the display fallback when
 * a frame carries no `skill` field).
 */
function skillPathName(p: string): string | null {
  const norm = p.replaceAll("\\", "/");
  // Directory skill: any <dir>/SKILL.md — the Agent Skills standard names the
  // skill after the directory holding SKILL.md, wherever it lives.
  const segments = norm.split("/").filter((s) => s && s !== ".");
  if (segments.length >= 2 && segments[segments.length - 1] === "SKILL.md") {
    return segments[segments.length - 2];
  }
  // Single-file skill: a .md directly under a Pi skills root (project
  // `.pi/skills/` or global `~/.pi/agent/skills/`).
  const single = norm.match(/(?:^|\/)\.pi\/(?:agent\/)?skills\/([^/]+)\.md$/);
  return single ? single[1] : null;
}

/** Frontmatter `name:` of the skill file, via Pi's loader; null when the file
 *  is unreadable or the loader rejects it. */
function frontmatterName(absFile: string): string | null {
  try {
    const { skills } = loadSkillsFromDir({
      dir: path.dirname(absFile),
      source: "read",
    });
    const target = path.resolve(absFile);
    const hit = skills.find((s) => path.resolve(s.filePath) === target);
    return hit?.name || null;
  } catch {
    return null;
  }
}

/**
 * Skill name for a `read` tool path, or null when the read is not a skill
 * activation. Relative paths resolve against `sandboxRoot` (the agent cwd).
 */
export function skillLabelForRead(
  rawPath: unknown,
  sandboxRoot: string,
): string | null {
  if (typeof rawPath !== "string") return null;
  const fallback = skillPathName(rawPath);
  if (!fallback) return null;
  const abs = path.isAbsolute(rawPath)
    ? rawPath
    : path.join(sandboxRoot, rawPath);
  return frontmatterName(abs) ?? fallback;
}
