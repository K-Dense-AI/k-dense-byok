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
  if (version !== '0.73.1') throw new Error(`Review Kady subagent host seams before using pi-subagents ${version}`);
  const patches = [
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
  ];
  // Check all anchors before mutating any file.
  const writes = patches.map(([file, before, after, marker]) => {
    const target = path.join(root, file);
    const text = fs.readFileSync(target, 'utf8');
    if (text.includes(marker)) {
      if (!text.includes(after)) throw new Error(`Modified Kady adapter in ${file}`);
      return null;
    }
    if (text.split(before).length !== 2) throw new Error(`Subagent compatibility anchor changed: ${file}`);
    return { target, text: text.replace(before, after) };
  });
  for (const write of writes) if (write) fs.writeFileSync(write.target, write.text);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) patchSubagents();
