/**
 * Recognize the blocks Kady's server writes when it expands a slash command
 * (`/skill:name args`, `/template args`) so the transcript can show a compact
 * chip instead of the full expanded text. Mirrors Pi's `parseSkillBlock`
 * regex for skills; templates use Kady's own `<prompt-template>` wrapper.
 */
export interface CommandBlock {
  kind: "skill" | "template";
  name: string;
  /** Expanded body (skill instructions or substituted template). */
  body: string;
  /** Text after the block: the user's arguments and composer-appended context. */
  tail: string;
}

const SKILL_RE = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;
const TEMPLATE_RE = /^<prompt-template name="([^"]+)">\n([\s\S]*?)\n<\/prompt-template>(?:\n\n([\s\S]+))?$/;

export function parseCommandBlock(text: string): CommandBlock | null {
  const skill = text.match(SKILL_RE);
  if (skill) return { kind: "skill", name: skill[1], body: skill[3], tail: skill[4] ?? "" };
  const template = text.match(TEMPLATE_RE);
  if (template) return { kind: "template", name: template[1], body: template[2], tail: template[3] ?? "" };
  return null;
}

export interface SlashMenuItem {
  /** What gets inserted: `/qc` or `/skill:name`. */
  command: string;
  label: string;
  description: string;
  argumentHint?: string;
  kind: "template" | "skill";
}

/** Items for the composer's `/` menu, filtered by the text typed after `/`. */
export function slashMenuItems(
  query: string,
  templates: ReadonlyArray<{ name: string; description: string; argumentHint?: string }>,
  skills: ReadonlyArray<{ name: string; description: string }>,
  limit = 8,
): SlashMenuItem[] {
  const q = query.toLowerCase();
  const items: SlashMenuItem[] = [
    ...templates.map((t) => ({
      command: `/${t.name}`,
      label: `/${t.name}`,
      description: t.description,
      ...(t.argumentHint ? { argumentHint: t.argumentHint } : {}),
      kind: "template" as const,
    })),
    ...skills.map((s) => ({
      command: `/skill:${s.name}`,
      label: `/skill:${s.name}`,
      description: s.description,
      kind: "skill" as const,
    })),
  ];
  if (!q) return items.slice(0, limit);
  const starts = items.filter((i) => i.label.slice(1).toLowerCase().startsWith(q));
  const contains = items.filter(
    (i) => !starts.includes(i) && (i.label.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)),
  );
  return [...starts, ...contains].slice(0, limit);
}
