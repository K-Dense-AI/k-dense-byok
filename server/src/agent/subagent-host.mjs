/** Runs in both the backend and detached Pi runner. No shared process identity:
 * owner/model/auth are captured per session and per request. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// Keep fetch and its explicit dispatcher on the same undici implementation.
// Node 22/24's built-in fetch uses an older handler contract than undici 8.
import { Agent, fetch } from 'undici';
const direct = new Agent();
let localMeter;
const childOwners = new Map();
export function setHostMeter(handler) { localMeter = handler; }
function projectOwner(cwd) {
  for (let dir = path.resolve(cwd);;) {
    if (path.basename(dir) === 'sandbox') {
      const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'project.json'), 'utf8'));
      if (meta.id !== path.basename(path.dirname(dir))) throw new Error('Invalid child project identity');
      return { projectId: meta.id, sandbox: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Subagent launch must remain in a Kady project sandbox');
    dir = parent;
  }
}
async function meter(action, input) {
  if (localMeter) return localMeter(action, input);
  const url = new URL(process.env.KADY_INTERNAL_URL || `http://127.0.0.1:${process.env.KADY_PORT || process.env.PORT || 8000}`);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Invalid Kady internal URL');
  url.pathname = `/subagents/meter/${action}`;
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', dispatcher: direct,
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-Project-Id': input.projectId,
      ...(process.env.KADY_AUTH_TOKEN ? { 'X-Kady-Token': process.env.KADY_AUTH_TOKEN } : {}) },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || 'Subagent accounting unavailable');
  return result;
}
function persistUsage(request) {
  if (!request.sandbox) return undefined;
  const dir = path.join(request.sandbox, '.kady', 'subagent-usage-pending');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${request.requestId}.json`), tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(request)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return file;
}
export function meteredStream(base, owner, usingOAuth) {
  return async (model, context, options) => {
    const request = { ...owner, requestId: randomUUID(), provider: model.provider, model: model.id,
      authType: usingOAuth(model) ? 'oauth' : 'api_key' };
    await meter('admit', request);
    const stream = await base(model, context, options);
    // Meter before exposing the terminal event, so the next request and the
    // parent's completion cannot race ahead of accounting. Never consume twice.
    let settled;
    const settle = (message) => settled ??= (async () => {
      const usage = { ...request, usage: message?.usage };
      const pending = persistUsage(usage);
      await meter('usage', usage);
      if (pending) fs.rmSync(pending, { force: true });
    })();
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of stream) {
          if (event.type === 'done' || event.type === 'error') await settle(event.message || event.error);
          yield event;
        }
      },
      async result() { const message = await stream.result(); await settle(message); return message; },
    };
  };
}
export function attachChildSession(session, launch, runtime) {
  const parentId = launch.runtime.orchestratorSessionId || launch.runtime.parentSessionId || session.sessionId;
  const owner = { ...projectOwner(launch.cwd), sessionId: childOwners.get(parentId)?.sessionId || parentId,
    childSessionId: session.sessionId, sessionFile: session.sessionFile, kind: 'subagent', runId: launch.runtime.runId };
  childOwners.set(session.sessionId, owner);
  const dispose = session.dispose.bind(session);
  session.dispose = () => { childOwners.delete(session.sessionId); return dispose(); };
  session.agent.streamFunction = meteredStream(session.agent.streamFunction.bind(session.agent), owner, model => runtime.isUsingOAuth(model.provider));
}
export function watchdogStream(ctx, base) {
  const sessionId = ctx.sessionManager.getSessionId();
  return meteredStream(base, { ...projectOwner(ctx.cwd), sessionId, ...childOwners.get(sessionId), kind: 'watchdog' },
    model => ctx.modelRegistry.isUsingOAuth(model));
}
