import * as assert from "node:assert/strict";
import {
  buildComputeContext,
  buildDatabaseContext,
  buildSkillsContext,
  COMPUTE_INSTANCES,
  createSidebarChatRequest,
  DATABASES,
  DEFAULT_MODEL,
  type Skill,
} from "../../src/webview/chat-controls";
import { createSidebarChatSendPayload as createPayload } from "../../src/webview/sidebar-action-payloads";
import { assembleWorkflowPrompt, WORKFLOWS } from "../../src/webview/workflows-panel";

suite("sidebar chat controls", () => {
  test("ports the same prompt augmentation pattern as the web chat", () => {
    const selectedDatabases = DATABASES.slice(0, 2);
    const selectedCompute = COMPUTE_INSTANCES.find((instance) => instance.id === "t4") ?? null;
    const selectedSkills: Skill[] = [
      {
        id: "peer-review",
        name: "Peer Review",
        description: "Review manuscripts critically",
        author: "K-Dense",
        license: "MIT",
        compatibility: "built-in",
      },
    ];

    const request = createSidebarChatRequest({
      prompt: "Summarize the attached experiment",
      modelId: DEFAULT_MODEL.id,
      selectedDatabases,
      selectedCompute,
      selectedSkills,
    });

    assert.deepEqual(request, {
      text:
        "Summarize the attached experiment" +
        buildDatabaseContext(selectedDatabases) +
        buildComputeContext(selectedCompute) +
        buildSkillsContext(selectedSkills),
      modelId: DEFAULT_MODEL.id,
    });
  });

  test("workflow launch assembles placeholders and routes into normal sidebar send shape", () => {
    const workflow = WORKFLOWS.find((item) => item.id === "write-paper");
    assert.ok(workflow);

    const prompt = assembleWorkflowPrompt(workflow!, { topic: "Mitochondrial dynamics" });
    const request = createSidebarChatRequest({
      prompt,
      modelId: DEFAULT_MODEL.id,
      selectedDatabases: [],
      selectedCompute: null,
      selectedSkills: [
        {
          id: "scientific-writing",
          name: "Scientific Writing",
          description: "Write manuscripts",
          author: "K-Dense",
          license: "MIT",
          compatibility: "built-in",
        },
      ],
    });

    assert.match(request.text, /Mitochondrial dynamics/);
    assert.match(request.text, /Make sure to instruct the delegated expert to use the skills/);
    assert.equal(request.modelId, DEFAULT_MODEL.id);
  });

  test("includes the selected model and workspace target in sidebar send payloads", () => {
    assert.deepEqual(
      createPayload(
        "Summarize the workspace",
        "file:///workspace-a",
        DEFAULT_MODEL.id,
      ),
      {
        surface: "sidebar",
        text: "Summarize the workspace",
        workspaceTargetId: "file:///workspace-a",
        modelId: DEFAULT_MODEL.id,
      },
    );
  });
});
