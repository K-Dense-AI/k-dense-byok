import * as assert from "node:assert/strict";
import {
  createWorkspaceCapabilityDeniedMessage,
  ensureWorkspaceCapability,
  getCurrentWorkspaceTrustState,
  runWorkspaceCapabilityAction,
  type WorkspaceTrustDependencies,
} from "../../src/host/workspace-trust";

suite("workspace trust capability policy", () => {
  test("trusted mode enables the full capability matrix", () => {
    const trustState = getCurrentWorkspaceTrustState(createDependencies(true));

    assert.equal(trustState.mode, "trusted");
    assert.equal(trustState.capabilities.readOnlyUi, true);
    assert.equal(trustState.capabilities.previewOpen, true);
    assert.equal(trustState.capabilities.write, true);
    assert.equal(trustState.capabilities.execute, true);
    assert.equal(trustState.capabilities.backendStart, true);
    assert.equal(trustState.capabilities.secretSensitive, true);
  });

  test("restricted mode denies dangerous capabilities without side effects", async () => {
    const warnings: string[] = [];
    let actionRuns = 0;
    const dependencies = createDependencies(false, warnings);

    const result = await runWorkspaceCapabilityAction({
      capability: "execute",
      dependencies,
      action: async () => {
        actionRuns += 1;
        return "ran";
      },
    });

    assert.equal(result, false);
    assert.equal(actionRuns, 0);
    assert.deepEqual(warnings, [
      createWorkspaceCapabilityDeniedMessage("execute"),
    ]);
  });

  test("restricted mode still permits explicit preview open actions", async () => {
    const warnings: string[] = [];
    let actionRuns = 0;

    const result = await runWorkspaceCapabilityAction({
      capability: "previewOpen",
      dependencies: createDependencies(false, warnings),
      action: () => {
        actionRuns += 1;
        return true;
      },
    });

    assert.equal(result, true);
    assert.equal(actionRuns, 1);
    assert.deepEqual(warnings, []);
  });

  test("restricted mode denies write, backend start, and secret-sensitive capabilities", async () => {
    const warnings: string[] = [];
    const dependencies = createDependencies(false, warnings);

    assert.equal(await ensureWorkspaceCapability("write", dependencies), false);
    assert.equal(await ensureWorkspaceCapability("backendStart", dependencies), false);
    assert.equal(await ensureWorkspaceCapability("secretSensitive", dependencies), false);

    assert.deepEqual(warnings, [
      createWorkspaceCapabilityDeniedMessage("write"),
      createWorkspaceCapabilityDeniedMessage("backendStart"),
      createWorkspaceCapabilityDeniedMessage("secretSensitive"),
    ]);
  });
});

function createDependencies(
  isTrusted: boolean,
  warnings: string[] = [],
): WorkspaceTrustDependencies {
  return {
    isWorkspaceTrusted: () => isTrusted,
    showWarningMessage: async (message) => {
      warnings.push(message);
    },
  };
}
