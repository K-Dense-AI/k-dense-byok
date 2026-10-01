#!/usr/bin/env node
// Minimal stdio MCP server for tests: newline-delimited JSON-RPC with one
// `echo` tool and one `add` tool. No dependencies, so tests can run it with
// `process.execPath` wherever Node runs.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Echo the given text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function handle(request) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-test", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call": {
      const { name, arguments: args = {} } = request.params ?? {};
      if (name === "echo") return { content: [{ type: "text", text: `echo: ${args.text}` }] };
      if (name === "add") return { content: [{ type: "text", text: String(args.a + args.b) }] };
      throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
    }
    default:
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return; // notifications (e.g. notifications/initialized)
  try {
    send({ id: request.id, result: handle(request) });
  } catch (err) {
    send({ id: request.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});
