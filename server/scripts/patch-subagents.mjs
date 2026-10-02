/** Minimal host seams for the exact pinned plugin. Fail on upstream drift.
 * Never patch the SDK or change behavior outside a Kady-hosted process. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
export function patchSubagents() {
  const root = path.dirname(require.resolve('pi-subagents'));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (version !== '0.74.0') throw new Error(`Review Kady subagent host seams before using pi-subagents ${version}`);
  const patches = [
    ['src/runs/background/scheduled-runs.js', 'function scheduleBelongsToSession(schedule, ctx) {', `// KADY_HOST_SCHEDULE_OWNER_V1: project timers belong to the durable resident.
// Explicit session-only schedules retain Pi's original ownership semantics.
function kadyScheduleTimerOwner(schedule, ctx) {
    if (!process.env.KADY_SUBAGENT_HOST_MODULE || schedule.sessionOnly === true) return true;
    try {
        const state = JSON.parse(fs.readFileSync(path.join(schedule.cwd, ".kady", "scheduler.json"), "utf8"));
        return state.sessionId === ctx.sessionManager.getSessionId();
    } catch { return false; }
}
function scheduleBelongsToSession(schedule, ctx) {`, 'KADY_HOST_SCHEDULE_OWNER_V1'],
    ['src/runs/background/scheduled-runs.js', '    observedCompletionRunIds() {', `    // KADY_HOST_SCHEDULE_REFRESH_V1: called after a host-owned store mutation.
    kadyRefresh() {
        this.stopTimers();
        for (const store of this.stores.values()) this.restore(store);
    }
    observedCompletionRunIds() {`, 'KADY_HOST_SCHEDULE_REFRESH_V1'],
    ['src/runs/background/scheduled-runs.js', '    arm(schedule, store, notBefore) {', `    arm(schedule, store, notBefore) {
        // KADY_HOST_SCHEDULE_ARM_V1: chats never race the resident's timer.
        if (!kadyScheduleTimerOwner(schedule, this.requireContext(store))) return;`, 'KADY_HOST_SCHEDULE_ARM_V1'],
    ['src/runs/background/scheduled-runs.js', '    restoreOne(store, schedule, notBefore, rearm = true) {', `    restoreOne(store, schedule, notBefore, rearm = true) {
        // KADY_HOST_SCHEDULE_RESTORE_V1: only the owner advances missed runs.
        if (!kadyScheduleTimerOwner(schedule, this.requireContext(store))) return;`, 'KADY_HOST_SCHEDULE_RESTORE_V1'],
    ['src/runs/background/scheduled-runs.js', '        if (planned === undefined || schedule.paused)', `        // KADY_HOST_SCHEDULE_FIRE_V1: ownership may have changed since arming.
        if (planned === undefined || schedule.paused || !kadyScheduleTimerOwner(schedule, this.requireContext(store)))`, 'KADY_HOST_SCHEDULE_FIRE_V1'],
    ['src/extension/index.js', `        if (!ctx.hasUI)
            await drainOutstandingWork({ state, events: pi.events, hasPendingSupervisorRequest: supervisorChannel.hasPendingRequests });`, `        // KADY_HOST_NO_DRAIN_V1: Kady chat sessions are headless only to Pi. The
        // backend outlives the turn and adopts completion notices as system runs,
        // so draining here would keep the user's run open until all work ends.
        if (!ctx.hasUI && !(process.env.KADY_SUBAGENT_HOST_MODULE && globalThis.__kadyInteractiveSessions?.has(state.currentSessionId)))
            await drainOutstandingWork({ state, events: pi.events, hasPendingSupervisorRequest: supervisorChannel.hasPendingRequests });`, 'KADY_HOST_NO_DRAIN_V1'],
    ['src/extension/index.js', '    let refreshResultDelivery = () => { };', `    // KADY_HOST_SCHEDULE_EVENT_V1: scoped to this extension/session event bus.
    if (process.env.KADY_SUBAGENT_HOST_MODULE) {
        const off = pi.events.on("kady:schedules:refresh", () => scheduledRunManager.kadyRefresh());
        pi.on("session_shutdown", () => off());
    }
    let refreshResultDelivery = () => { };`, 'KADY_HOST_SCHEDULE_EVENT_V1'],
    ['src/watchdog/change-signature.js', '    const skipUntracked = isHomeRepoRoot(root) || hasTrackedEntries(root) === false;', `    // KADY_HOST_WATCHDOG_SCOPE_V1: a sandbox must not inherit the app checkout.
    // No sandbox Git root means observed write/edit events trigger review instead.
    if (process.env.KADY_SUBAGENT_HOST_MODULE && comparablePath(root) !== comparablePath(cwd))
        return undefined;
    const skipUntracked = isHomeRepoRoot(root) || hasTrackedEntries(root) === false;`, 'KADY_HOST_WATCHDOG_SCOPE_V1'],
    ['src/watchdog/diff-tool.js', 'import * as path from "node:path";', `import * as path from "node:path";
import * as fs from "node:fs"; // KADY_HOST_WATCHDOG_DIFF_IMPORT_V1`, 'KADY_HOST_WATCHDOG_DIFF_IMPORT_V1'],
    ['src/watchdog/diff-tool.js', '/** HEAD at reviewer launch, for tools that must be registered synchronously. */', `// KADY_HOST_WATCHDOG_DIFF_SCOPE_V2: do not expose an ancestor checkout's diff.
function kadyScopedBaseline(cwd, baseline) {
    if (!baseline || !process.env.KADY_SUBAGENT_HOST_MODULE) return baseline;
    // Native realpath expands Windows 8.3 short names (RUNNER~1) that Git never reports.
    try { return path.relative(fs.realpathSync.native(baseline.root), fs.realpathSync.native(cwd)) === "" ? baseline : undefined; }
    catch { return undefined; }
}
/** HEAD at reviewer launch, for tools that must be registered synchronously. */`, 'KADY_HOST_WATCHDOG_DIFF_SCOPE_V2', `// KADY_HOST_WATCHDOG_DIFF_SCOPE_V2: do not expose an ancestor checkout's diff.
function kadyScopedBaseline(cwd, baseline) {
    if (!baseline || !process.env.KADY_SUBAGENT_HOST_MODULE) return baseline;
    try { return fs.realpathSync(baseline.root) === fs.realpathSync(cwd) ? baseline : undefined; }
    catch { return undefined; }
}
/** HEAD at reviewer launch, for tools that must be registered synchronously. */`],
    ['src/watchdog/diff-tool.js', '    return result.ok ? parseBaseline(result.stdout) : undefined;', '    return result.ok ? kadyScopedBaseline(cwd, parseBaseline(result.stdout)) : undefined; // KADY_HOST_WATCHDOG_DIFF_SYNC_V1', 'KADY_HOST_WATCHDOG_DIFF_SYNC_V1'],
    ['src/watchdog/diff-tool.js', '            resolve(error ? undefined : parseBaseline(stdout));', '            resolve(error ? undefined : kadyScopedBaseline(cwd, parseBaseline(stdout))); // KADY_HOST_WATCHDOG_DIFF_ASYNC_V1', 'KADY_HOST_WATCHDOG_DIFF_ASYNC_V1'],
    ['src/runs/background/scheduled-runs.js', 'function sanitizeTarget(params) {', `// KADY_HOST_SCHEDULE_MODEL_V1: schedule targets must retain the host-pinned model.
function kadyScheduleModel(value) {
    if (!process.env.KADY_SUBAGENT_HOST_MODULE || value === undefined) return {};
    if (typeof value !== "string" || !value.trim() || value.length > 512)
        throw new Error("Scheduled model must be a non-empty model reference.");
    return { model: value.trim() };
}
function sanitizeTarget(params) {`, 'KADY_HOST_SCHEDULE_MODEL_V1'],
    ['src/runs/background/scheduled-runs.js', 'return { target: { workflowScript: params.workflowScript.trim(), args: deepFreezeWorkflowArgs(normalizedArgs.args), ...(baseRef === undefined ? {} : { baseRef }) } };', 'return { target: { workflowScript: params.workflowScript.trim(), args: deepFreezeWorkflowArgs(normalizedArgs.args), ...(baseRef === undefined ? {} : { baseRef }), ...kadyScheduleModel(params.model) } }; // KADY_HOST_SCHEDULE_MODEL_SAVE_V1', 'KADY_HOST_SCHEDULE_MODEL_SAVE_V1'],
    ['src/runs/background/scheduled-runs.js', 'return { workflowScript: target.workflowScript.trim(), args: deepFreezeWorkflowArgs(normalizedArgs.args), ...(baseRef === undefined ? {} : { baseRef }) };', 'return { workflowScript: target.workflowScript.trim(), args: deepFreezeWorkflowArgs(normalizedArgs.args), ...(baseRef === undefined ? {} : { baseRef }), ...kadyScheduleModel(target.model) }; // KADY_HOST_SCHEDULE_MODEL_READ_V1', 'KADY_HOST_SCHEDULE_MODEL_READ_V1'],
    ['src/runs/background/scheduled-runs.js', 'export const SCHEDULED_RUN_ACTIONS = [', `// KADY_HOST_SCHEDULE_IMPORT_V1
import { parseSubagentCapabilityCeiling, registerSubagentCapabilityCeiling } from "../shared/capability-ceiling.js";
export const SCHEDULED_RUN_ACTIONS = [`, 'KADY_HOST_SCHEDULE_IMPORT_V1'],
    ['src/runs/background/scheduled-runs.js', `        if (this.deps.resolveCapabilityCeiling?.(sessionId))
            return textResult("Cannot persist a schedule while a capability ceiling is active.", undefined, undefined, true);`, `        // KADY_HOST_SCHEDULE_CAPTURE_V1: only Kady's persistent host policy is schedulable.
        // Other hosts and temporary/restricted-session ceilings still fail closed.
        const activeCeiling = this.deps.resolveCapabilityCeiling?.(sessionId);
        let kadyCapabilityCeiling;
        if (activeCeiling) {
            if (!process.env.KADY_SUBAGENT_HOST_MODULE || activeCeiling.sources.length !== 1 || activeCeiling.sources[0] !== "kady-parent-tools")
                return textResult("Cannot persist a schedule while a capability ceiling is active.", undefined, undefined, true);
            kadyCapabilityCeiling = parseSubagentCapabilityCeiling(activeCeiling);
        }`, 'KADY_HOST_SCHEDULE_CAPTURE_V1'],
    ['src/runs/background/scheduled-runs.js', '            target: target.target,', `            target: target.target,
            // KADY_HOST_SCHEDULE_RECORD_V1: retain restrictions across restart.
            ...(kadyCapabilityCeiling ? { kadyCapabilityCeiling } : {}),`, 'KADY_HOST_SCHEDULE_RECORD_V1'],
    ['src/runs/background/scheduled-runs.js', '            const result = await this.deps.launch(executionParams(schedule, dueReason === "manual" ? quiet === true : schedule.quiet === true), this.requireContext(store), new AbortController().signal);', `            // KADY_HOST_SCHEDULE_LAUNCH_V1: intersect the saved ceiling with the
            // resident session policy for every launch; never run outside Kady.
            const context = this.requireContext(store);
            const ownerId = context.sessionManager.getSessionId();
            let savedCeiling;
            if (schedule.kadyCapabilityCeiling !== undefined) {
                const current = this.deps.resolveCapabilityCeiling?.(ownerId);
                if (!process.env.KADY_SUBAGENT_HOST_MODULE || !current?.sources.includes("kady-parent-tools"))
                    throw new Error("This schedule requires the Kady host capability policy.");
                savedCeiling = registerSubagentCapabilityCeiling({ sessionId: ownerId, source: "kady-schedule-snapshot", ceiling: parseSubagentCapabilityCeiling(schedule.kadyCapabilityCeiling) });
            }
            let result;
            try {
                result = await this.deps.launch(executionParams(schedule, dueReason === "manual" ? quiet === true : schedule.quiet === true), context, new AbortController().signal);
            } finally {
                savedCeiling?.dispose();
            }`, 'KADY_HOST_SCHEDULE_LAUNCH_V1'],
    ['src/runs/shared/async-status-projection.js', '        const stepChildren = steps.map((step, index) => projectLane(step, step.index ?? index)).filter((child) => child !== undefined);', `        // KADY_HOST_TARGET_V1: preserve authoritative control targets through bounded/reordered UI projection.
        const stepChildren = steps.map((step, index) => {
            const child = projectLane(step, step.index ?? index);
            return child ? { ...child, control: { runId: job.asyncId, index, childId: step.childId || step.workflowKey || step.runId || \`step:\${index}\` } } : undefined;
        }).filter((child) => child !== undefined);`, 'KADY_HOST_TARGET_V1'],
    ['src/runs/shared/child-session.js', '                pinChildCacheRetention(session.agent);', `                pinChildCacheRetention(session.agent);
                // KADY_HOST_CHILD_V1: the host gates the resolved model before every request.
                if (process.env.KADY_SUBAGENT_HOST_MODULE) {
                    const host = await import(process.env.KADY_SUBAGENT_HOST_MODULE);
                    host.attachChildSession(session, launch, modelRuntime);
                }`, 'KADY_HOST_CHILD_V1'],
    ['src/watchdog/review.js', '    const baseStreamFn = options.streamFn ?? ((model, context, streamOptions) => ctx.modelRegistry.streamSimple(model, context, streamOptions));', `    let baseStreamFn = options.streamFn ?? ((model, context, streamOptions) => ctx.modelRegistry.streamSimple(model, context, streamOptions));
    // KADY_HOST_WATCHDOG_V1: includes clean, failed and aborted reviews.
    if (process.env.KADY_SUBAGENT_HOST_MODULE) {
        const host = await import(process.env.KADY_SUBAGENT_HOST_MODULE);
        baseStreamFn = host.watchdogStream(ctx, baseStreamFn);
    }`, 'KADY_HOST_WATCHDOG_V1'],
    ['src/watchdog/permission-arbiter.js', '                const baseStreamFn = options.streamFn ?? ((model, context, streamOptions) => request.ctx.modelRegistry.streamSimple(model, context, streamOptions));', `                let baseStreamFn = options.streamFn ?? ((model, context, streamOptions) => request.ctx.modelRegistry.streamSimple(model, context, streamOptions));
                // KADY_HOST_ARBITER_V1: permission reviews use the same admission and accounting.
                if (process.env.KADY_SUBAGENT_HOST_MODULE) {
                    const host = await import(process.env.KADY_SUBAGENT_HOST_MODULE);
                    baseStreamFn = host.watchdogStream(request.ctx, baseStreamFn);
                }`, 'KADY_HOST_ARBITER_V1'],
    ['src/runs/background/runner-aliases.js', `        if (target && fs.existsSync(target))
            aliases[specifier] = fs.realpathSync(target);
        else
            missing.push(specifier);`, `        if (target && fs.existsSync(target))
            aliases[specifier] = fs.realpathSync(target);
        // KADY_HOST_CORE_NODE_ALIAS_V1: Pi 1.0 removed pi-agent-core's "./node"
        // export and nothing in the runner graph imports it, so requiring the
        // alias refused every background launch. Skip it only when the package
        // no longer declares it; a declared but missing target is still broken.
        else if (process.env.KADY_SUBAGENT_HOST_MODULE && specifier === "@earendil-works/pi-agent-core/node" && packageDir && !Object.hasOwn(readManifest(packageDir)?.exports ?? {}, subpath))
            continue;
        else
            missing.push(specifier);`, 'KADY_HOST_CORE_NODE_ALIAS_V1'],
  ];
  // Check all anchors before mutating any file.
  const writes = patches.map(([file, before, after, marker, previous]) => {
    const target = path.join(root, file);
    const text = fs.readFileSync(target, 'utf8');
    if (text.includes(marker)) {
      if (text.includes(after)) return null;
      // Upgrade an exact older host seam without accepting local modifications.
      if (!previous || text.split(previous).length !== 2) throw new Error(`Modified Kady adapter in ${file}`);
      return { target, before: previous, after };
    }
    if (text.split(before).length !== 2) throw new Error(`Subagent compatibility anchor changed: ${file}`);
    return { target, before, after };
  });
  // Several independent seams can share a file. Compose their replacements
  // instead of letting the last write discard earlier changes.
  const composed = new Map();
  for (let i = 0; i < patches.length; i++) {
    const write = writes[i];
    if (!write) continue;
    const current = composed.get(write.target) ?? fs.readFileSync(write.target, 'utf8');
    composed.set(write.target, current.replace(write.before, write.after));
  }
  for (const [target, text] of composed) fs.writeFileSync(target, text);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) patchSubagents();
