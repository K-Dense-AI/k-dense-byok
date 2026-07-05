# Capability Hub — Design Spec

**Date:** 2026-07-04
**Status:** Approved (design); pending implementation plan
**Author:** Kady / Claude Code session

## 1. Summary

Add a **Customize** modal to K-Dense BYOK: one unified, per-project surface for
browsing and enabling/disabling the three capability types the agent uses —
**Skills**, **Specialists** (subagents), and **Connectors** (MCP servers).

Today these are scattered and none has an enable/disable concept: Skills appear
only in the chat composer's per-message selector (`GET /skills`, read-only);
Specialists and Connectors are CRUD panels buried in an already-overloaded
`settings-dialog.tsx` (1028 lines). This feature consolidates all three into a
dedicated hub with non-destructive toggles, modeled on Anthropic's "Claude
Science" Customize modal.

## 2. Goals / Non-goals

**Goals (v1):**
- A single **Customize** modal with a Capabilities rail: Skills / Specialists / Connectors.
- Non-destructive, per-project **enable/disable** for each item (persists across sessions).
- Reuse the existing Specialists (`/agents`) and Connectors (`/mcp`) CRUD; add a Skills panel.
- Disabling an item hides it from the agent (and from child subagent processes) for **new** sessions.
- Move MCP + Sub-agents panels out of Settings; Settings keeps API keys / Fusion / Appearance.

**Non-goals (explicitly deferred):**
- Marketplace / "install from catalogue" of not-yet-installed skills or connectors.
- Memory / Compute / Network / Permissions / Storage / Usage panels (other Claude Science tabs).
- Authoring **new** skills from the UI (Specialists already support create/edit).
- Per-session (vs per-project) capability overrides.
- Changing the chat composer's skills selector beyond it naturally showing only enabled skills.

## 3. Core mechanism: enable/disable by relocation

Each capability type is discovered by Pi — and by child subagent `pi` processes —
from exactly one canonical location under the project sandbox. Therefore
**enable/disable is implemented by moving the item between its canonical location
and a sibling `-disabled` store.** Disabled items are simply absent from the
location the agent reads, so **session construction needs no changes** and the
behavior is robust across both the parent session and child processes.

| Type | Enabled (canonical, agent reads this) | Disabled store | `session-registry.ts` change |
|---|---|---|---|
| Skills | `sandbox/.pi/skills/<name>/` | `sandbox/.pi/skills-disabled/<name>/` | none |
| Specialists | `sandbox/.pi/agents/<name>.md` | `sandbox/.pi/agents-disabled/<name>.md` | none |
| Connectors | entry in `sandbox/.pi/mcp.json` | entry in `sandbox/.pi/mcp-disabled.json` | none |

**Why relocation instead of a `capabilities.json` disabled-set + runtime filter:**
- Skills and specialists are discovered from the filesystem by `DefaultResourceLoader`
  and by pi-subagents' child `pi` processes. A parent-only filter (e.g. the loader's
  `skillsOverride` hook) would still leak disabled skills into child subagent runs.
  Relocation hides them everywhere.
- `getMcpTools()` reads only `mcp.json`, so removing an entry from it disables the
  connector with no filter code.
- No dual source of truth: the canonical location *is* the enabled set.

**Semantics (consistent with today's agent behavior):** toggles take effect for
**new chat tabs / subagent runs**. Live in-memory sessions keep the capability set
they started with. This matches the existing note in `api/agents.ts`.

**Content preservation:** relocation is a move, never a delete. User-customized
skills/agents and connector configs (including tokens) are preserved intact.

**Seeding interaction:** `seedProjectSkills` early-returns when `.pi/skills/` already
has skills and never clobbers existing dirs, so a disabled skill sitting in
`.pi/skills-disabled/` is not re-seeded or resurrected.

### 3.1 Edge case: builtin specialists

Project specialists live as `.md` files in `.pi/agents/`, so relocation works. But
**builtin** specialists ship inside the pi-subagents package and are not files in
`.pi/agents/`, so there is nothing to move.

**v1 resolution (to finalize in the implementation plan):** prefer a small
per-project deny-list (e.g. `sandbox/.kady/disabled-builtins.json`) consulted at
session build to exclude named builtins from the roster the `subagent` tool sees —
**only if** pi-subagents supports excluding an agent by name. If it does not, v1
ships enable/disable for **project** specialists only, renders builtin rows with a
disabled/"always on" toggle state and a tooltip explaining they can be shadowed via
the existing "Customize" action (which copies a builtin into the project, where it
*can* be toggled). The plan must verify pi-subagents' capability before choosing.

## 4. UI

### 4.1 Customize modal — `web/src/components/customize-dialog.tsx` (new)

Mirrors the existing vertical-`Tabs` shell of `settings-dialog.tsx` (shadcn `Dialog`
+ `Tabs orientation="vertical" variant="line"`, left rail as sidebar, scrollable
content). Capabilities rail (icon + label):

- **Skills** — new panel (§4.2)
- **Specialists** — relocated `subagents-panel.tsx` + toggle
- **Connectors** — relocated `McpServersPanel` + toggle

Each panel is a searchable list; rows show name + description + a `Switch`. Reuses
existing primitives: `Switch`, `Tabs`, `Command`/search input, `Badge`, `Card`,
`ScrollArea`. Uses semantic theme tokens (`bg-muted`, `text-muted-foreground`,
`border`, `bg-primary`) for automatic light/dark.

### 4.2 Skills panel — `web/src/components/skills-panel.tsx` (new)

- Lists **enabled** and **disabled** skills (name + `description` parsed from `SKILL.md`).
- A `Switch` per skill → calls enable/disable endpoint.
- "View" opens the raw `SKILL.md` (read-only) — reuses an existing dialog/sheet.
- Keeps the existing re-seed / "populate skills" action (`POST /sandbox/init`).
- No skill authoring in v1.

### 4.3 Specialists panel

Relocate `web/src/components/subagents-panel.tsx` into the hub unchanged except for
adding an enable/disable `Switch` per row. Keeps create / edit / delete / "Customize"
(shadow a builtin) / "Restore defaults". Builtin toggle behavior per §3.1.

### 4.4 Connectors panel

Relocate `McpServersPanel` (currently inline in `settings-dialog.tsx`, ~line 416) into
the hub as `connectors-panel.tsx`, renamed "Connectors". Adds an enable/disable
`Switch` per server. Keeps add / edit / test-connection.

### 4.5 Settings dialog changes — `web/src/components/settings-dialog.tsx`

Remove the `mcp` and `agents` tabs. Settings retains: **API keys**, **Fusion**,
**Appearance**. (This also trims the overloaded file.)

### 4.6 Entry point — `web/src/app/page.tsx`

Add a **Customize** icon-button in the header's right cluster next to the gear
(`page.tsx:481`), same `rounded-lg p-1.5 text-muted-foreground` styling wrapped in
`InfoTooltip`, with its own `customizeOpen` state and the dialog mounted alongside
`SettingsDialog` (~line 626). The hub is project-scoped (uses `activeProjectId`).

## 5. Backend endpoints

Thin additions following the existing per-project (`activePaths()`, `X-Project-Id`)
Fastify pattern. All routes scoped to the active project.

**Skills** (`api/system.ts` + helpers in `agent/skills.ts`):
- `GET /skills/all` → `{ enabled: SkillInfo[], disabled: SkillInfo[] }`
- `POST /skills/:name/enable` — move dir `skills-disabled/<name>` → `skills/<name>`
- `POST /skills/:name/disable` — move dir `skills/<name>` → `skills-disabled/<name>`
- New helpers: `enableSkill`, `disableSkill`, `listDisabledSkills` (parse `SKILL.md` from the disabled dir too).
- Existing `GET /skills` unchanged (still lists enabled only → composer stays correct).

**Specialists** (`api/agents.ts` + helpers in `agent/agent-files.ts`):
- Extend `listAgents` / `GET /agents` to include an `enabled: boolean` and `source: "project" | "builtin"` per agent (source already tracked).
- `POST /agents/:name/enable` / `POST /agents/:name/disable` — move `.md` between `agents/` and `agents-disabled/` for project agents; builtin per §3.1.

**Connectors** (`api/mcp.ts` + helpers in `agent/mcp.ts`):
- `GET /mcp` → include disabled servers: `{ mcpServers: {...}, disabledServers: {...} }`.
- `POST /mcp/:name/enable` / `POST /mcp/:name/disable` — move the entry between
  `mcp.json` and `mcp-disabled.json`.
- `getMcpTools()` unchanged (reads `mcp.json` = enabled set only).
- Existing `PUT /mcp` and `POST /mcp/test` unchanged.

**Frontend client:** new `web/src/lib/capabilities.ts` (or extend `skills.ts` /
`agents.ts` / `mcp.ts`) exposing typed enable/disable + combined-list calls through
`apiFetch`.

## 6. Data flow

1. User opens **Customize** → each panel fetches its combined enabled/disabled list.
2. User flips a `Switch` → panel POSTs the enable/disable endpoint → backend relocates
   the item → panel refetches (or optimistically updates) the list.
3. Next time a chat tab / subagent run is created, `session-registry.build()` reads
   the canonical locations (unchanged code) and the agent sees exactly the enabled set.
4. The chat composer's skills selector (`GET /skills`) shows only enabled skills for free.

## 7. Error handling

- Backend validates names against existing regexes (`AGENT_NAME_RE`, MCP `NAME_RE`,
  and a skill-name check). Reject traversal / invalid names with 400.
- Enable of a non-existent disabled item, or disable of a non-existent enabled item →
  404 with a clear message.
- Name collision (same name already present in the destination) → 409; do not clobber.
- Relocation uses atomic `fs.renameSync` where possible; on cross-device or partial
  failure, surface a 500 and leave the source in place (no silent data loss).
- Frontend renders errors as the existing red inline banner; loading as the existing
  spinner/"Loading…" pattern.

## 8. Testing

**Backend (vitest, `server/test/`, `KADY_PROJECTS_ROOT` → temp dir):**
- Skills: `disable` then `enable` round-trip preserves dir contents and lands in the
  right location; `listProjectSkills` (⇒ a new session's discovery) excludes disabled
  skills; `GET /skills/all` reports correct partition.
- Specialists: project-agent disable/enable moves the `.md` and updates `listAgents`
  `enabled`; builtin behavior matches whichever §3.1 path the plan selects.
- Connectors: disable removes the entry from `mcp.json` (and `getMcpTools` no longer
  returns it) and adds it to `mcp-disabled.json`; enable reverses; tokens preserved.
- Collision (409) and not-found (404) paths.

**Frontend (vitest):**
- Each panel renders enabled vs disabled rows correctly from a mocked combined list.
- Toggling a `Switch` calls the correct endpoint (mocked `apiFetch`) and reflects the
  new state.
- Settings dialog no longer renders MCP / Sub-agents tabs; Customize dialog opens from
  the header button.

**Typecheck:** `cd server && npm run typecheck`; `cd web && npx tsc --noEmit`.

## 9. File-level change list

**New:**
- `web/src/components/customize-dialog.tsx` — hub shell + capabilities rail.
- `web/src/components/skills-panel.tsx` — Skills list + toggles + view + re-seed.
- `web/src/components/connectors-panel.tsx` — extracted from `McpServersPanel` + toggle.
- `web/src/lib/capabilities.ts` — typed client for enable/disable + combined lists.

**Modified:**
- `server/src/agent/skills.ts` — `enableSkill` / `disableSkill` / `listDisabledSkills`.
- `server/src/api/system.ts` — `GET /skills/all`, `POST /skills/:name/{enable,disable}`.
- `server/src/agent/agent-files.ts` — enabled/source in listing; enable/disable helpers.
- `server/src/api/agents.ts` — `POST /agents/:name/{enable,disable}`; listing shape.
- `server/src/agent/mcp.ts` — read/write `mcp-disabled.json`; enable/disable helpers.
- `server/src/api/mcp.ts` — `GET /mcp` includes disabled; `POST /mcp/:name/{enable,disable}`.
- `web/src/components/subagents-panel.tsx` — add per-row toggle; render in hub.
- `web/src/components/settings-dialog.tsx` — remove `mcp` + `agents` tabs.
- `web/src/app/page.tsx` — Customize header button + dialog mount + state.
- `AGENTS.md` — document the hub, the `-disabled` stores, and the toggle semantics.

**Unchanged (by design):** `server/src/agent/session-registry.ts`, `getMcpTools()`,
`GET /skills`, the composer skills selector.

## 10. Open items to resolve in the implementation plan

1. Whether pi-subagents supports excluding a **builtin** agent by name (drives §3.1).
2. Exact "View SKILL.md" surface (reuse an existing dialog vs. a lightweight sheet).
3. Whether to optimistically update toggles or always refetch (lean: refetch for v1).
