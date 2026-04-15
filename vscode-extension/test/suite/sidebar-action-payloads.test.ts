import * as assert from "node:assert/strict";
import {
  createSidebarBackendActionPayload,
  createSidebarChatSendPayload,
} from "../../src/webview/sidebar-action-payloads";

suite("sidebar action payloads", () => {
  test("includes the selected workspace target in execute-class sidebar payloads", () => {
    assert.deepEqual(
      createSidebarChatSendPayload("Summarize this workspace", "file:///workspace-b", "model-123"),
      {
        surface: "sidebar",
        text: "Summarize this workspace",
        workspaceTargetId: "file:///workspace-b",
        modelId: "model-123",
      },
    );

    assert.deepEqual(
      createSidebarBackendActionPayload("start", "file:///workspace-b"),
      {
        surface: "sidebar",
        action: "start",
        workspaceTargetId: "file:///workspace-b",
      },
    );
  });

  test("keeps non-execute refresh payloads untargeted", () => {
    assert.deepEqual(createSidebarBackendActionPayload("refresh"), {
      surface: "sidebar",
      action: "refresh",
      workspaceTargetId: undefined,
    });
  });
});
