import asyncio
import json
import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]

load_dotenv(REPO_ROOT / "kady_agent" / ".env")

_VERTEX_AI_ENV_VARS = ("GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS")

# OpenRouter "App" label (via LiteLLM proxy). Format: gemini-cli-core GEMINI_CLI_CUSTOM_HEADERS.
_CLI_OPENROUTER_HEADERS = (
    "X-Title: Kady-Expert, HTTP-Referer: https://www.k-dense.ai"
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


async def delegate_task(
    prompt: str, working_directory: str = "sandbox"
) -> dict:
    """Delegate a task to an expert.

    Args:
        prompt: The prompt to delegate to the expert.
        working_directory: The sandbox directory to execute the task in.

    Returns:
        A dict with ``result`` (response text), ``skills_used`` (list of
        activated Gemini CLI skill names), and ``tools_used`` (tool call
        counts).
    """
    env = os.environ.copy()
    for var in _VERTEX_AI_ENV_VARS:
        env.pop(var, None)

    prev_headers = env.get("GEMINI_CLI_CUSTOM_HEADERS", "").strip()
    env["GEMINI_CLI_CUSTOM_HEADERS"] = (
        f"{prev_headers}, {_CLI_OPENROUTER_HEADERS}"
        if prev_headers
        else _CLI_OPENROUTER_HEADERS
    )

    cwd = Path(working_directory)
    if not cwd.is_absolute():
        cwd = REPO_ROOT / cwd

    cwd.mkdir(parents=True, exist_ok=True)

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

    proc = await asyncio.create_subprocess_exec(
        "gemini",
        "-p",
        prompt,
        "--yolo",
        "--output-format",
        "stream-json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    stdout_bytes, stderr_bytes = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(
            stderr_bytes.decode(errors="replace").strip() or "gemini command failed"
        )

    return _parse_stream_json(stdout_bytes.decode(errors="replace"))


if __name__ == "__main__":
    # Quick smoke-test: ask Gemini a trivial question and print the response.
    result = asyncio.run(delegate_task("What is the capital of France?"))
    print(result)
