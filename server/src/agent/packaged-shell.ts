import { createBashToolDefinition, getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Use the installer's private Git Bash directly in both lead and child sessions.
 * Avoid Pi's `where.exe` discovery and its code-page-sensitive output when the
 * Windows installation path contains Unicode characters. A `shellPath` the user
 * configured in Pi settings still wins, and `shellCommandPrefix` still applies.
 */
function packagedShellPath(): string | undefined {
  const shellPath = process.env.KADY_BASH_PATH;
  return process.env.KADY_PACKAGED === "1" && shellPath ? shellPath : undefined;
}

/** Lead sessions: set Pi's own `shellPath` so Pi builds every shell (the bash
 * tool and user `!` commands) with its normal settings. Call after
 * `resourceLoader.reload()`, which drops overrides. */
export function applyPackagedShell(settings: Pick<SettingsManager, "getShellPath" | "applyOverrides">): void {
  const shellPath = packagedShellPath();
  if (shellPath && !settings.getShellPath()) settings.applyOverrides({ shellPath });
}

/** Child `pi` processes expose no settings handle to extensions, so replace
 * the built-in tool with the same definition Pi would build: its settings'
 * command prefix plus the private shell. The native definition keeps Pi's tool
 * hooks and cancellation. */
export function registerPackagedShell(
  pi: Pick<ExtensionAPI, "registerTool">,
  settings: Pick<SettingsManager, "getShellPath" | "getShellCommandPrefix"> = SettingsManager.create(process.cwd(), getAgentDir()),
): void {
  const shellPath = packagedShellPath();
  if (!shellPath || settings.getShellPath()) return;
  pi.registerTool(createBashToolDefinition(process.cwd(), { shellPath, commandPrefix: settings.getShellCommandPrefix() }));
}
