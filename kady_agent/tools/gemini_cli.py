import asyncio
import json
import os
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from google.adk.tools.tool_context import ToolContext

from ..cost_ledger import check_project_budget
from ..gemini_settings import refresh_oauth_tokens, write_merged_settings
from ..manifest import (
    attach_delegation,
    session_seed,
)
from ..projects import active_paths, ensure_gemini_trust_file, get_project

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
    env = os.environ.copy()
    for var in _VERTEX_AI_ENV_VARS:
        env.pop(var, None)

    # Point Gemini CLI at our own trust file (instead of the default
    # ``~/.gemini/trustedFolders.json``) so the project sandbox is treated as
    # trusted and the workspace ``settings.json`` -- which selects
    # ``gemini-api-key`` and our LiteLLM proxy -- is actually loaded. Without
    # this, the user's global ``~/.gemini/settings.json`` (often left on
    # ``vertex-ai`` from a previous gcloud login) wins and the CLI bails out
    # demanding GOOGLE_CLOUD_PROJECT/_LOCATION env vars.
    env["GEMINI_CLI_TRUSTED_FOLDERS_PATH"] = str(ensure_gemini_trust_file())

    prev_headers = env.get("GEMINI_CLI_CUSTOM_HEADERS", "").strip()

    paths = active_paths()

    # Hard spend cap: if the project has a spendLimitUsd set and the cumulative
    # cost across every session already equals or exceeds it, refuse to launch
    # the expert. Returning a tool result (rather than raising) lets the
    # orchestrator surface a clean, user-facing explanation and still close
    # the turn normally.
    project_meta = get_project(paths.id)
    if project_meta is not None and project_meta.spendLimitUsd is not None:
        budget = check_project_budget(paths.id, project_meta.spendLimitUsd)
        if budget["state"] == "exceeded":
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
                "projectId": paths.id,
                "totalUsd": spent,
                "limitUsd": limit,
            }

    # Some models (e.g. GPT-5.4 Nano) pass `working_directory="."` or other
    # relative paths when they shouldn't. Treat any relative path as being
    # relative to the project's sandbox, not the repo root — the sandbox IS
    # the working directory. Absolute paths that fall inside the sandbox are
    # honored as-is; otherwise we refuse and fall back to the sandbox.
    if working_directory is None or not working_directory.strip():
        cwd = paths.sandbox
    else:
        wd = Path(working_directory)
        if not wd.is_absolute():
            cwd = (paths.sandbox / wd).resolve()
        else:
            cwd = wd.resolve()
        if not cwd.is_relative_to(paths.sandbox):
            cwd = paths.sandbox

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
        # Prefer the explicit expert model; fall back to the orchestrator
        # model for backwards compat with older clients that only send
        # `_model` and for programmatic callers.
        raw_model = state.get("_expertModel") or state.get("_model")
        if isinstance(raw_model, str) and raw_model.strip():
            selected_model = raw_model.strip()
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
        f"X-Kady-Role: expert",
        f"X-Kady-Project: {paths.id}",
    ]
    if session_id:
        kady_header_parts.append(f"X-Kady-Session-Id: {session_id}")
    if turn_id:
        kady_header_parts.append(f"X-Kady-Turn-Id: {turn_id}")
    if delegation_id:
        kady_header_parts.append(f"X-Kady-Delegation-Id: {delegation_id}")
    header_segments: list[str] = []
    if prev_headers:
        header_segments.append(prev_headers)
    header_segments.append(_CLI_OPENROUTER_HEADERS)
    header_segments.extend(kady_header_parts)
    env["GEMINI_CLI_CUSTOM_HEADERS"] = ", ".join(header_segments)

    sandbox_venv = cwd / ".venv"
    if sandbox_venv.is_dir():
        venv_bin = str(sandbox_venv / "bin")
        env["VIRTUAL_ENV"] = str(sandbox_venv)
        path_parts = env.get("PATH", "").split(os.pathsep)
        old_venv = os.environ.get("VIRTUAL_ENV")
        if old_venv:
            old_bin = os.path.join(old_venv, "bin")
            path_parts = [p for p in path_parts if p != old_bin]
        env["PATH"] = os.pathsep.join([venv_bin] + path_parts)

    # Forward the orchestrator-selected model to the expert so local Ollama
    # (or direct LiteLLM-registered Gemini) is used end-to-end. The CLI
    # only routes via the LiteLLM proxy, so anything that isn't a model
    # the proxy knows about (gemini-*, ollama/*) would hang or 404 — in
    # that case fall back to the CLI default (a gemini-* model).
    cli_args: list[str] = ["gemini", "-p", prompt, "--yolo",
                           "--output-format", "stream-json"]
    if selected_model and _cli_can_route(selected_model):
        cli_args.extend(["-m", selected_model])

    # Refresh any near-expiry MCP OAuth tokens, then re-materialize
    # ``<sandbox>/.gemini/settings.json`` so its ``Authorization`` headers
    # carry the current bearer. Cheap (a couple of file writes) and means
    # the user never sees a 401 from a signed-in MCP just because its
    # access_token rolled over between turns.
    await refresh_oauth_tokens()
    write_merged_settings(paths.gemini_settings_dir)

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

    raw = stdout_bytes.decode(errors="replace")
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
                prompt=prompt,
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
