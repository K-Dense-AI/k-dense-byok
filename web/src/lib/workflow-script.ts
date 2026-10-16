/**
 * pi-subagents workflow scripts as they appear in the chat.
 *
 * Since pi-subagents 0.74 the agent writes its delegation script in the reply
 * as one ```js workflow (or ```javascript workflow) fenced block and calls
 * `subagent({ workflow: true })`; the plugin runs exactly that block
 * (src/extension/reply-workflow-script.js), or since 0.76 the reply's only
 * plain ```js block when it has no tagged one. Older sessions passed the
 * script as the tool's `workflowScript` argument instead, so history still
 * carries both shapes.
 */

/** The opening line pi-subagents recognizes: exactly three backticks, one space. */
const WORKFLOW_OPEN = /^(```)(?:js|javascript) workflow[ \t]*$/;
const PLAIN_JS_OPEN = /^```(?:js|javascript)[ \t]*$/;
const ANY_OPEN = /^(`{3,}|~{3,})/;
const ANY_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;

export interface WorkflowFence {
  /** The opening backtick run, reused for the rewritten fence. */
  marker: string;
  /** The script between the fences (everything after the opening line while streaming). */
  body: string;
  /** False while the closing fence has not streamed in yet. */
  closed: boolean;
}

/**
 * A single markdown block (one Streamdown block) that is a workflow fence,
 * or null for any other block.
 */
export function parseWorkflowFence(block: string): WorkflowFence | null {
  const text = block.replace(/^(?:[ \t]*\r?\n)+/, "");
  const newline = text.indexOf("\n");
  const first = (newline === -1 ? text : text.slice(0, newline)).replace(/\r$/, "");
  const open = WORKFLOW_OPEN.exec(first);
  if (!open) return null;
  const lines = newline === -1 ? [] : text.slice(newline + 1).split("\n");
  const end = lines.findIndex((line) => {
    const close = ANY_CLOSE.exec(line.replace(/\r$/, ""));
    return close !== null && close[1][0] === "`" && close[1].length >= open[1].length;
  });
  return {
    marker: open[1],
    body: (end === -1 ? lines : lines.slice(0, end)).join("\n"),
    closed: end !== -1,
  };
}

/** The same block with its info string reduced to `js`, for normal highlighting. */
export function asJavaScriptFence(block: string, fence: WorkflowFence): string {
  return block.replace(/^((?:[ \t]*\r?\n)*)[^\n]*/, `$1${fence.marker}js`);
}

/**
 * The closed blocks pi-subagents would read as a reply's script, in order:
 * every ```js workflow block, or when there is none, the reply's plain
 * ```js block if it is the only one. Fences of other kinds are skipped whole,
 * so a workflow fence quoted inside them does not count.
 */
export function workflowScriptsIn(text: string): string[] {
  const tagged: string[] = [];
  const plain: string[] = [];
  let fence: { marker: string; kind?: "tagged" | "plain"; start: number } | undefined;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    if (!fence) {
      const open = ANY_OPEN.exec(line);
      if (open) {
        const kind = WORKFLOW_OPEN.test(line) ? "tagged" : PLAIN_JS_OPEN.test(line) ? "plain" : undefined;
        fence = { marker: open[1], kind, start: index + 1 };
      }
      continue;
    }
    const close = ANY_CLOSE.exec(line);
    if (!close || close[1][0] !== fence.marker[0] || close[1].length < fence.marker.length) continue;
    if (fence.kind) (fence.kind === "tagged" ? tagged : plain).push(lines.slice(fence.start, index).join("\n"));
    fence = undefined;
  }
  return tagged.length > 0 ? tagged : plain.length === 1 ? plain : [];
}

/** Specialist names written as literals: `runs.run(key, { agent: "name", … })`. */
export function workflowScriptAgents(script: string): string[] {
  const names: string[] = [];
  for (const match of script.matchAll(/\bagent\s*:\s*(["'`])([A-Za-z0-9][A-Za-z0-9._-]*)\1/g)) {
    if (!names.includes(match[2])) names.push(match[2]);
  }
  return names;
}
