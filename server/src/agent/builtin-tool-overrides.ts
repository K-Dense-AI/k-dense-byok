/**
 * Reconciling the `subagents.agentOverrides.<name>.tools` entries Kady seeds
 * for pi-subagents' BUILTIN specialists.
 *
 * Builtins pin a `tools:` allowlist in their frontmatter, and Pi applies it to
 * extension/package tools too — so a child would load our packages and then
 * have `notebook`, the Modal family, and the PDF annotation tools filtered
 * straight back out. Three bridges (notebook, modal, pdf-annotation) each
 * extend the allowlist for their own group, in that order.
 *
 * Each of them writes `<declared frontmatter tools> + <its group>`, so the
 * declared list gets *copied* into project settings. That copy goes stale when
 * an upstream release narrows a builtin: pi-subagents 0.47.1 removed `bash`,
 * `edit`, and `write` from `reviewer` to give read-only review lanes a hard
 * launch-time boundary, and a settings file seeded before that upgrade would
 * silently hand all three back. An override must therefore be reconciled
 * against the package's *current* frontmatter, not only extended.
 *
 * Ownership is decided by shape: drop the tools the builtin no longer declares
 * and that are not ours, and ask whether what remains is something we would
 * have generated. A hand-written allowlist does not match and is left alone.
 * A deliberate user *addition* to a Kady-shaped list is indistinguishable from
 * an upstream removal, and is dropped — the safe direction, since it converges
 * on the narrower allowlist upstream chose. No UI writes this field.
 */

/** Order-insensitive set equality for tool-name lists. */
export function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function uniqueTools(tools: readonly string[]): string[] {
  return [...new Set(tools)];
}

export interface ReconcileBuiltinToolsInput {
  /** The override's current `tools` value. */
  existing: readonly string[];
  /** The builtin's current frontmatter `tools:` list. */
  declared: readonly string[];
  /** The calling bridge's own tool group. */
  add: readonly string[];
  /**
   * Every allowlist shape Kady generates for this builtin, built from the
   * CURRENT declared list — the caller already computes these to recognize the
   * output of the bridges that run before it.
   */
  shapes: readonly (readonly string[])[];
}

/**
 * The tools to write for one builtin, or `null` to leave the override alone
 * (either it is user-owned, or it already says what it should).
 */
export function reconcileBuiltinTools({
  existing,
  declared,
  add,
  shapes,
}: ReconcileBuiltinToolsInput): string[] | null {
  // Everything any bridge may inject, inferred from the shapes the caller
  // built: whatever they contain beyond the declared list is ours.
  const ours = new Set(shapes.flat().filter((tool) => !declared.includes(tool)));
  // Tools the builtin no longer declares and that no bridge added — the stale
  // copy of an older frontmatter list, if this override is one of ours.
  const withoutStale = existing.filter((tool) => declared.includes(tool) || ours.has(tool));
  if (!shapes.some((shape) => sameToolSet(withoutStale, shape))) return null;

  const carried = existing.filter((tool) => ours.has(tool));
  const next = uniqueTools([...declared, ...add, ...carried]);
  return sameToolSet(next, existing) ? null : next;
}
