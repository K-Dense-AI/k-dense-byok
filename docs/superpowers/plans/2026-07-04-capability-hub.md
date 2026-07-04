# Capability Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-project **Customize** modal that browses Skills, Specialists (subagents), and Connectors (MCP servers) and lets the user non-destructively enable/disable each.

**Architecture:** Enable/disable = relocate an item between the canonical location Pi reads and a sibling `-disabled` store (`.pi/skills` ⇄ `.pi/skills-disabled`, `.pi/agents` ⇄ `.pi/agents-disabled`, entries in `.pi/mcp.json` ⇄ `.pi/mcp-disabled.json`). Builtin specialists (which have no project file) are disabled via `subagents.agentOverrides.<name>.disabled` in `.pi/settings.json`, which pi-subagents honors for both the parent session and child `pi` processes. Because sessions already read only the canonical locations, **`session-registry.ts` and `getMcpTools()` need no changes.** The frontend adds one `customize-dialog.tsx` shell that hosts a new Skills panel plus the relocated Connectors and Specialists panels.

**Tech Stack:** Backend — TypeScript run via `tsx`, Fastify, `@earendil-works/pi-coding-agent`, `pi-subagents`, vitest. Frontend — Next.js 16 / React 19, shadcn/ui (`Switch`, `Tabs`, `Dialog`, `Button`, `Input`), Tailwind v4, vitest + @testing-library/react (jsdom).

## Global Constraints

- Node ≥ 22.19. Do **not** run our source through `tsc` for emit — dev/prod run via `tsx`; `tsconfig.json` is `noEmit`.
- Backend tests: `cd server && npm test` (vitest; `KADY_PROJECTS_ROOT` points at a temp dir via `vitest.config.ts`). Typecheck: `cd server && npm run typecheck`.
- Frontend tests: `cd web && npm test` (vitest run; jsdom; setup `web/vitest.setup.ts`; tests are `src/**/*.test.{ts,tsx}`). Typecheck: `cd web && npx tsc --noEmit`.
- All API routes are per-active-project via `activePaths()`; the frontend `apiFetch` injects `X-Project-Id` automatically.
- Toggles take effect for **new** chat tabs / subagent runs; live in-memory sessions keep the set they started with (existing behavior — do not try to hot-reload live sessions).
- Relocation must **move, never delete** (preserve user-customized content and tokens).
- Company name is **K-Dense** (not "K-Dense AI") in any user-facing copy.
- Work on branch `feat/capability-hub`. Commit after each task.
- Spec: `docs/superpowers/specs/2026-07-04-capability-hub-design.md`.

---

## File Structure

**Backend — new:**
- `server/src/agent/capability-state.ts` — shared `ToggleResult` type + `.pi/settings.json` read/write helpers.

**Backend — modified:**
- `server/src/agent/skills.ts` — `skillsDisabledDir`, `listDisabledSkills`, `enableSkill`, `disableSkill`, `readSkillSource`, `SKILL_NAME_RE`.
- `server/src/api/system.ts` — `GET /skills/all`, `GET /skills/:name/source`, `POST /skills/:name/{enable,disable}`.
- `server/src/agent/mcp.ts` — `mcpDisabledPath`, `readMcpDisabled`, `writeMcpDisabled`, `enableMcpServer`, `disableMcpServer`.
- `server/src/api/mcp.ts` — `GET /mcp` returns `disabledServers` too; `POST /mcp/:name/{enable,disable}`.
- `server/src/agent/agent-files.ts` — `enabled?` on `AgentFile`; `agentsDisabledDir`, `listDisabledProjectAgents`, `builtinDisabledNames`, `setBuiltinDisabled`, `setSpecialistEnabled`; `listAgents` reports `enabled` and includes disabled project agents.
- `server/src/api/agents.ts` — `POST /agents/:name/{enable,disable}`.

**Frontend — new:**
- `web/src/lib/capabilities.ts` — skills client (`getAllSkills`, `setSkillEnabled`, `getSkillSource`).
- `web/src/components/skills-panel.tsx` — Skills list + toggles + view + re-seed.
- `web/src/components/connectors-panel.tsx` — the current `McpServersPanel`, relocated + toggle.
- `web/src/components/customize-dialog.tsx` — hub shell (Skills / Specialists / Connectors).

**Frontend — modified:**
- `web/src/lib/agents.ts` — `enabled?` on `AgentFile`; `setAgentEnabled`.
- `web/src/lib/mcp.ts` — `McpListing`, `getMcpListing`, `setConnectorEnabled`.
- `web/src/components/subagents-panel.tsx` — per-row enable/disable `Switch`.
- `web/src/components/settings-dialog.tsx` — remove `mcp` + `agents` tabs and the inline `McpServersPanel`.
- `web/src/app/page.tsx` — Customize header button + state + dialog mount.
- `AGENTS.md` — document the hub, the `-disabled` stores, and toggle semantics.

---

## Task 1: Shared capability-state module

**Files:**
- Create: `server/src/agent/capability-state.ts`
- Test: `server/test/capability-state.test.ts`

**Interfaces:**
- Produces: `type ToggleResult = { ok: true } | { ok: false; status: 400 | 404 | 409; detail: string }`; `piSettingsPath(paths: ProjectPaths): string`; `readPiSettings(paths: ProjectPaths): Record<string, unknown>`; `writePiSettings(paths: ProjectPaths, settings: Record<string, unknown>): void`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/capability-state.test.ts
import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { resolvePaths } from "../src/projects.ts";
import { readPiSettings, writePiSettings, piSettingsPath } from "../src/agent/capability-state.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("pi settings read/write", () => {
  it("returns {} when missing and round-trips a nested write, preserving other keys", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    expect(readPiSettings(paths)).toEqual({});

    writePiSettings(paths, { packages: ["pi-web-access"], subagents: { agentOverrides: { oracle: { disabled: true } } } });
    const again = readPiSettings(paths);
    expect(again.packages).toEqual(["pi-web-access"]);
    expect((again.subagents as any).agentOverrides.oracle.disabled).toBe(true);
    expect(fs.existsSync(piSettingsPath(paths))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/capability-state.test.ts`
Expected: FAIL (cannot find module `../src/agent/capability-state.ts`).

- [ ] **Step 3: Write the module**

```ts
// server/src/agent/capability-state.ts
/**
 * Shared plumbing for the capability hub's enable/disable operations.
 *
 * `ToggleResult` is the uniform return type for relocation helpers so route
 * handlers can map it to an HTTP status without string-matching error messages.
 * The pi-settings helpers own read/modify/write of the project's
 * `sandbox/.pi/settings.json` (also read by pi-web-access + pi-subagents), so we
 * only ever touch the keys we mean to and preserve everything else.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectPaths } from "../projects.ts";

export type ToggleResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; detail: string };

export function piSettingsPath(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "settings.json");
}

export function readPiSettings(paths: ProjectPaths): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8"));
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    /* missing or malformed → empty */
  }
  return {};
}

export function writePiSettings(paths: ProjectPaths, settings: Record<string, unknown>): void {
  const file = piSettingsPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/capability-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/capability-state.ts server/test/capability-state.test.ts
git commit -m "feat(capability-hub): shared toggle-result + pi settings helpers"
```

---

## Task 2: Skills enable/disable backend

**Files:**
- Modify: `server/src/agent/skills.ts`
- Modify: `server/src/api/system.ts`
- Test: `server/test/skills-toggle.test.ts`

**Interfaces:**
- Consumes: `ToggleResult` (Task 1); `listProjectSkills(paths)` (existing) which lists `.pi/skills/`.
- Produces: `SKILL_NAME_RE: RegExp`; `skillsDisabledDir(paths): string`; `listDisabledSkills(paths): Skill[]`; `enableSkill(paths, name): ToggleResult`; `disableSkill(paths, name): ToggleResult`; `readSkillSource(paths, name): string | null`. Routes: `GET /skills/all` → `{ enabled: {id,name,description}[], disabled: {id,name,description}[] }`; `GET /skills/:name/source` → `{ content: string }`; `POST /skills/:name/enable`, `POST /skills/:name/disable`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/skills-toggle.test.ts
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  disableSkill,
  enableSkill,
  listDisabledSkills,
  listProjectSkills,
  readSkillSource,
} from "../src/agent/skills.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
function makeSkill(dir: string, name: string, desc: string): void {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody for ${name}.\n`,
    "utf-8",
  );
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("skills enable/disable", () => {
  it("round-trips a skill between enabled and disabled, preserving content", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    makeSkill(paths.skillsDir, "scanpy-analysis", "single cell");

    expect(listProjectSkills(paths).map((s) => s.name)).toContain("scanpy-analysis");

    expect(disableSkill(paths, "scanpy-analysis")).toEqual({ ok: true });
    expect(listProjectSkills(paths).map((s) => s.name)).not.toContain("scanpy-analysis");
    expect(listDisabledSkills(paths).map((s) => s.name)).toContain("scanpy-analysis");
    // content preserved and readable from either location
    expect(readSkillSource(paths, "scanpy-analysis")).toContain("Body for scanpy-analysis.");

    expect(enableSkill(paths, "scanpy-analysis")).toEqual({ ok: true });
    expect(listProjectSkills(paths).map((s) => s.name)).toContain("scanpy-analysis");
    expect(listDisabledSkills(paths)).toEqual([]);
  });

  it("400 on bad name, 404 when the skill is not in the source location", () => {
    ensureProjectExists("p2");
    const paths = resolvePaths("p2");
    expect(disableSkill(paths, "../evil")).toMatchObject({ ok: false, status: 400 });
    expect(disableSkill(paths, "nope")).toMatchObject({ ok: false, status: 404 });
    expect(enableSkill(paths, "nope")).toMatchObject({ ok: false, status: 404 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/skills-toggle.test.ts`
Expected: FAIL (`disableSkill` is not exported).

- [ ] **Step 3: Add helpers to `server/src/agent/skills.ts`**

Add these imports/exports (the file already imports `fs`, `path`, `loadSkillsFromDir`, `type Skill`, `ProjectPaths`):

```ts
import type { ToggleResult } from "./capability-state.ts";

/** Skill directory names: no separators, no dot-dot. */
export const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function skillsDisabledDir(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "skills-disabled");
}

/** Installed-but-disabled skills (parsed SKILL.md frontmatter). */
export function listDisabledSkills(paths: ProjectPaths): Skill[] {
  const dir = skillsDisabledDir(paths);
  if (!fs.existsSync(dir)) return [];
  return loadSkillsFromDir({ dir, source: "project" }).skills;
}

/** Raw SKILL.md text from whichever location holds the skill; null if absent. */
export function readSkillSource(paths: ProjectPaths, name: string): string | null {
  if (!SKILL_NAME_RE.test(name)) return null;
  for (const base of [paths.skillsDir, skillsDisabledDir(paths)]) {
    const f = path.join(base, name, "SKILL.md");
    if (fs.existsSync(f)) {
      try {
        return fs.readFileSync(f, "utf-8");
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

function moveSkill(fromDir: string, toDir: string, name: string): ToggleResult {
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, status: 400, detail: `Invalid skill name "${name}"` };
  }
  const src = path.join(fromDir, name);
  const dest = path.join(toDir, name);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) {
    return { ok: false, status: 404, detail: `No such skill in this state: "${name}"` };
  }
  if (fs.existsSync(dest)) {
    return { ok: false, status: 409, detail: `A skill named "${name}" already exists at the target` };
  }
  fs.mkdirSync(toDir, { recursive: true });
  fs.renameSync(src, dest);
  return { ok: true };
}

export function disableSkill(paths: ProjectPaths, name: string): ToggleResult {
  return moveSkill(paths.skillsDir, skillsDisabledDir(paths), name);
}

export function enableSkill(paths: ProjectPaths, name: string): ToggleResult {
  return moveSkill(skillsDisabledDir(paths), paths.skillsDir, name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/skills-toggle.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the routes to `server/src/api/system.ts`**

Add imports at top: `import path from "node:path";` (if absent) and extend the skills import:

```ts
import {
  disableSkill,
  enableSkill,
  listDisabledSkills,
  listProjectSkills,
  readSkillSource,
  seedProjectSkills,
  SKILL_NAME_RE,
} from "../agent/skills.ts";
```

Add routes inside `registerSystemRoutes` (next to the existing `GET /skills`):

```ts
  const toInfo = (s: { name: string; description: string }) => ({
    id: s.name,
    name: s.name,
    description: s.description,
  });

  app.get("/skills/all", async () => {
    const paths = activePaths();
    return {
      enabled: listProjectSkills(paths).map(toInfo),
      disabled: listDisabledSkills(paths).map(toInfo),
    };
  });

  app.get<{ Params: { name: string } }>("/skills/:name/source", async (req, reply) => {
    if (!SKILL_NAME_RE.test(req.params.name)) {
      reply.code(400);
      return { detail: `Invalid skill name "${req.params.name}"` };
    }
    const content = readSkillSource(activePaths(), req.params.name);
    if (content === null) {
      reply.code(404);
      return { detail: `No such skill: ${req.params.name}` };
    }
    return { content };
  });

  app.post<{ Params: { name: string } }>("/skills/:name/enable", async (req, reply) => {
    const r = enableSkill(activePaths(), req.params.name);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/skills/:name/disable", async (req, reply) => {
    const r = disableSkill(activePaths(), req.params.name);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });
```

- [ ] **Step 6: Typecheck and commit**

Run: `cd server && npm run typecheck` → Expected: no errors.

```bash
git add server/src/agent/skills.ts server/src/api/system.ts server/test/skills-toggle.test.ts
git commit -m "feat(capability-hub): skills enable/disable backend"
```

---

## Task 3: Connectors enable/disable backend

**Files:**
- Modify: `server/src/agent/mcp.ts`
- Modify: `server/src/api/mcp.ts`
- Test: `server/test/mcp-toggle.test.ts`

**Interfaces:**
- Consumes: `ToggleResult` (Task 1); existing `readMcpConfig`, `writeMcpConfig`, `parseConfig`, `mcpConfigPath`.
- Produces: `mcpDisabledPath(paths): string`; `readMcpDisabled(paths): Record<string, McpServerConfig>`; `writeMcpDisabled(paths, servers): void`; `enableMcpServer(paths, name): ToggleResult`; `disableMcpServer(paths, name): ToggleResult`. Routes: `GET /mcp` → `{ mcpServers, disabledServers }`; `POST /mcp/:name/enable`, `POST /mcp/:name/disable`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/mcp-toggle.test.ts
import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  disableMcpServer,
  enableMcpServer,
  readMcpConfig,
  readMcpDisabled,
  writeMcpConfig,
} from "../src/agent/mcp.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("connectors enable/disable", () => {
  it("moves a server between mcp.json and mcp-disabled.json, preserving config", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    writeMcpConfig(paths, {
      linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "secret" } },
      gh: { command: "npx", args: ["-y", "server-github"] },
    });

    expect(disableMcpServer(paths, "linear")).toEqual({ ok: true });
    expect(Object.keys(readMcpConfig(paths))).toEqual(["gh"]);
    expect(readMcpDisabled(paths).linear).toEqual({
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "secret" },
    });

    expect(enableMcpServer(paths, "linear")).toEqual({ ok: true });
    expect(Object.keys(readMcpConfig(paths)).sort()).toEqual(["gh", "linear"]);
    expect(readMcpDisabled(paths)).toEqual({});
  });

  it("404 when the named server is not in the source state", () => {
    ensureProjectExists("p2");
    const paths = resolvePaths("p2");
    expect(disableMcpServer(paths, "ghost")).toMatchObject({ ok: false, status: 404 });
    expect(enableMcpServer(paths, "ghost")).toMatchObject({ ok: false, status: 404 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/mcp-toggle.test.ts`
Expected: FAIL (`disableMcpServer` not exported).

- [ ] **Step 3: Add helpers to `server/src/agent/mcp.ts`**

Add import near the top: `import type { ToggleResult } from "./capability-state.ts";`

Add after `writeMcpConfig` (which already exists):

```ts
function mcpDisabledPath(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "mcp-disabled.json");
}

/** Parsed disabled-server map for a project ({} when missing/malformed). */
export function readMcpDisabled(paths: ProjectPaths): Record<string, McpServerConfig> {
  try {
    return parseConfig(fs.readFileSync(mcpDisabledPath(paths), "utf-8"));
  } catch {
    return {};
  }
}

/** Persist the disabled-server map (atomic write), mirroring mcp.json's shape. */
export function writeMcpDisabled(
  paths: ProjectPaths,
  servers: Record<string, McpServerConfig>,
): void {
  const file = mcpDisabledPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

function moveServer(
  paths: ProjectPaths,
  name: string,
  from: "enabled" | "disabled",
): ToggleResult {
  const enabled = readMcpConfig(paths);
  const disabled = readMcpDisabled(paths);
  const src = from === "enabled" ? enabled : disabled;
  const dst = from === "enabled" ? disabled : enabled;
  if (!(name in src)) {
    return { ok: false, status: 404, detail: `No ${from} connector named "${name}"` };
  }
  dst[name] = src[name];
  delete src[name];
  writeMcpConfig(paths, enabled);
  writeMcpDisabled(paths, disabled);
  return { ok: true };
}

/** Move an enabled server into the disabled store (keeps its config + token). */
export function disableMcpServer(paths: ProjectPaths, name: string): ToggleResult {
  return moveServer(paths, name, "enabled");
}

/** Move a disabled server back into mcp.json. */
export function enableMcpServer(paths: ProjectPaths, name: string): ToggleResult {
  return moveServer(paths, name, "disabled");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/mcp-toggle.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `server/src/api/mcp.ts` routes**

Extend the import from `../agent/mcp.ts` to include `readMcpDisabled`, `disableMcpServer`, `enableMcpServer`. Change the `GET /mcp` handler and add two routes:

```ts
  app.get("/mcp", async () => {
    const paths = activePaths();
    return { mcpServers: readMcpConfig(paths), disabledServers: readMcpDisabled(paths) };
  });

  app.post<{ Params: { name: string } }>("/mcp/:name/enable", async (req, reply) => {
    if (!NAME_RE.test(req.params.name)) {
      reply.code(400);
      return { detail: `Invalid server name "${req.params.name}"` };
    }
    const r = enableMcpServer(activePaths(), req.params.name);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/mcp/:name/disable", async (req, reply) => {
    if (!NAME_RE.test(req.params.name)) {
      reply.code(400);
      return { detail: `Invalid server name "${req.params.name}"` };
    }
    const r = disableMcpServer(activePaths(), req.params.name);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });
```

Note: `readMcpConfig` is already imported? If not, add it to the `../agent/mcp.ts` import list.

- [ ] **Step 6: Typecheck and commit**

Run: `cd server && npm run typecheck` → Expected: no errors.

```bash
git add server/src/agent/mcp.ts server/src/api/mcp.ts server/test/mcp-toggle.test.ts
git commit -m "feat(capability-hub): connectors enable/disable backend"
```

---

## Task 4: Specialists enable/disable backend

**Files:**
- Modify: `server/src/agent/agent-files.ts`
- Modify: `server/src/api/agents.ts`
- Test: `server/test/specialists-toggle.test.ts`

**Interfaces:**
- Consumes: `ToggleResult`, `readPiSettings`, `writePiSettings` (Task 1); existing `agentsDir` (private), `listProjectAgents`, `listBuiltinAgents`, `AGENT_NAME_RE`, `AgentFile`.
- Produces: `AgentFile.enabled?: boolean`; `agentsDisabledDir(paths): string`; `listDisabledProjectAgents(paths): AgentFile[]`; `builtinDisabledNames(paths): Set<string>`; `setBuiltinDisabled(paths, name, disabled): void`; `setSpecialistEnabled(paths, name, enabled): ToggleResult`; `listAgents(paths)` returns `AgentFile[]` where every item has `enabled` set and disabled project agents are included. Routes: `POST /agents/:name/enable`, `POST /agents/:name/disable`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/specialists-toggle.test.ts
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  listAgents,
  listBuiltinAgents,
  setSpecialistEnabled,
  writeProjectAgent,
} from "../src/agent/agent-files.ts";
import { readPiSettings } from "../src/agent/capability-state.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("specialists enable/disable", () => {
  it("disables/enables a project specialist by relocating its file", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    writeProjectAgent(paths, "stats-reviewer", {
      description: "checks stats",
      systemPrompt: "Be rigorous.",
    });

    const before = listAgents(paths).find((a) => a.name === "stats-reviewer");
    expect(before?.enabled).toBe(true);

    expect(setSpecialistEnabled(paths, "stats-reviewer", false)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents", "stats-reviewer.md"))).toBe(false);
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents-disabled", "stats-reviewer.md"))).toBe(true);
    const disabled = listAgents(paths).find((a) => a.name === "stats-reviewer");
    expect(disabled?.enabled).toBe(false);

    expect(setSpecialistEnabled(paths, "stats-reviewer", true)).toEqual({ ok: true });
    expect(listAgents(paths).find((a) => a.name === "stats-reviewer")?.enabled).toBe(true);
  });

  it("disables a builtin specialist via .pi/settings.json overrides", () => {
    ensureProjectExists("p2");
    const paths = resolvePaths("p2");
    const builtin = listBuiltinAgents()[0];
    expect(builtin).toBeTruthy();

    expect(setSpecialistEnabled(paths, builtin.name, false)).toEqual({ ok: true });
    const settings = readPiSettings(paths) as any;
    expect(settings.subagents.agentOverrides[builtin.name].disabled).toBe(true);
    expect(listAgents(paths).find((a) => a.name === builtin.name)?.enabled).toBe(false);

    expect(setSpecialistEnabled(paths, builtin.name, true)).toEqual({ ok: true });
    expect(listAgents(paths).find((a) => a.name === builtin.name)?.enabled).toBe(true);
  });

  it("404 for an unknown name, 400 for a bad name", () => {
    ensureProjectExists("p3");
    const paths = resolvePaths("p3");
    expect(setSpecialistEnabled(paths, "does-not-exist", false)).toMatchObject({ ok: false, status: 404 });
    expect(setSpecialistEnabled(paths, "Bad Name", false)).toMatchObject({ ok: false, status: 400 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/specialists-toggle.test.ts`
Expected: FAIL (`setSpecialistEnabled` not exported).

- [ ] **Step 3: Extend `server/src/agent/agent-files.ts`**

Add import near the top:

```ts
import { readPiSettings, writePiSettings, type ToggleResult } from "./capability-state.ts";
```

Add `enabled?: boolean;` to the `AgentFile` interface (after `source`):

```ts
  /** Whether this agent is active for new sessions (hub toggle). */
  enabled?: boolean;
```

Add the disabled dir + listing + builtin-state helpers (place after `agentsDir`):

```ts
export function agentsDisabledDir(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "agents-disabled");
}

/** Project agents parked in the disabled store (source "project"). */
export function listDisabledProjectAgents(paths: ProjectPaths): AgentFile[] {
  const dir = agentsDisabledDir(paths);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return entries
    .sort()
    .map((f) => readAgentFile(path.join(dir, f), "project"))
    .filter((a): a is AgentFile => a !== null);
}

/** Builtin names that are disabled via .pi/settings.json (subagents.*). */
export function builtinDisabledNames(paths: ProjectPaths): Set<string> {
  const settings = readPiSettings(paths);
  const sub = (settings.subagents ?? {}) as Record<string, unknown>;
  const bulk = sub.disableBuiltins === true;
  const overrides = (sub.agentOverrides ?? {}) as Record<string, { disabled?: boolean }>;
  const out = new Set<string>();
  for (const b of listBuiltinAgents()) {
    const ov = overrides[b.name];
    const disabled = ov?.disabled === true || (bulk && ov?.disabled !== false);
    if (disabled) out.add(b.name);
  }
  return out;
}

/** Set/clear a builtin's disabled override, preserving all other settings keys. */
export function setBuiltinDisabled(paths: ProjectPaths, name: string, disabled: boolean): void {
  const settings = readPiSettings(paths);
  const sub =
    settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
      ? { ...(settings.subagents as Record<string, unknown>) }
      : {};
  const overrides =
    sub.agentOverrides && typeof sub.agentOverrides === "object" && !Array.isArray(sub.agentOverrides)
      ? { ...(sub.agentOverrides as Record<string, unknown>) }
      : {};
  overrides[name] = { ...((overrides[name] as Record<string, unknown>) ?? {}), disabled };
  sub.agentOverrides = overrides;
  settings.subagents = sub;
  writePiSettings(paths, settings);
}
```

Replace `listAgents` with the enabled-aware version:

```ts
export function listAgents(paths: ProjectPaths): AgentFile[] {
  const enabledProject = listProjectAgents(paths).map((a) => ({ ...a, enabled: true }));
  const disabledProject = listDisabledProjectAgents(paths).map((a) => ({ ...a, enabled: false }));
  const projectNames = new Set([...enabledProject, ...disabledProject].map((a) => a.name));
  const disabledBuiltins = builtinDisabledNames(paths);
  const builtins = listBuiltinAgents()
    .filter((a) => !projectNames.has(a.name))
    .map((a) => ({ ...a, enabled: !disabledBuiltins.has(a.name) }));
  return [...enabledProject, ...disabledProject, ...builtins];
}
```

Add the toggle at the end of the mutations section:

```ts
/**
 * Enable/disable a specialist for new sessions.
 *  - Project agent: relocate its .md between agents/ and agents-disabled/.
 *  - Builtin (pi-subagents package): set subagents.agentOverrides.<name>.disabled.
 * A name that shadows a builtin sets both, so runtime discovery stays consistent.
 */
export function setSpecialistEnabled(
  paths: ProjectPaths,
  name: string,
  enabled: boolean,
): ToggleResult {
  if (!AGENT_NAME_RE.test(name)) {
    return { ok: false, status: 400, detail: `Invalid agent name "${name}"` };
  }
  const projFile = path.join(agentsDir(paths), `${name}.md`);
  const disFile = path.join(agentsDisabledDir(paths), `${name}.md`);
  const isProject = fs.existsSync(projFile) || fs.existsSync(disFile);
  const isBuiltin = listBuiltinAgents().some((b) => b.name === name);
  if (!isProject && !isBuiltin) {
    return { ok: false, status: 404, detail: `No such specialist: ${name}` };
  }

  if (enabled) {
    if (fs.existsSync(disFile)) {
      if (fs.existsSync(projFile)) {
        return { ok: false, status: 409, detail: `"${name}" already has an enabled definition` };
      }
      fs.mkdirSync(agentsDir(paths), { recursive: true });
      fs.renameSync(disFile, projFile);
    }
    if (isBuiltin) setBuiltinDisabled(paths, name, false);
  } else {
    if (fs.existsSync(projFile)) {
      if (fs.existsSync(disFile)) {
        return { ok: false, status: 409, detail: `"${name}" already has a disabled definition` };
      }
      fs.mkdirSync(agentsDisabledDir(paths), { recursive: true });
      fs.renameSync(projFile, disFile);
    }
    if (isBuiltin) setBuiltinDisabled(paths, name, true);
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/specialists-toggle.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing agent-files test (regression)**

Run: `cd server && npx vitest run test/agent-files.test.ts`
Expected: PASS (adding an optional `enabled` field and including disabled agents must not break existing assertions; if an existing test asserts an exact `listAgents` shape with `toEqual`, adjust it to `toMatchObject` or account for the new `enabled` field).

- [ ] **Step 6: Add routes to `server/src/api/agents.ts`**

Extend the import from `../agent/agent-files.ts` to include `setSpecialistEnabled`, and add:

```ts
  app.post<{ Params: { name: string } }>("/agents/:name/enable", async (req, reply) => {
    const r = setSpecialistEnabled(activePaths(), req.params.name, true);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/agents/:name/disable", async (req, reply) => {
    const r = setSpecialistEnabled(activePaths(), req.params.name, false);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });
```

- [ ] **Step 7: Typecheck and commit**

Run: `cd server && npm run typecheck` → Expected: no errors. Then `cd server && npm test` → Expected: all pass.

```bash
git add server/src/agent/agent-files.ts server/src/api/agents.ts server/test/specialists-toggle.test.ts server/test/agent-files.test.ts
git commit -m "feat(capability-hub): specialists enable/disable backend"
```

---

## Task 5: Frontend capability clients

**Files:**
- Create: `web/src/lib/capabilities.ts`
- Modify: `web/src/lib/agents.ts`
- Modify: `web/src/lib/mcp.ts`
- Test: `web/src/lib/capabilities.test.ts`

**Interfaces:**
- Produces: `getAllSkills(): Promise<{ enabled: SkillInfo[]; disabled: SkillInfo[] }>`; `setSkillEnabled(name, enabled): Promise<void>`; `getSkillSource(name): Promise<string>`; `AgentFile.enabled?: boolean`; `setAgentEnabled(name, enabled): Promise<void>`; `McpListing = { mcpServers: McpServers; disabledServers: McpServers }`; `getMcpListing(): Promise<McpListing>`; `setConnectorEnabled(name, enabled): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/capabilities.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import * as projects from "@/lib/projects";
import { getAllSkills, setSkillEnabled } from "@/lib/capabilities";

afterEach(() => vi.restoreAllMocks());

describe("capabilities client", () => {
  it("getAllSkills returns the enabled/disabled partition", async () => {
    vi.spyOn(projects, "apiFetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: [{ id: "a", name: "a", description: "" }], disabled: [] }), {
        status: 200,
      }),
    );
    const listing = await getAllSkills();
    expect(listing.enabled.map((s) => s.name)).toEqual(["a"]);
    expect(listing.disabled).toEqual([]);
  });

  it("setSkillEnabled posts to the enable/disable route and throws detail on error", async () => {
    const spy = vi
      .spyOn(projects, "apiFetch")
      .mockResolvedValue(new Response(JSON.stringify({ detail: "boom" }), { status: 409 }));
    await expect(setSkillEnabled("a", false)).rejects.toThrow("boom");
    expect(spy).toHaveBeenCalledWith("/skills/a/disable", { method: "POST" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/capabilities.test.ts`
Expected: FAIL (cannot resolve `@/lib/capabilities`).

- [ ] **Step 3: Create `web/src/lib/capabilities.ts`**

```ts
"use client";

/**
 * Skills capability client for the Customize hub. Skills are per active project
 * (apiFetch scopes by X-Project-Id); enabling/disabling relocates the skill on
 * disk server-side so it (dis)appears from agent discovery on the next session.
 */
import { apiFetch } from "@/lib/projects";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
}

export interface SkillsListing {
  enabled: SkillInfo[];
  disabled: SkillInfo[];
}

export async function getAllSkills(): Promise<SkillsListing> {
  const res = await apiFetch("/skills/all");
  if (!res.ok) throw new Error(`getAllSkills ${res.status}`);
  const data = (await res.json()) as Partial<SkillsListing>;
  return { enabled: data.enabled ?? [], disabled: data.disabled ?? [] };
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const res = await apiFetch(`/skills/${encodeURIComponent(name)}/${action}`, { method: "POST" });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || `setSkillEnabled ${res.status}`);
  }
}

export async function getSkillSource(name: string): Promise<string> {
  const res = await apiFetch(`/skills/${encodeURIComponent(name)}/source`);
  if (!res.ok) throw new Error(`getSkillSource ${res.status}`);
  const data = (await res.json()) as { content: string };
  return data.content;
}
```

- [ ] **Step 4: Add to `web/src/lib/agents.ts`**

Add `enabled?: boolean;` to the `AgentFile` interface (after `source`), and append:

```ts
export async function setAgentEnabled(name: string, enabled: boolean): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const res = await apiFetch(`/agents/${encodeURIComponent(name)}/${action}`, { method: "POST" });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || `setAgentEnabled ${res.status}`);
  }
}
```

- [ ] **Step 5: Add to `web/src/lib/mcp.ts`**

```ts
export interface McpListing {
  mcpServers: McpServers;
  disabledServers: McpServers;
}

export async function getMcpListing(): Promise<McpListing> {
  const res = await apiFetch("/mcp");
  if (!res.ok) throw new Error(`getMcpListing ${res.status}`);
  const data = (await res.json()) as { mcpServers?: McpServers; disabledServers?: McpServers };
  return { mcpServers: data.mcpServers ?? {}, disabledServers: data.disabledServers ?? {} };
}

export async function setConnectorEnabled(name: string, enabled: boolean): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const res = await apiFetch(`/mcp/${encodeURIComponent(name)}/${action}`, { method: "POST" });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || `setConnectorEnabled ${res.status}`);
  }
}
```

- [ ] **Step 6: Run tests + typecheck, commit**

Run: `cd web && npx vitest run src/lib/capabilities.test.ts` → Expected: PASS.
Run: `cd web && npx tsc --noEmit` → Expected: no errors.

```bash
git add web/src/lib/capabilities.ts web/src/lib/agents.ts web/src/lib/mcp.ts web/src/lib/capabilities.test.ts
git commit -m "feat(capability-hub): frontend capability clients"
```

---

## Task 6: Skills panel component

**Files:**
- Create: `web/src/components/skills-panel.tsx`
- Test: `web/src/components/skills-panel.test.tsx`

**Interfaces:**
- Consumes: `getAllSkills`, `setSkillEnabled`, `getSkillSource` (Task 5); `useProjects` (`web/src/lib/use-projects.ts`); `Switch` (`@/components/ui/switch`), `Input`, `Button`, `Dialog` primitives.
- Produces: `export function SkillsPanel(): JSX.Element`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/skills-panel.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as caps from "@/lib/capabilities";
import * as useProjects from "@/lib/use-projects";
import { SkillsPanel } from "@/components/skills-panel";

afterEach(() => vi.restoreAllMocks());

function stubProjects() {
  vi.spyOn(useProjects, "useProjects").mockReturnValue({
    activeProject: { id: "p1", name: "P1" },
    activeProjectId: "p1",
  } as unknown as ReturnType<typeof useProjects.useProjects>);
}

describe("SkillsPanel", () => {
  it("lists enabled and disabled skills and toggles one off", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue({
      enabled: [{ id: "scanpy", name: "scanpy", description: "single cell" }],
      disabled: [{ id: "old", name: "old", description: "legacy" }],
    });
    const setSpy = vi.spyOn(caps, "setSkillEnabled").mockResolvedValue();

    render(<SkillsPanel />);
    expect(await screen.findByText("scanpy")).toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();

    const scanpyToggle = screen.getByRole("switch", { name: /scanpy/i });
    await userEvent.click(scanpyToggle);
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("scanpy", false));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/skills-panel.test.tsx`
Expected: FAIL (cannot resolve `@/components/skills-panel`).

- [ ] **Step 3: Create `web/src/components/skills-panel.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useProjects } from "@/lib/use-projects";
import { getAllSkills, setSkillEnabled, type SkillInfo } from "@/lib/capabilities";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";

interface Row extends SkillInfo {
  enabled: boolean;
}

export function SkillsPanel() {
  const { activeProject, activeProjectId } = useProjects();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { enabled, disabled } = await getAllSkills();
      const merged: Row[] = [
        ...enabled.map((s) => ({ ...s, enabled: true })),
        ...disabled.map((s) => ({ ...s, enabled: false })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      setRows(merged);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, activeProjectId]);

  const toggle = useCallback(
    async (name: string, next: boolean) => {
      // optimistic
      setRows((rs) => rs.map((r) => (r.name === name ? { ...r, enabled: next } : r)));
      try {
        await setSkillEnabled(name, next);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Toggle failed");
        void load(); // reconcile on failure
      }
    },
    [load],
  );

  const filtered = rows.filter(
    (r) =>
      r.name.toLowerCase().includes(query.toLowerCase()) ||
      r.description.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">Skills</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Scientific skills the agent can activate. Enabled skills are discovered
          automatically; disabling one hides it from the agent for new chat tabs.
          Per project (current:{" "}
          <span className="font-medium">{activeProject?.name ?? activeProjectId}</span>).
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <Input
        value={query}
        placeholder="Search skills…"
        className="h-8 text-xs"
        onChange={(e) => setQuery(e.target.value)}
      />

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">No skills match.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((r) => (
            <div key={r.name} className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{r.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{r.description}</div>
              </div>
              <Switch
                aria-label={`Toggle ${r.name}`}
                checked={r.enabled}
                onCheckedChange={(v) => void toggle(r.name, v)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Note: "View SKILL.md" (spec §4.2) and the re-seed action are additive; add them in a follow-up step only if time allows — the panel is functional without them, and `getSkillSource` is already available. Do not block this task on them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/skills-panel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/skills-panel.tsx web/src/components/skills-panel.test.tsx
git commit -m "feat(capability-hub): skills panel"
```

---

## Task 7: Connectors panel (relocate + toggle)

**Files:**
- Create: `web/src/components/connectors-panel.tsx`
- Test: `web/src/components/connectors-panel.test.tsx`

**Interfaces:**
- Consumes: existing `getMcpServers`, `saveMcpServers`, `testMcpServer`, `isHttpConfig` from `@/lib/mcp`, plus new `getMcpListing`, `setConnectorEnabled` (Task 5); `Switch`.
- Produces: `export function ConnectorsPanel(): JSX.Element`.

- [ ] **Step 1: Copy the existing panel into the new file**

Copy the `McpServersPanel` function from `web/src/components/settings-dialog.tsx` (starts at `function McpServersPanel()` ~line 416) **and its module-local helpers** it depends on (`McpFormState`, `configFromForm`, `formFromConfig`, `summarizeConfig`, and any icon imports it uses: `GlobeIcon`, `TerminalIcon`, `PencilIcon`, `Trash2Icon`) into a new file `web/src/components/connectors-panel.tsx`. Rename the exported function to `ConnectorsPanel`. Add `"use client";` at the top and the necessary imports (`useState`, `useEffect`, `useCallback` from react; `useProjects`; `Button`, `Input` from ui; the mcp client functions from `@/lib/mcp`). Keep the original `McpServersPanel` in `settings-dialog.tsx` untouched for now (Task 9 removes it) so the build stays green.

Change the heading copy from "MCP servers" to "Connectors" and the description to mention connectors.

- [ ] **Step 2: Add enable/disable to `ConnectorsPanel`**

Replace its data load to use the listing, and add a disabled-servers section + a toggle on each row. Concretely:

In state, add `const [disabled, setDisabled] = useState<McpServers>({});`. Replace the `getMcpServers()` call in the load effect with:

```tsx
    getMcpListing()
      .then(({ mcpServers, disabledServers }) => {
        if (!cancelled) {
          setServers(mcpServers);
          setDisabled(disabledServers);
        }
      })
```

Add a toggle handler:

```tsx
  const toggle = useCallback(async (name: string, next: boolean) => {
    setError(null);
    try {
      await setConnectorEnabled(name, next);
      const { mcpServers, disabledServers } = await getMcpListing();
      setServers(mcpServers);
      setDisabled(disabledServers);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Toggle failed");
    }
  }, []);
```

In the enabled-server row (the `div` with edit/delete buttons), add a `Switch` before the edit button:

```tsx
                    <Switch
                      aria-label={`Toggle ${name}`}
                      checked
                      onCheckedChange={() => void toggle(name, false)}
                    />
```

After the enabled list, render the disabled ones (read-only rows with an off switch):

```tsx
          {Object.keys(disabled).length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">Disabled</div>
              {Object.keys(disabled)
                .sort()
                .map((name) => (
                  <div key={name} className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 opacity-70">
                    <div className="min-w-0 flex-1 text-xs font-medium">{name}</div>
                    <Switch
                      aria-label={`Toggle ${name}`}
                      checked={false}
                      onCheckedChange={() => void toggle(name, true)}
                    />
                  </div>
                ))}
            </div>
          )}
```

Add imports: `import { Switch } from "@/components/ui/switch";` and extend the `@/lib/mcp` import with `getMcpListing, setConnectorEnabled`.

- [ ] **Step 2b: Write the test**

```tsx
// web/src/components/connectors-panel.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mcp from "@/lib/mcp";
import * as useProjects from "@/lib/use-projects";
import { ConnectorsPanel } from "@/components/connectors-panel";

afterEach(() => vi.restoreAllMocks());

describe("ConnectorsPanel", () => {
  it("shows enabled + disabled connectors and re-enables one", async () => {
    vi.spyOn(useProjects, "useProjects").mockReturnValue({
      activeProject: { id: "p1", name: "P1" },
      activeProjectId: "p1",
    } as unknown as ReturnType<typeof useProjects.useProjects>);
    vi.spyOn(mcp, "getMcpListing").mockResolvedValue({
      mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } },
      disabledServers: { gh: { command: "npx", args: [] } },
    });
    const setSpy = vi.spyOn(mcp, "setConnectorEnabled").mockResolvedValue();

    render(<ConnectorsPanel />);
    expect(await screen.findByText("linear")).toBeInTheDocument();
    expect(screen.getByText("gh")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: /toggle gh/i }));
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("gh", true));
  });
});
```

- [ ] **Step 3: Run test + typecheck**

Run: `cd web && npx vitest run src/components/connectors-panel.test.tsx` → Expected: PASS.
Run: `cd web && npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/connectors-panel.tsx web/src/components/connectors-panel.test.tsx
git commit -m "feat(capability-hub): connectors panel with enable/disable"
```

---

## Task 8: Specialists panel toggle

**Files:**
- Modify: `web/src/components/subagents-panel.tsx`
- Test: `web/src/components/subagents-panel.test.tsx` (create)

**Interfaces:**
- Consumes: existing `getAgents`, and new `setAgentEnabled` + `AgentFile.enabled` (Task 5); `Switch`.

- [ ] **Step 1: Read the current row rendering**

Open `web/src/components/subagents-panel.tsx`. Locate where it maps `agents` to rows (each row shows the agent name/description and, for builtins, View/Customize buttons; for project agents, Edit/Delete). Note the variable name for the current agent in the map callback (referred to below as `agent`).

- [ ] **Step 2: Add the toggle handler + Switch**

Add imports: `import { Switch } from "@/components/ui/switch";` and extend the `@/lib/agents` import with `setAgentEnabled`.

Add a handler in the component body:

```tsx
  const toggleEnabled = useCallback(
    async (name: string, next: boolean) => {
      setAgents((list) => list.map((a) => (a.name === name ? { ...a, enabled: next } : a)));
      try {
        await setAgentEnabled(name, next);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Toggle failed");
        void reload(); // use the panel's existing refetch (rename to match)
      }
    },
    [/* include the panel's reload/load fn */],
  );
```

(Use whatever the panel's existing state setter for the agent list is — likely `setAgents` — and its existing reload function. If there is no reload function, call the effect's loader.)

In each agent row, add a `Switch` (default `enabled` to `true` when the field is absent, for resilience):

```tsx
              <Switch
                aria-label={`Toggle ${agent.name}`}
                checked={agent.enabled !== false}
                onCheckedChange={(v) => void toggleEnabled(agent.name, v)}
              />
```

Place it at the leading or trailing edge of the row's action cluster, consistent with the existing layout.

- [ ] **Step 3: Write the test**

```tsx
// web/src/components/subagents-panel.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentsLib from "@/lib/agents";
import * as useProjects from "@/lib/use-projects";
import { SubagentsPanel } from "@/components/subagents-panel";

afterEach(() => vi.restoreAllMocks());

describe("SubagentsPanel toggle", () => {
  it("disables a specialist via the switch", async () => {
    vi.spyOn(useProjects, "useProjects").mockReturnValue({
      activeProject: { id: "p1", name: "P1" },
      activeProjectId: "p1",
    } as unknown as ReturnType<typeof useProjects.useProjects>);
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([
      { name: "oracle", description: "deep reasoning", source: "builtin", systemPrompt: "x", enabled: true },
    ]);
    const setSpy = vi.spyOn(agentsLib, "setAgentEnabled").mockResolvedValue();

    render(<SubagentsPanel />);
    await screen.findByText("oracle");
    await userEvent.click(screen.getByRole("switch", { name: /toggle oracle/i }));
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("oracle", false));
  });
});
```

(If `SubagentsPanel` is a default export, adjust the import accordingly.)

- [ ] **Step 4: Run test + typecheck, commit**

Run: `cd web && npx vitest run src/components/subagents-panel.test.tsx` → Expected: PASS.
Run: `cd web && npx tsc --noEmit` → Expected: no errors.

```bash
git add web/src/components/subagents-panel.tsx web/src/components/subagents-panel.test.tsx
git commit -m "feat(capability-hub): specialists panel toggle"
```

---

## Task 9: Customize dialog shell + header entry point

**Files:**
- Create: `web/src/components/customize-dialog.tsx`
- Modify: `web/src/app/page.tsx`
- Test: `web/src/components/customize-dialog.test.tsx`

**Interfaces:**
- Consumes: `SkillsPanel` (Task 6), `ConnectorsPanel` (Task 7), `SubagentsPanel` (Task 8); `Dialog`, `Tabs` primitives.
- Produces: `export function CustomizeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }): JSX.Element`.

- [ ] **Step 1: Create `web/src/components/customize-dialog.tsx`**

Mirror the vertical-tabs shell used by `settings-dialog.tsx`. Use `SparklesIcon`/`BotIcon`/`PlugIcon` (or existing lucide icons already imported elsewhere; pick from `lucide-react`).

```tsx
"use client";

import { LayersIcon, BotIcon, PlugIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SkillsPanel } from "@/components/skills-panel";
import { ConnectorsPanel } from "@/components/connectors-panel";
import { SubagentsPanel } from "@/components/subagents-panel";

export function CustomizeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl h-[min(560px,80dvh)] flex flex-col gap-0 p-0">
        <DialogHeader className="px-4 py-3 border-b">
          <DialogTitle className="text-sm">Customize</DialogTitle>
        </DialogHeader>
        <Tabs
          defaultValue="skills"
          orientation="vertical"
          className="flex-1 min-h-0 flex flex-row gap-0"
        >
          <TabsList
            variant="line"
            className="w-44 shrink-0 border-r rounded-none px-2 py-3 items-start justify-start"
          >
            <TabsTrigger value="skills" className="justify-start gap-2 px-3 text-xs w-full">
              <LayersIcon className="size-3.5" /> Skills
            </TabsTrigger>
            <TabsTrigger value="specialists" className="justify-start gap-2 px-3 text-xs w-full">
              <BotIcon className="size-3.5" /> Specialists
            </TabsTrigger>
            <TabsTrigger value="connectors" className="justify-start gap-2 px-3 text-xs w-full">
              <PlugIcon className="size-3.5" /> Connectors
            </TabsTrigger>
          </TabsList>
          <TabsContent value="skills" className="flex-1 min-h-0 overflow-hidden px-4 py-3">
            <SkillsPanel />
          </TabsContent>
          <TabsContent value="specialists" className="flex-1 min-h-0 overflow-hidden px-4 py-3">
            <SubagentsPanel />
          </TabsContent>
          <TabsContent value="connectors" className="flex-1 min-h-0 overflow-hidden px-4 py-3">
            <ConnectorsPanel />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
```

(Match the exact `Dialog`/`DialogContent`/`Tabs` prop conventions used in `settings-dialog.tsx` — copy that file's classNames/props if these differ, so styling is identical. If `SubagentsPanel` is a default export, import it as such.)

- [ ] **Step 2: Wire the header button in `web/src/app/page.tsx`**

Add state near the existing `settingsOpen` (~line 79):

```tsx
  const [customizeOpen, setCustomizeOpen] = useState(false);
```

Add a button in the header right cluster, immediately before the gear button (~line 481), copying the gear button's styling and wrapping in `InfoTooltip`. Use a `SlidersHorizontalIcon` (or `LayersIcon`) from lucide:

```tsx
        <InfoTooltip content="Customize skills, specialists, and connectors">
          <button
            type="button"
            onClick={() => setCustomizeOpen(true)}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Customize"
          >
            <SlidersHorizontalIcon className="size-4" />
          </button>
        </InfoTooltip>
```

Mount the dialog next to `<SettingsDialog … />` (~line 626):

```tsx
      <CustomizeDialog open={customizeOpen} onOpenChange={setCustomizeOpen} />
```

Add imports at the top of `page.tsx`: `SlidersHorizontalIcon` from `lucide-react`, and `import { CustomizeDialog } from "@/components/customize-dialog";`. (Match the exact button element/classes the gear uses — copy them verbatim so the two buttons look identical.)

- [ ] **Step 3: Write the test**

```tsx
// web/src/components/customize-dialog.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/skills-panel", () => ({ SkillsPanel: () => <div>skills-panel</div> }));
vi.mock("@/components/connectors-panel", () => ({ ConnectorsPanel: () => <div>connectors-panel</div> }));
vi.mock("@/components/subagents-panel", () => ({ SubagentsPanel: () => <div>subagents-panel</div> }));

import { CustomizeDialog } from "@/components/customize-dialog";

describe("CustomizeDialog", () => {
  it("renders the three capability tabs when open", () => {
    render(<CustomizeDialog open onOpenChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /skills/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /specialists/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /connectors/i })).toBeInTheDocument();
  });
});
```

(If `SubagentsPanel` is a default export, adjust the mock to `{ default: () => … }`.)

- [ ] **Step 4: Run test + typecheck**

Run: `cd web && npx vitest run src/components/customize-dialog.test.tsx` → Expected: PASS.
Run: `cd web && npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 5: Manual verification (drive the real app)**

Start the app (`./start.sh` or the running dev servers). In the browser: click the new Customize button → the modal opens with Skills / Specialists / Connectors. Toggle a skill off and confirm it disappears from the chat composer's skills selector; toggle it back on and confirm it returns. Toggle a connector and a specialist and confirm no errors in the console/network tab.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/customize-dialog.tsx web/src/components/customize-dialog.test.tsx web/src/app/page.tsx
git commit -m "feat(capability-hub): customize dialog + header entry point"
```

---

## Task 10: Remove moved panels from Settings + update docs

**Files:**
- Modify: `web/src/components/settings-dialog.tsx`
- Modify: `AGENTS.md`
- Test: `web/src/components/settings-dialog.test.tsx` (create — minimal)

**Interfaces:**
- Consumes: nothing new. Removes the `mcp` + `agents` tabs and inline `McpServersPanel`.

- [ ] **Step 1: Remove the MCP + Sub-agents tabs**

In `web/src/components/settings-dialog.tsx`:
- Delete the `<TabsTrigger value="mcp" …>` and `<TabsTrigger value="agents" …>` elements and their corresponding `<TabsContent value="mcp">…</TabsContent>` / `<TabsContent value="agents">…</TabsContent>`.
- Delete the now-unused inline `McpServersPanel` function and its local helpers (`configFromForm`, `formFromConfig`, `summarizeConfig`, `McpFormState`) — they now live in `connectors-panel.tsx`.
- Remove the `import { SubagentsPanel } …` and the `@/lib/mcp` imports that are no longer used, and any now-unused icon imports (`GlobeIcon`, `TerminalIcon`, etc.) — let `tsc`/lint tell you which.
- Ensure `defaultValue` on the `Tabs` still points at an existing tab (`"api-keys"`).

- [ ] **Step 2: Write a minimal guard test**

```tsx
// web/src/components/settings-dialog.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/use-projects", () => ({
  useProjects: () => ({ activeProject: { id: "p1", name: "P1" }, activeProjectId: "p1" }),
}));

import { SettingsDialog } from "@/components/settings-dialog";

describe("SettingsDialog", () => {
  it("no longer shows MCP servers or Sub-agents tabs", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.queryByRole("tab", { name: /mcp servers/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /sub-agents/i })).toBeNull();
    expect(screen.getByRole("tab", { name: /api keys/i })).toBeInTheDocument();
  });
});
```

(If `SettingsDialog` needs more context/providers to render, wrap it or mock as needed; keep the assertion focused on tab presence/absence.)

- [ ] **Step 3: Update `AGENTS.md`**

Under the configuration/UI notes, add a short paragraph:

> **Capability hub.** A **Customize** dialog (`web/src/components/customize-dialog.tsx`, opened from the header) is the single per-project surface for **Skills**, **Specialists** (subagents), and **Connectors** (MCP). Enable/disable is non-destructive: skills move between `sandbox/.pi/skills/` and `sandbox/.pi/skills-disabled/`, project specialists between `sandbox/.pi/agents/` and `sandbox/.pi/agents-disabled/`, and MCP entries between `sandbox/.pi/mcp.json` and `sandbox/.pi/mcp-disabled.json`. Builtin (pi-subagents package) specialists are disabled via `subagents.agentOverrides.<name>.disabled` in `sandbox/.pi/settings.json`. Sessions read only the canonical locations, so toggles apply to new chat tabs/subagent runs (live sessions keep their set). The former Settings tabs for MCP servers and Sub-agents now live in this hub.

- [ ] **Step 4: Run the full frontend suite + typecheck**

Run: `cd web && npm test` → Expected: all pass.
Run: `cd web && npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 5: Manual verification**

Open Settings → confirm only API keys / Fusion / Appearance remain, no console errors. Open Customize → all three panels still work.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/settings-dialog.tsx web/src/components/settings-dialog.test.tsx AGENTS.md
git commit -m "refactor(capability-hub): move MCP + sub-agents into Customize; docs"
```

---

## Self-Review

**Spec coverage:**
- Core relocation mechanism (spec §3) → Tasks 1–4 (skills, connectors, specialists), session-builder untouched. ✓
- Builtin specialist edge case (spec §3.1) → resolved via `subagents.agentOverrides.<name>.disabled` (Task 4), verified against pi-subagents source. ✓
- Customize modal + Skills/Specialists/Connectors panels (spec §4.1–4.4) → Tasks 6–9. ✓
- Settings loses MCP + Sub-agents (spec §4.5) → Task 10. ✓
- Header entry point (spec §4.6) → Task 9. ✓
- Backend endpoints (spec §5) → Tasks 2–4. ✓ (`GET /skills` unchanged so composer stays correct — spec §6.)
- Frontend client (spec §5) → Task 5. ✓
- Error handling: 400/404/409 paths (spec §7) → tested in Tasks 2–4. ✓
- Testing (spec §8) → each task has vitest + Tasks 9/10 add manual drive-throughs. ✓
- Docs (spec §9 change list) → Task 10 updates AGENTS.md. ✓
- "View SKILL.md" (spec §4.2): deprioritized to an optional add-on in Task 6 (backend `getSkillSource`/`/skills/:name/source` still built in Tasks 2/5 so it can be added without rework). Noted, not silently dropped.

**Placeholder scan:** No "TBD"/"implement later"; the only deferred item (View SKILL.md UI) is explicitly flagged with its enabling endpoints already built. Frontend edits to existing large files (Tasks 7, 8, 9-step-2, 10) describe exact insertions with complete code snippets rather than full file reproductions, because they are additive edits to files whose full contents the implementer will have open.

**Type consistency:** `ToggleResult` shape identical across Tasks 1–4 and route handlers. `setSkillEnabled`/`setAgentEnabled`/`setConnectorEnabled` all follow `(name, enabled) → Promise<void>` and POST to `/{enable,disable}`. `AgentFile.enabled?` added in both backend (`agent-files.ts`) and frontend (`lib/agents.ts`). `getMcpListing` returns `{ mcpServers, disabledServers }` matching the `GET /mcp` route.
