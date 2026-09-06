/**
 * Input inference for opaque tool calls.
 *
 * The scan-diff sees what `python de_analysis.py counts.csv` WROTE, but a read
 * leaves no trace on disk, so a bash step used to have no input edges at all —
 * which broke the lineage a scientist actually wants (figure <- script <- data)
 * at exactly the step that does the science.
 *
 * The command line itself is the best available witness. A token that names a
 * file which existed before the call and which the call did not write is very
 * probably something the command read: the script, its data, a config. That is
 * evidence, not observation, so these edges are `inferred` and never promoted;
 * `cat a.csv > b.csv` correctly yields a.csv as inferred input and b.csv as an
 * observed output, while `rm old.csv` yields a deleted output and no input.
 */

/** Never more than this many inferred inputs per step — a `cat *.csv`
 *  expanded by the model into 400 names is not a useful lineage. */
export const MAX_MENTIONED_INPUTS = 32;

/** Characters that end a shell word. `=` splits `--input=data.csv`. */
const SPLIT = /[\s"'`;|&<>()=,]+/;

/** Tokens containing these cannot be a literal existing path. */
const GLOB_OR_VAR = /[*?[\]{}$~]/;

/**
 * Sandbox-relative paths mentioned in `command` that `exists` confirms. The
 * caller supplies `exists` over the pre-call snapshot so a file the command
 * itself created is not mistaken for an input.
 */
export function mentionedPaths(command: string, exists: (rel: string) => boolean): string[] {
  const seen = new Set<string>();
  for (const raw of command.split(SPLIT)) {
    if (!raw || raw.startsWith("-") || GLOB_OR_VAR.test(raw)) continue;
    // Trailing punctuation from prose-like commands (`echo done.`) and a
    // leading `./` both hide an otherwise exact match.
    let token = raw.replace(/[.:!]+$/, "");
    while (token.startsWith("./")) token = token.slice(2);
    if (!token || token === "." || token === "..") continue;
    if (token.split("/").some((part) => part === "..")) continue; // resolve elsewhere
    if (exists(token)) seen.add(token);
    if (seen.size >= MAX_MENTIONED_INPUTS) break;
  }
  return [...seen].sort();
}
