import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Use the installer's private Git Bash directly in both lead and child sessions.
 * Avoid Pi's `where.exe` discovery and its code-page-sensitive output when the
 * Windows installation path contains Unicode characters.
 * Register the native definition so Pi's tool hooks and cancellation still apply.
 */
export function registerPackagedShell(pi: Pick<ExtensionAPI, "registerTool">): void {
  const shellPath = process.env.KADY_BASH_PATH;
  if (process.env.KADY_PACKAGED !== "1" || !shellPath) return;
  pi.registerTool(createBashToolDefinition(process.cwd(), { shellPath }));
}
