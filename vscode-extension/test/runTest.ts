import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");
    const workspacePath = path.resolve(
      extensionDevelopmentPath,
      "test/fixtures/test-workspace.code-workspace",
    );

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath, "--disable-extensions", "--disable-gpu"],
    });
  } catch (error) {
    console.error("Failed to run extension tests", error);
    process.exit(1);
  }
}

void main();
