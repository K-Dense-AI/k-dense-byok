/**
 * Tool configuration for the agent sessions.
 *
 * Sub-agent delegation is provided by the `pi-subagents` package (registered
 * as the `subagent` extension tool — see subagent-bridge.ts), and MCP tools
 * come from the per-project bridge in mcp.ts.
 */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
