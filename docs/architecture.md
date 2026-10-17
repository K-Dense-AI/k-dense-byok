# Architecture

K-Dense BYOK runs two services on the backend host, launched by `start.mjs`
through `kady` on macOS/Linux or `kady.cmd` on Windows. `start.sh` and
`start.cmd` remain compatibility aliases:

| Service | Default port | Responsibility |
|---|---|---|
| Next.js / React frontend (`web/`) | 3000 | Project workspace, chat, editors and previews |
| Fastify / TypeScript backend (`server/`) | 8000 | Pi sessions, tools, files, accounting and compute |

The backend embeds one Pi lead agent per session. It can delegate native Pi
specialists, use web/MCP tools and submit durable Modal jobs. Model requests go
directly to the configured provider. See [model access](model-selection.md) and
[the security boundary](security.md).

## Turn lifecycle

1. A chat request supplies a session ID and project scope (`X-Project-Id`).
2. The backend claims the session, resolves its model and starts a run.
3. Pi events feed a server-owned run broker, the browser's SSE stream and the provenance recorder.
4. Tool calls operate on the shared project sandbox. Child agents report usage and completion through the backend.
5. The run drains provenance work, records cost and publishes terminal frames.

A permanent session observer adopts extension-triggered turns as system runs
through the same pipeline. Idle tabs discover and attach to them. Custom
messages without a turn are published as notices.

The broker survives browser disconnects, not backend restarts. Completed history
is durable; active ordinary turns end on restart. Modal jobs have their own
persistent lifecycle and [recovery](modal-compute.md#lifecycle-and-recovery).

## Session and project ownership

Each project supports up to ten chat tabs. A tab owns its history, model and run;
all project tabs share files, notebook view, cost cap and compute jobs. Closing
an in-app chat tab aborts its turn. Browser refresh only detaches/reconnects.

Settings changes that affect loaded tools, skills and specialist definitions
apply to new sessions. A resident automation session keeps project schedules
active while the server runs. Shared provider credentials are outside projects.

## Storage

```text
projects/
  index.json
  <projectId>/
    project.json
    sandbox/
      user_data/                         uploads
      .pi/sessions/                      Pi conversation JSONL
      .pi/skills/                        enabled project skills
      .pi/agents/                        specialist definitions
      .pi/prompts/                       prompt templates
      .pi/mcp.json                       project connectors
      .kady/runs/<sessionId>/costs.jsonl  usage ledger
      .kady/notebook/                     entries, annotations and reviewed plans
      .kady/provenance/                   observed tool steps
      .kady/environments/                 environment snapshots
      .kady/evidence/                     reviewer packages and retained versions
      .kady/modal/                        jobs, logs and verified output staging
```

`KADY_PROJECTS_ROOT` relocates projects. The shared Pi directory defaults to
`~/.kady/pi-agent/` and holds auth, global skills/prompts/connectors and defaults.
`KADY_PI_AGENT_DIR` relocates it; explicit `PI_CODING_AGENT_DIR` takes precedence.
Keys saved through Settings live in the repo-root `.env`.

## Source map

| Area | Entry points |
|---|---|
| Server and scope | [`index.ts`](../server/src/index.ts), [`scope.ts`](../server/src/scope.ts), [`projects.ts`](../server/src/projects.ts) |
| Agent lifecycle | [`session-registry.ts`](../server/src/agent/session-registry.ts), [`run-pipeline.ts`](../server/src/agent/run-pipeline.ts), [`session-observer.ts`](../server/src/agent/session-observer.ts) |
| Model access and accounting | [`models.ts`](../server/src/agent/models.ts), [`provider-catalog.ts`](../server/src/agent/provider-catalog.ts), [`cost/`](../server/src/cost/) |
| Specialists and MCP | [`subagent-control.ts`](../server/src/agent/subagent-control.ts), [`kady-child-runtime`](../server/pi-packages/kady-child-runtime/), [`mcp.ts`](../server/src/agent/mcp.ts) |
| Notebook and provenance | [`notebook.ts`](../server/src/agent/notebook.ts), [`provenance/`](../server/src/provenance/), [`evidence/`](../server/src/evidence/) |
| Remote compute | [`modal-tool.ts`](../server/src/agent/modal-tool.ts), [`modal/`](../server/src/modal/) |
| File previews | [`sandbox.ts`](../server/src/api/sandbox.ts), [`helpers/`](../server/src/helpers/), [`registry.ts`](../web/src/lib/viewers/registry.ts) |
| Settings | [`settings-dialog.tsx`](../web/src/components/settings-dialog.tsx), [`settings/`](../web/src/components/settings/) |

For development commands, SDK integration constraints and release mechanics,
see [AGENTS.md](../AGENTS.md). For UI invariants, see [Performance](performance.md).
