import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "./message";
import {
  asJavaScriptFence,
  parseWorkflowFence,
  workflowScriptsIn,
} from "@/lib/workflow-script";

const script = 'const scan = await runs.run("scan", { agent: "scout", task: "Look" });\nreturn runs.run("fix", { agent: "worker", task: scan.text });';
const reply = `I'll split this in two.\n\n\`\`\`js workflow\n${script}\n\`\`\`\n\nLaunching now.`;

describe("workflow script fences", () => {
  it("folds a ```js workflow block into a collapsed disclosure", () => {
    const { container } = render(<MessageResponse>{reply}</MessageResponse>);
    expect(screen.getByText("I'll split this in two.")).toBeInTheDocument();
    expect(screen.getByText("Launching now.")).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: /Workflow script/ });
    expect(trigger).toHaveTextContent("scout · worker");
    expect(container.textContent).not.toContain("runs.run");
    fireEvent.click(trigger);
    expect(container.textContent).toContain('runs.run("scan"');
  });

  it("leaves ordinary code blocks alone", () => {
    const { container } = render(
      <MessageResponse>{"```js\nconsole.log(1)\n```"}</MessageResponse>,
    );
    expect(screen.queryByRole("button", { name: /Workflow script/ })).not.toBeInTheDocument();
    expect(container.textContent).toContain("console.log(1)");
  });

  it("parses fences the way pi-subagents does", () => {
    const fence = parseWorkflowFence("```javascript workflow\nreturn 1\n```\n");
    expect(fence).toMatchObject({ marker: "```", body: "return 1", closed: true });
    expect(asJavaScriptFence("```javascript workflow\nreturn 1\n```\n", fence!)).toBe("```js\nreturn 1\n```\n");
    expect(parseWorkflowFence("```js workflow\nreturn 1")).toMatchObject({ closed: false });
    // pi-subagents requires exactly "js workflow" / "javascript workflow".
    expect(parseWorkflowFence("```js\nreturn 1\n```")).toBeNull();
    expect(parseWorkflowFence("```js  workflow\nreturn 1\n```")).toBeNull();
    expect(parseWorkflowFence("~~~js workflow\nreturn 1\n~~~")).toBeNull();
    // A workflow fence quoted inside another fence is documentation.
    expect(workflowScriptsIn("````md\n```js workflow\nreturn 0\n```\n````\n" + reply)).toEqual([script]);
  });
});
