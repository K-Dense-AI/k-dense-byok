/**
 * Sandbox provisioning: seed each project sandbox with a uv-managed Python
 * project (`pyproject.toml`) and an `AGENTS.md` context file.
 *
 * Pi's DefaultResourceLoader (cwd = sandbox) auto-discovers AGENTS.md and
 * injects it into the agent's system prompt, so AGENTS.md doubles as the
 * user-editable system-prompt extension point — it's visible and editable
 * right in the Sandbox file panel.
 *
 * Files are written only if missing, so user edits are never clobbered.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectPaths } from "./projects.ts";

const PYPROJECT_TOML = `[project]
name = "kady-sandbox"
version = "0.1.0"
description = "Kady project sandbox (managed by uv)"
requires-python = ">=3.11"
dependencies = [
    "numpy",
    "pandas",
    "matplotlib",
    "scipy",
]
`;

const AGENTS_MD = `# Sandbox instructions

This file is part of the agent's system prompt. Edit it to change how the
agent behaves in this project (style, constraints, domain context, ...).

## Python — always use uv

This sandbox is a uv project (see \`pyproject.toml\`). The system Python has no
scientific packages and rejects \`pip install\` (externally managed), so:

- ALWAYS run Python through uv: \`uv run python script.py\` — never bare
  \`python\`/\`python3\` and never \`pip install\`.
- Need a package that isn't installed? Run \`uv add <package>\`, then re-run.
- If a script fails with \`ModuleNotFoundError\`, run \`uv add <module>\` and
  retry — do not give up or switch tasks.
- The environment lives in \`.venv/\`; \`uv run\` creates and syncs it
  automatically. If \`uv\` is not on PATH, try \`~/.local/bin/uv\`.

## Clarifying questions — ask, don't assume

You have an \`interview\` tool that shows the user an interactive form right
in the chat. Use it as much as possible:

- Before starting any non-trivial task, confirm scope, inputs, and approach
  with a short interview (include your recommended answers so the user can
  confirm in one click).
- Whenever the request is ambiguous, a parameter is unspecified, or several
  reasonable approaches exist, interview the user instead of guessing.
- Bundle related questions into ONE interview rather than several calls.

## Files

- **Uploads from the user live in \`user_data/\`.** When the user refers to
  "the data I uploaded" / "my file", look there first.
- **Save your own outputs** (plots, results, reports) into the sandbox working
  directory (the root) so they appear in the file panel.
`;

/** Write pyproject.toml + AGENTS.md into the sandbox if missing. Idempotent. */
export function seedSandboxFiles(paths: ProjectPaths): void {
  fs.mkdirSync(paths.sandbox, { recursive: true });
  const pyproject = path.join(paths.sandbox, "pyproject.toml");
  if (!fs.existsSync(pyproject)) fs.writeFileSync(pyproject, PYPROJECT_TOML, "utf-8");
  const agentsMd = path.join(paths.sandbox, "AGENTS.md");
  if (!fs.existsSync(agentsMd)) fs.writeFileSync(agentsMd, AGENTS_MD, "utf-8");
}

function uvBinary(): string | null {
  for (const candidate of ["uv", path.join(os.homedir(), ".local", "bin", "uv")]) {
    const res = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (res.status === 0) return candidate;
  }
  return null;
}

/**
 * Pre-warm the sandbox venv (`uv sync`) so the agent's first `uv run` doesn't
 * pay the install cost. Best-effort: returns false when uv is missing or sync
 * fails; `uv run` still self-heals later.
 */
export function syncSandboxVenv(paths: ProjectPaths): boolean {
  seedSandboxFiles(paths);
  const uv = uvBinary();
  if (!uv) return false;
  const res = spawnSync(uv, ["sync"], {
    cwd: paths.sandbox,
    stdio: "ignore",
    timeout: 5 * 60 * 1000,
  });
  return res.status === 0;
}
