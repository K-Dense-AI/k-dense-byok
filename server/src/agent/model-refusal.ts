/**
 * Provider-side refusals: a request rejected before generation.
 *
 * Anthropic's Mythos-class models run an input safety classifier that can
 * reject a request outright. The response then carries
 * `stop_reason: "refusal"` — OpenRouter maps it to
 * `finish_reason: "content_filter"` — and *no* `usage` object at all, so
 * nothing is billed and no tokens are reported. Pi turns that into an
 * assistant message with `stopReason: "error"` and
 * `errorMessage: "Provider finish_reason: content_filter"`: accurate, and
 * useless to whoever has to fix it.
 *
 * The classifier reads the whole request, system prompt included, so on this
 * app the cause is usually not the user's message — it is the skills index Pi
 * injects, which on a scientific project lists ~90 skill descriptions dense
 * with protein-design and pathogen-surveillance vocabulary. Verified
 * 2026-08-27 against `anthropic/claude-fable-5` on OpenRouter: each skill in
 * KNOWN_REFUSAL_TRIGGER_SKILLS refuses on its own, from a plain
 * chat-completions call carrying only that one skill's description and a
 * "Reply with exactly: ok" user turn — no tools, no conversation. The same
 * prompts return normally on claude-opus-4.8, claude-sonnet-5, and gpt-5.5.
 *
 * It is NOT specific to subagents even though that is where it usually shows
 * up first (children are pinned to the parent's model and start a fresh
 * process): the lead agent loads the same project skills and refuses the same
 * way. That is why the guidance below is written for both paths.
 */
import { resolvePaths } from "../projects.ts";
import { listProjectSkills, projectSkillRoot } from "./skills.ts";

/**
 * Skills whose *description alone* triggers a refusal on Claude Fable 5.
 *
 * Empirical, not a policy statement, and expected to drift as providers retune
 * their classifiers — so it is only ever used to make an error message more
 * specific, never to block, disable, or filter anything. To re-derive it, send
 * each enabled skill's frontmatter `description` as the system prompt of a
 * one-line chat-completions request and look for
 * `finish_reason: "content_filter"`.
 *
 * Every entry is from the seeded `scientific-agent-skills` catalogue and is
 * bio-design or pathogen adjacent (de novo protein/binder design, docking,
 * vaccine design, cloud-lab protein expression, viral lineage surveillance).
 */
export const KNOWN_REFUSAL_TRIGGER_SKILLS = [
  "adaptyv",
  "diffdock",
  "ginkgo-cloud-lab",
  "glycoengineering",
  "pathogen-variant-surveillance",
  "phylogenetics",
  "tamarind",
] as const;

/** Models observed to refuse on the skills index (substring match on the ref). */
const REFUSING_MODEL_HINTS = ["fable"];

/**
 * Recognize a provider refusal in a Pi/provider error string.
 *
 * `refusal` is matched only next to a finish/stop reason: the bare word turns
 * up in ordinary model prose and in unrelated provider messages, and a false
 * positive here appends misleading advice to a real error.
 */
export function isProviderRefusal(message: string | undefined | null): boolean {
  if (!message) return false;
  return (
    /content[_\s-]?filter/i.test(message) ||
    /(finish|stop)[_\s-]?reason\s*[:=]?\s*"?refusal/i.test(message)
  );
}

function enabledTriggerSkills(projectId: string): string[] {
  try {
    const installed = new Set(
      listProjectSkills(projectSkillRoot(resolvePaths(projectId))).map((s) => s.name),
    );
    return KNOWN_REFUSAL_TRIGGER_SKILLS.filter((name) => installed.has(name));
  } catch {
    // Guidance is a nicety attached to an error that already happened; a
    // missing or unreadable skills dir must not replace it with a new error.
    return [];
  }
}

/**
 * Actionable explanation for a refusal, as markdown. Always returns something:
 * the generic half is what makes the error legible, the skill list is what
 * makes it fixable.
 */
export function providerRefusalGuidance(args: {
  projectId: string;
  modelRef?: string;
}): string {
  const model = args.modelRef ? `\`${args.modelRef}\`` : "this model";
  const known = REFUSING_MODEL_HINTS.some((hint) =>
    (args.modelRef ?? "").toLowerCase().includes(hint),
  );
  const lines = [
    `**The provider refused this request before generating anything.** ` +
      `Nothing was billed — a refusal carries no token usage, which is why the ` +
      `run reports zero input tokens.`,
    `${model} runs a safety classifier over the *entire* request, so the cause ` +
      `is often not the message you sent: the skills index Kady loads into the ` +
      `system prompt lists every enabled skill's description, and a few of the ` +
      `seeded scientific skills are enough on their own.`,
  ];
  const triggers = enabledTriggerSkills(args.projectId);
  if (triggers.length > 0) {
    lines.push(
      `Enabled in this project and known to trigger it individually: ` +
        `${triggers.map((n) => `\`${n}\``).join(", ")}. Disable the ones you ` +
        `don't need under Settings → Skills, then start a new chat tab ` +
        `(live sessions keep the skills they loaded).`,
    );
  } else {
    lines.push(
      `No skill known to trigger this is enabled here, so look to the ` +
        `conversation, an attached file, or a recently installed skill.`,
    );
  }
  lines.push(
    known
      ? `Claude Opus 4.8 and Claude Sonnet 5 accept the same prompt — switching ` +
        `this chat's model is the quickest way to keep working. If subagents ` +
        `failed, they inherit the lead's model unless a specialist pins its own.`
      : `Retrying on a different model (Claude Opus 4.8, Claude Sonnet 5) ` +
        `confirms whether the refusal is specific to this one.`,
  );
  return lines.join("\n\n");
}

/** Append refusal guidance to a provider error message, or pass it through. */
export function explainProviderRefusal(
  message: string,
  args: { projectId: string; modelRef?: string },
): string {
  if (!isProviderRefusal(message)) return message;
  return `${message}\n\n${providerRefusalGuidance(args)}`;
}
