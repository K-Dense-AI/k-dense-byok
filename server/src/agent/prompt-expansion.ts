/**
 * Slash-command expansion for chat input: `/skill:<name> args` and
 * `/<template> args` on the FIRST line of a message.
 *
 * Pi's `AgentSession.prompt()` expands both itself, but (a) its template
 * substitution drops arguments the template does not reference, (b) it treats
 * the whole message as the command, so the file references and skill context
 * Kady's composer appends would become `$ARGUMENTS`, and (c) it reads the
 * template/skill lists cached at session start. Kady therefore expands here,
 * from disk, and calls `prompt()` with `expandPromptTemplates: false`.
 *
 * The skill block is byte-identical to Pi's own (`<skill name= location=>` …),
 * so Pi's exported `parseSkillBlock` and the UI's chip both recognize it. A
 * template expands to `<prompt-template name=…>` so the UI can render it as a
 * chip rather than a wall of text.
 *
 * `parseCommandArgs` / `substituteArgs` are ports of Pi's (not exported from
 * the package root); `prompt-expansion.test.ts` pins parity.
 */
import fs from "node:fs";

export interface ExpandableSkill {
  name: string;
  filePath: string;
  baseDir: string;
}

export interface ExpandableTemplate {
  name: string;
  content: string;
}

export interface ExpansionSources {
  skills: readonly ExpandableSkill[];
  templates: readonly ExpandableTemplate[];
  /** Injectable for tests. */
  readFile?: (filePath: string) => string;
}

export type Expansion =
  | { kind: "none"; text: string }
  | { kind: "skill"; text: string; name: string; args: string }
  | { kind: "template"; text: string; name: string; args: string };

/** Pi's argument splitter: whitespace-separated, quotes group, quotes removed. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

const PLACEHOLDER_RE = /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;

/** Pi's substitution: `$1`…`$N`, `$@`/`$ARGUMENTS`, `${N:-default}`, `${@:N}`, `${@:N:L}`. */
export function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  return content.replace(PLACEHOLDER_RE, (_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
    if (defaultTarget) {
      const value =
        defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
      return value ? value : defaultValue;
    }
    if (sliceStart) {
      let start = parseInt(sliceStart, 10) - 1;
      if (start < 0) start = 0;
      if (sliceLength) return args.slice(start, start + parseInt(sliceLength, 10)).join(" ");
      return args.slice(start).join(" ");
    }
    if (simple === "ARGUMENTS" || simple === "@") return allArgs;
    return args[parseInt(simple, 10) - 1] ?? "";
  });
}

export function hasArgumentPlaceholder(content: string): boolean {
  return new RegExp(PLACEHOLDER_RE.source).test(content);
}

/** Strip a leading YAML frontmatter block (same shape Pi accepts). */
export function stripFrontmatterBlock(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length) : content;
}

const COMMAND_RE = /^\/(skill:)?([^\s/][^\s]*)(?:[ \t]+(.*))?$/;

/**
 * Expand a leading `/skill:name args` or `/template args`. Only the first line
 * is the command; the remaining lines (composer-appended file references,
 * database and skill context) follow the expansion after a blank line.
 * Unknown names pass through unchanged.
 */
export function expandLeadingCommand(text: string, sources: ExpansionSources): Expansion {
  const newline = text.indexOf("\n");
  const firstLine = (newline === -1 ? text : text.slice(0, newline)).trimEnd();
  const rest = newline === -1 ? "" : text.slice(newline + 1).replace(/^\s*\n/, "");
  const match = firstLine.match(COMMAND_RE);
  if (!match) return { kind: "none", text };
  const [, skillPrefix, name, rawArgs = ""] = match;
  const args = rawArgs.trim();
  const tail = rest.trim() ? `\n\n${rest.replace(/\s+$/, "")}` : "";
  const readFile = sources.readFile ?? ((file: string) => fs.readFileSync(file, "utf-8"));

  if (skillPrefix) {
    const skill = sources.skills.find((s) => s.name === name);
    if (!skill) return { kind: "none", text };
    let body: string;
    try {
      body = stripFrontmatterBlock(readFile(skill.filePath)).trim();
    } catch {
      return { kind: "none", text };
    }
    const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return { kind: "skill", name: skill.name, args, text: `${block}${args ? `\n\n${args}` : ""}${tail}` };
  }

  const template = sources.templates.find((t) => t.name === name);
  if (!template) return { kind: "none", text };
  const parsed = parseCommandArgs(args);
  let body = substituteArgs(template.content, parsed).trim();
  // Kady rule: a template with no placeholder still receives its arguments.
  if (args && !hasArgumentPlaceholder(template.content)) body += `\n\n${args}`;
  const block = `<prompt-template name="${template.name}">\n${body}\n</prompt-template>`;
  return { kind: "template", name: template.name, args, text: `${block}${tail}` };
}
