/**
 * Tool configuration for the lead agent session.
 *
 * Sub-agent delegation is provided by the `pi-subagents` package (registered
 * as the `subagent` extension tool — see subagent-bridge.ts), web tools by
 * the `pi-web-access` package (see web-access-bridge.ts), and MCP tools by
 * Pi's own MCP extension (see mcp.ts), which registers `mcp__<server>__<tool>`
 * tools only once a server connects.
 *
 * That last point is why the lead uses a denylist rather than an allowlist:
 * Pi drops every tool an allowlist does not name from the registry (codemode
 * scripts cannot reach it either), and MCP tool names are not known when the
 * session is built.
 */

/**
 * Built-in tools the lead starts with. Pi's default selection is only
 * read/bash/edit/write; the `+name` form adds to whatever the user's
 * `defaultTools` setting resolves to instead of replacing it.
 */
export const LEAD_DEFAULT_TOOLS = ["+grep", "+find", "+ls"];

/**
 * Registered tools the lead must never see. Both are lazy loaders that would
 * otherwise hide their package's real tools until the model called them; with
 * the loader excluded, each package keeps its tools active from the start.
 */
export const LEAD_EXCLUDED_TOOLS = ["subagents_enable", "web_enable"];
