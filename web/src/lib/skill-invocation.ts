/**
 * Detect a skill activation from a `read` tool call.
 *
 * Pi has no dedicated "skill invoked" event: available skills are listed in
 * the system prompt and the agent activates one by reading its `SKILL.md`
 * (or, for single-file skills, the `.md` directly under a skills root).
 * Recognizing those reads lets the chat UI label the row with the skill's
 * name instead of a generic file read.
 *
 * The authoritative name is the frontmatter `name:`, which the server
 * resolves and attaches to the frame (`skill` field / ActivityItem.skillName
 * — see server/src/agent/skill-label.ts). This helper is the display
 * fallback for frames without it, deriving a name from the path (directory
 * containing `SKILL.md`, or the file's basename for single-file skills).
 */
export function skillNameFromRead(
  toolName: string | undefined,
  args: unknown,
): string | null {
  if (toolName !== "read" || !args || typeof args !== "object") return null;
  const raw = (args as Record<string, unknown>).path;
  if (typeof raw !== "string") return null;
  const path = raw.replaceAll("\\", "/");
  // Directory skill: any <dir>/SKILL.md — the Agent Skills standard names the
  // skill after the directory holding SKILL.md, wherever it lives.
  const segments = path.split("/").filter((s) => s && s !== ".");
  if (segments.length >= 2 && segments[segments.length - 1] === "SKILL.md") {
    return segments[segments.length - 2];
  }
  // Single-file skill: a .md directly under a Pi skills root (project
  // `.pi/skills/` or global `~/.pi/agent/skills/`).
  const single = path.match(/(?:^|\/)\.pi\/(?:agent\/)?skills\/([^/]+)\.md$/);
  return single ? single[1] : null;
}
