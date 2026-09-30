/** Supported event-bus RPC; scope is the actual Pi session, never a global run id. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { ExtensionFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSubagentCapabilityCeiling, resolveSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";
import { modalJobManager } from "../modal/manager.ts";
import { isTerminalModalState } from "../modal/types.ts";
import { workflowScriptTargets } from "./subagent-bridge.ts";
import { webAccessPackageDir } from "./web-access-bridge.ts";
import { LEAD_DELEGATION_GUIDANCE, setSubagentPromptSection } from "./subagent-prompts.ts";

type Rec = Record<string, any>;
interface Host { rpc(method: string, params?: Rec): Promise<Rec>; preflight(input: Rec): Promise<unknown>; }
const hosts = new Map<string, Host>();
const key = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;
export function subagentHost(projectId: string, sessionId: string): Host {
  const host = hosts.get(key(projectId, sessionId));
  if (!host) throw new Error("Specialist controls are not ready for this session");
  return host;
}
export function liveSubagentSessions(projectId: string): string[] {
  return [...hosts.keys()].filter((k) => k.startsWith(projectId + ":")).map((k) => k.slice(projectId.length + 1));
}
export function makeSubagentControlExtension(projectId: string): ExtensionFactory {
  return (pi) => {
    let ctx: ExtensionContext;
    let currentSessionId: string | undefined;
    let ceiling: ReturnType<typeof registerSubagentCapabilityCeiling> | undefined;
    const disposers: Array<() => void> = [];
    const pending = new Set<() => void>();
    const policy = () => ({ allowedTools: [...new Set([
      ...pi.getAllTools().map((tool) => tool.name).filter((name) => !["interview", "subagents_enable", "web_enable", "subagent_supervisor"].includes(name)),
      "contact_supervisor", "codemode", "tool_search",
    ])] });
    const preflight = async (input: Rec) => {
      ceiling?.update(policy());
      return resolveSubagentLaunchContract({
      agent: String(input.agent), task: typeof input.task === "string" ? input.task : undefined,
      cwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(), parentLeafId: ctx.sessionManager.getLeafId(),
      parentModel: ctx.model, availableModels: ctx.modelRegistry.getAll(),
      capabilityCeiling: resolveSubagentCapabilityCeiling(ctx.sessionManager.getSessionId()),
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(input.context === "fork" || input.context === "fresh" ? { context: input.context } : {}),
      });
    };
    const rpc = (method: string, params: Rec = {}): Promise<Rec> => new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const event = `subagents:rpc:v1:reply:${requestId}`;
      const cleanup = () => { clearTimeout(timer); off(); pending.delete(cancel); };
      const cancel = () => { cleanup(); reject(new Error("Specialist session closed")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Specialist control request timed out")); }, 20_000);
      const off = pi.events.on(event, (raw: unknown) => {
        const reply = raw as Rec;
        cleanup();
        if (reply.success) resolve(reply.data);
        else reject(new Error(reply.error?.message || "Specialist control failed"));
      });
      pending.add(cancel);
      pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params, source: { extension: "kady" } });
    });
    pi.on("session_start", (_event, context) => {
      ctx = context;
      const sessionId = ctx.sessionManager.getSessionId();
      currentSessionId = sessionId;
      ceiling = registerSubagentCapabilityCeiling({ sessionId, source: "kady-parent-tools", ceiling: policy() });
      disposers.push(() => ceiling?.dispose());
      const packages = path.resolve(import.meta.dirname, "../../pi-packages");
      const webEntry = path.resolve(webAccessPackageDir(), JSON.parse(fs.readFileSync(path.join(webAccessPackageDir(), "package.json"), "utf8")).pi.extensions[0]);
      const required = registerRequiredChildExtensions({ sessionId, extensions: [
        ...["kady-guard", "kady-notebook", "kady-modal", "kady-pdf-annotations", "kady-child-runtime"].map((id) => ({ id, path: path.join(packages, id, "index.ts") })),
        { id: "pi-web-access", path: fs.statSync(webEntry).isDirectory() ? path.join(webEntry, "index.js") : webEntry },
      ] });
      disposers.push(() => required.dispose());
      disposers.push(registerBackgroundWorkProvider({ name: `kady-modal:${projectId}:${sessionId}`,
        listActiveWork(context) {
          if (context?.sessionId !== sessionId) return [];
          return modalJobManager.list(projectId, { sessionId }).filter((job) => !isTerminalModalState(job.state)).map((job) => ({ id: `modal:${job.id}`, sessionId }));
        },
      }));
      hosts.set(key(projectId, sessionId), { rpc, preflight });
    });
    pi.on("before_agent_start", (event) => {
      ceiling?.update(policy());
      setSubagentPromptSection(event, "kady_delegation", LEAD_DELEGATION_GUIDANCE);
    });
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "subagent" || event.input.action || !ctx) return;
      ceiling?.update(policy());
      const targets = typeof event.input.workflowScript === "string" ? workflowScriptTargets(event.input.workflowScript) : undefined;
      // Public preflight supplies early, readable configuration failures. Actual
      // provider admission remains authoritative for computed/file workflows.
      if (targets && !targets.dynamic && targets.models.size === 0) {
        for (const agent of targets.agents) {
          const result = await preflight({ agent, model: event.input.model });
          if (!result.ok) return { block: true, reason: result.message };
        }
      }
    });
    pi.on("session_shutdown", () => {
      if (currentSessionId) hosts.delete(key(projectId, currentSessionId));
      for (const cancel of pending) cancel();
      disposers.splice(0).forEach((dispose) => dispose());
    });
  };
}
