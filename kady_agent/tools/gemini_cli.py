import asyncio
import json
import os
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from google.adk.tools.tool_context import ToolContext

from ..runtime import check_project_budget
from ..mcp import refresh_oauth_tokens, write_merged_settings
from ..runtime import (
    attach_delegation,
    session_seed,
)
from ..projects import active_paths, ensure_gemini_trust_file, get_project
from ..runtime import build_tracking_headers
from ..sandbox_visibility import iter_user_visible_paths

REPO_ROOT = Path(__file__).resolve().parents[2]

load_dotenv(REPO_ROOT / "kady_agent" / ".env")

# Env vars that would push the CLI into Vertex AI mode regardless of what we
# write in the workspace ``settings.json``. We pop them from the spawn env so
# the LiteLLM-proxy + ``gemini-api-key`` path the workspace settings select is
# what actually gets used. Note: this is *necessary but not sufficient*: the
# workspace ``settings.json`` is only honored when the folder is trusted, which
# is why we also stamp ``GEMINI_CLI_TRUSTED_FOLDERS_PATH`` below.
_VERTEX_AI_ENV_VARS = ("GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS")

# OpenRouter "App" label (via LiteLLM proxy). Format: gemini-cli-core GEMINI_CLI_CUSTOM_HEADERS.
_CLI_OPENROUTER_HEADERS = (
    "X-Title: Kady-Expert, HTTP-Referer: https://www.k-dense.ai"
)
DEFAULT_EXPERT_MODEL = (
    os.getenv("DEFAULT_EXPERT_MODEL")
    or "openrouter/google/gemini-3.1-pro-preview"
)


def _cli_can_route(model: str) -> bool:
    """Return True when the Gemini CLI + our LiteLLM proxy can handle *model*.

    The expert subprocess routes through the LiteLLM proxy at
    ``GOOGLE_GEMINI_BASE_URL``. Only models configured there resolve:
    the explicit ``gemini-*`` entries, the ``ollama/*`` wildcard, and
    the ``openrouter/*`` wildcard. Anything else would cause the CLI to
    hang on a 404 from the proxy, so we drop the ``-m`` flag and let the
    CLI fall back to its built-in default Gemini model.
    """
    return (
        model.startswith("gemini-")
        or model.startswith("ollama/")
        or model.startswith("openrouter/")
    )


def _parse_stream_json(raw: str) -> dict:
    """Parse Gemini CLI stream-json (JSONL) output into a structured result.

    Extracts the final response text, activated skills, and tools used from
    the JSONL event stream so callers get richer metadata than the plain JSON
    format provides.
    """
    response_parts: list[str] = []
    skills_used: list[str] = []
    tools_used: dict[str, int] = {}

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        etype = event.get("type")

        if etype == "tool_use":
            tool_name = event.get("tool_name", "")
            tools_used[tool_name] = tools_used.get(tool_name, 0) + 1

            if tool_name == "activate_skill":
                params = event.get("parameters") or {}
                skill = (
                    params.get("skill_name")
                    or params.get("name")
                    or next((v for v in params.values() if isinstance(v, str)), "")
                )
                if skill and skill not in skills_used:
                    skills_used.append(skill)

        elif etype == "message" and event.get("role") == "assistant":
            content = event.get("content", "")
            if content:
                response_parts.append(content)

    return {
        "result": "".join(response_parts),
        "skills_used": skills_used,
        "tools_used": tools_used,
    }


def _collect_expert_artifacts(kady_dir: Path, delegation_id: str) -> tuple[str | None, list[str] | None]:
    """Read expert-side env.lock and deliverables.json written by the Gemini CLI.

    The expert is instructed (see instructions/gemini_cli.md PROTOCOL:REPRODUCIBILITY)
    to write `.kady/expert/<delegationId>/env.lock` and `deliverables.json`. We
    read and return them so they can be persisted into the manifest.
    """
    expert_dir = kady_dir / "expert" / delegation_id
    env_lock: str | None = None
    deliverables: list[str] | None = None
    try:
        env_path = expert_dir / "env.lock"
        if env_path.is_file():
            env_lock = env_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        pass
    try:
        deliv_path = expert_dir / "deliverables.json"
        if deliv_path.is_file():
            data = json.loads(deliv_path.read_text(encoding="utf-8", errors="replace"))
            if isinstance(data, list):
                deliverables = [str(item) for item in data if isinstance(item, (str, int))]
    except (OSError, json.JSONDecodeError):
        pass
    return env_lock, deliverables


def _base_cli_env() -> dict[str, str]:
    """Build the subprocess environment shared by every expert invocation."""
    env = os.environ.copy()
    for var in _VERTEX_AI_ENV_VARS:
        env.pop(var, None)
    env["GEMINI_CLI_TRUSTED_FOLDERS_PATH"] = str(ensure_gemini_trust_file())
    return env


def _budget_block_response(paths_id: str) -> dict | None:
    """Return a user-facing tool result when project spend blocks delegation."""
    project_meta = get_project(paths_id)
    if project_meta is None or project_meta.spendLimitUsd is None:
        return None
    budget = check_project_budget(paths_id, project_meta.spendLimitUsd)
    if budget["state"] != "exceeded":
        return None
    limit = float(budget["limitUsd"] or 0.0)
    spent = float(budget["totalUsd"] or 0.0)
    return {
        "result": (
            f"Delegation blocked: project '{project_meta.name}' has "
            f"reached its spend limit (${spent:.2f} / ${limit:.2f}). "
            f"Raise the limit in the project settings and retry."
        ),
        "skills_used": [],
        "tools_used": {},
        "budgetBlocked": True,
        "projectId": paths_id,
        "totalUsd": spent,
        "limitUsd": limit,
    }


def _resolve_working_directory(working_directory: Optional[str], sandbox: Path) -> Path:
    """Resolve requested working directories safely inside the sandbox."""
    if working_directory is None or not working_directory.strip():
        return sandbox
    wd = Path(working_directory)
    cwd = (sandbox / wd).resolve() if not wd.is_absolute() else wd.resolve()
    return cwd if cwd.is_relative_to(sandbox) else sandbox


def _apply_sandbox_venv(env: dict[str, str], cwd: Path) -> None:
    """Prefer a sandbox-local virtualenv without leaking the parent venv first."""
    sandbox_venv = cwd / ".venv"
    if not sandbox_venv.is_dir():
        return
    venv_bin = str(sandbox_venv / "bin")
    env["VIRTUAL_ENV"] = str(sandbox_venv)
    path_parts = env.get("PATH", "").split(os.pathsep)
    old_venv = os.environ.get("VIRTUAL_ENV")
    if old_venv:
        old_bin = os.path.join(old_venv, "bin")
        path_parts = [p for p in path_parts if p != old_bin]
    env["PATH"] = os.pathsep.join([venv_bin] + path_parts)


def _build_cli_args(prompt: str, selected_model: Optional[str]) -> list[str]:
    cli_args: list[str] = ["gemini", "-p", prompt, "--yolo", "--output-format", "stream-json"]
    if selected_model and _cli_can_route(selected_model):
        cli_args.extend(["-m", selected_model])
    return cli_args


def _build_expert_prompt(prompt: str, sandbox: Path) -> str:
    """Constrain expert file inspection to the same sandbox tree the UI shows."""
    visible_paths, truncated = iter_user_visible_paths(sandbox)
    if visible_paths:
        listing = "\n".join(f"- {path}" for path in visible_paths)
        truncation_note = (
            "\n- ... list truncated; use the same visibility rules for any further traversal."
            if truncated
            else ""
        )
    else:
        listing = "- (no user-visible files)"
        truncation_note = ""

    return (
        "You are already running in the project sandbox. When inspecting the "
        "working directory, only consider files and folders visible to the user "
        "in the sandbox file tree. Ignore hidden/system entries such as .kady/, "
        ".gemini/, .venv/, GEMINI.md, uv.lock, and *.annotations.json unless the "
        "user explicitly names one of them.\n\n"
        "Current user-visible sandbox contents:\n"
        f"{listing}{truncation_note}\n\n"
        "User task:\n"
        f"{prompt}"
    )


def _cli_failure_response(error: Exception, selected_model: Optional[str]) -> dict:
    """Return a tool result instead of letting a CLI crash break ADK streaming."""
    model_hint = f" using `{selected_model}`" if selected_model else ""
    message = str(error).strip() or error.__class__.__name__
    return {
        "result": (
            f"Delegated expert task failed{model_hint}. The Gemini CLI subprocess "
            f"reported:\n\n{message}\n\n"
            "Try again with the recommended expert model "
            f"`{DEFAULT_EXPERT_MODEL}` if this was caused by a model-specific "
            "OpenRouter/provider request rejection."
        ),
        "skills_used": [],
        "tools_used": {},
        "error": True,
        "model": selected_model,
    }


async def _run_gemini_cli(cli_args: list[str], cwd: Path, env: dict[str, str]) -> tuple[str, int]:
    """Execute Gemini CLI and return raw stdout plus duration in milliseconds."""
    started_at = time.time()
    proc = await asyncio.create_subprocess_exec(
        *cli_args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    stdout_bytes, stderr_bytes = await proc.communicate()
    duration_ms = int((time.time() - started_at) * 1000)
    if proc.returncode != 0:
        raise RuntimeError(
            stderr_bytes.decode(errors="replace").strip() or "gemini command failed"
        )
    return stdout_bytes.decode(errors="replace"), duration_ms


async def delegate_task(
    prompt: str,
    working_directory: Optional[str] = None,
    tool_context: Optional[ToolContext] = None,
) -> dict:
    """Delegate a task to an expert.

    Args:
        prompt: The prompt to delegate to the expert.
        working_directory: The sandbox directory to execute the task in.
            Defaults to the active project's sandbox.

    Returns:
        A dict with ``result`` (response text), ``skills_used`` (list of
        activated Gemini CLI skill names), and ``tools_used`` (tool call
        counts).
    """
    env = _base_cli_env()
    prev_headers = env.get("GEMINI_CLI_CUSTOM_HEADERS", "").strip()

    paths = active_paths()

    # Hard spend cap: if the project has a spendLimitUsd set and the cumulative
    # cost across every session already equals or exceeds it, refuse to launch
    # the expert. Returning a tool result (rather than raising) lets the
    # orchestrator surface a clean, user-facing explanation and still close
    # the turn normally.
    budget_block = _budget_block_response(paths.id)
    if budget_block is not None:
        return budget_block

    # Some models (e.g. GPT-5.4 Nano) pass `working_directory="."` or other
    # relative paths when they shouldn't. Treat any relative path as being
    # relative to the project's sandbox, not the repo root — the sandbox IS
    # the working directory. Absolute paths that fall inside the sandbox are
    # honored as-is; otherwise we refuse and fall back to the sandbox.
    cwd = _resolve_working_directory(working_directory, paths.sandbox)
    cwd.mkdir(parents=True, exist_ok=True)

    # Reproducibility: stamp turn + delegation identifiers into the env so the
    # expert can name its env.lock / deliverables.json files correctly, and
    # seed every RNG it controls from KADY_SEED.
    state = tool_context.state if tool_context is not None else None
    turn_id: Optional[str] = None
    session_id: Optional[str] = None
    delegation_id: Optional[str] = None
    selected_model: Optional[str] = None
    if state is not None:
        turn_id = state.get("_turnId")
        session_id = state.get("_sessionId")
        raw_model = state.get("_expertModel")
        if isinstance(raw_model, str) and raw_model.strip():
            selected_model = raw_model.strip()
    if not selected_model:
        selected_model = DEFAULT_EXPERT_MODEL
    if session_id and turn_id:
        env["KADY_SEED"] = session_seed(session_id)
        env["KADY_TURN_ID"] = turn_id
        env["KADY_SESSION_ID"] = session_id
        # Delegation id is monotonic within a turn to keep paths predictable.
        counter_key = f"_delegation_counter_{turn_id}"
        prev = state.get(counter_key) or 0
        delegation_id = f"{int(prev) + 1:03d}"
        state[counter_key] = int(prev) + 1
        env["KADY_DELEGATION_ID"] = delegation_id

    # Propagate the active project to expert-side MCP servers (e.g. the
    # pdf-annotations server needs to resolve the right sandbox), and
    # stamp an author label the PDF viewer renders next to any
    # annotations the expert emits.
    env["KADY_PROJECT_ID"] = paths.id
    if delegation_id:
        env.setdefault("KADY_EXPERT_ID", delegation_id)
        env.setdefault("KADY_EXPERT_LABEL", f"Expert #{delegation_id}")

    # Build the final GEMINI_CLI_CUSTOM_HEADERS value now that we know the
    # Kady correlation ids. The LiteLLM proxy's cost callback reads these
    # off the inbound HTTP request and writes one ledger entry per expert
    # completion, tagged back to the right session/turn/delegation.
    kady_header_parts = [
        f"{name}: {value}"
        for name, value in build_tracking_headers(
            role="expert",
            project_id=paths.id,
            session_id=session_id,
            turn_id=turn_id,
            delegation_id=delegation_id,
        ).items()
    ]
    header_segments: list[str] = []
    if prev_headers:
        header_segments.append(prev_headers)
    header_segments.append(_CLI_OPENROUTER_HEADERS)
    header_segments.extend(kady_header_parts)
    env["GEMINI_CLI_CUSTOM_HEADERS"] = ", ".join(header_segments)

    _apply_sandbox_venv(env, cwd)

    # Forward the expert-selected model through the LiteLLM proxy. If the
    # caller did not provide one, use the expert default rather than the
    # orchestrator model; the Gemini CLI path is more tool-heavy.
    expert_prompt = _build_expert_prompt(prompt, paths.sandbox)
    cli_args = _build_cli_args(expert_prompt, selected_model)

    # Refresh any near-expiry MCP OAuth tokens, then re-materialize
    # ``<sandbox>/.gemini/settings.json`` so its ``Authorization`` headers
    # carry the current bearer. Cheap (a couple of file writes) and means
    # the user never sees a 401 from a signed-in MCP just because its
    # access_token rolled over between turns.
    await refresh_oauth_tokens()
    write_merged_settings(paths.gemini_settings_dir)

    try:
        raw, duration_ms = await _run_gemini_cli(cli_args, cwd, env)
    except RuntimeError as exc:
        return _cli_failure_response(exc, selected_model)
    result = _parse_stream_json(raw)

    # Persist delegation into the manifest (best-effort).
    if session_id and turn_id and delegation_id:
        env_lock: str | None = None
        deliverables: list[str] | None = None
        kady_dir = cwd / ".kady"
        if kady_dir.is_dir():
            env_lock, deliverables = _collect_expert_artifacts(kady_dir, delegation_id)
        try:
            # Also mirror the delegation dir into the run-level manifest tree so
            # the expert's stdout is reachable by turnId (not just by cwd).
            target_expert_dir = paths.runs_dir / session_id / turn_id / "expert" / delegation_id
            target_expert_dir.mkdir(parents=True, exist_ok=True)
            await attach_delegation(
                session_id=session_id,
                turn_id=turn_id,
                delegation_id=delegation_id,
                prompt=expert_prompt,
                cwd=str(cwd.relative_to(REPO_ROOT)) if cwd.is_relative_to(REPO_ROOT) else str(cwd),
                result=result,
                duration_ms=duration_ms,
                stdout=raw,
                env_lock=env_lock,
                deliverables=deliverables,
            )
        except Exception:
            pass

    return result


if __name__ == "__main__":
    result = asyncio.run(delegate_task("What is the capital of France?"))
    print(result)
