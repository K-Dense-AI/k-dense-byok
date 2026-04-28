"""Per-turn run manifests for reproducibility.

Writes a ``manifest.json`` describing every turn:

    sandbox/.kady/runs/<sessionId>/<turnId>/
        manifest.json                # inputs, env, hashes, timing
        attachments/<sha256>         # content-addressable store (copies of attached files)
        expert/<delegationId>/
            prompt.txt               # verbatim prompt passed to delegate_task
            stdout.jsonl             # raw Gemini CLI stream-json output
            env.lock                 # uv pip freeze from the expert (phase 3)
            deliverables.json        # files the expert created/modified (phase 3)

The manifest layout is intentionally flat JSON so it is copy-pastable into a
methods section and trivial to diff against a replay. ``open_turn`` /
``attach_delegation`` / ``close_turn`` are the only functions the rest of the
codebase should call; updates go through a process-local lock to avoid write
races when multiple delegations finish concurrently.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import secrets
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .gemini_settings import build_default_settings, load_custom_mcps
from .projects import active_paths

REPO_ROOT = Path(__file__).resolve().parents[1]


def _paths():
    """Return the active project's ProjectPaths — one place all manifest I/O routes through."""
    return active_paths()

_locks: dict[str, asyncio.Lock] = {}


def _manifest_lock(turn_id: str) -> asyncio.Lock:
    lock = _locks.get(turn_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[turn_id] = lock
    return lock


def ulid() -> str:
    """Short, lexicographically-sortable, collision-resistant turn id.

    Not a true ULID (no crockford encoding), but a 26-char hex token with
    millisecond prefix is good enough for per-turn directory names.
    """
    ms = int(time.time() * 1000)
    rand = secrets.token_hex(8)
    return f"{ms:013x}{rand}"


def session_seed(session_id: str) -> str:
    """Return the 16-byte hex seed for a session, creating it on first use."""
    seed_path = _paths().sessions_dir / session_id / "seed"
    if seed_path.is_file():
        try:
            value = seed_path.read_text(encoding="utf-8").strip()
            if value:
                return value
        except OSError:
            pass
    seed = secrets.token_hex(16)
    seed_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        seed_path.write_text(seed, encoding="utf-8")
    except OSError:
        pass
    return seed


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    h = hashlib.sha256()
    try:
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
    except OSError:
        return None
    return h.hexdigest()


def _read_json(path: Path) -> dict | None:
    try:
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _kady_version() -> str:
    try:
        pyproject = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        for line in pyproject.splitlines():
            line = line.strip()
            if line.startswith("version") and "=" in line:
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return "unknown"


def _git_sha() -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2.0,
        )
        if result.returncode == 0:
            return result.stdout.strip() or None
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        pass
    return None


def _gemini_cli_version() -> str | None:
    try:
        result = subprocess.run(
            ["gemini", "--version"],
            capture_output=True,
            text=True,
            timeout=3.0,
        )
        if result.returncode == 0:
            return (result.stdout.strip() or result.stderr.strip()) or None
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        pass
    return None


def _node_version() -> str | None:
    try:
        result = subprocess.run(
            ["node", "--version"],
            capture_output=True,
            text=True,
            timeout=3.0,
        )
        if result.returncode == 0:
            return result.stdout.strip() or None
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        pass
    return None


def _litellm_config_sha() -> str | None:
    return _sha256_file(REPO_ROOT / "litellm_config.yaml")


def _mcp_servers_snapshot() -> list[dict]:
    """Capture MCP server specs verbatim (spec-only pin, per plan)."""
    default_mcps = build_default_settings().get("mcpServers", {})
    custom = load_custom_mcps()
    merged = {**default_mcps, **custom}

    entries: list[dict] = []
    for name in sorted(merged):
        entries.append({"name": name, "spec": merged[name]})
    if os.getenv("EXA_API_KEY"):
        entries.append(
            {
                "name": "exa-search",
                "spec": {
                    "httpUrl": "https://mcp.exa.ai/mcp",
                    "headers": {
                        "x-api-key": "YOUR_EXA_API_KEY",
                        "x-exa-integration": "k-dense-byok",
                    },
                },
            }
        )
    if os.getenv("PARALLEL_API_KEY"):
        entries.append(
            {
                "name": "parallel-search",
                "spec": {
                    "httpUrl": "https://search-mcp.parallel.ai/mcp",
                    "headers": {"Authorization": "Bearer <redacted>"},
                },
            }
        )
    return entries


async def open_turn(
    *,
    session_id: str,
    user_text: str,
    attachments: Iterable[str] = (),
    model: str | None = None,
    expert_model: str | None = None,
    skills: Iterable[str] = (),
    databases: Iterable[str] = (),
    compute: str | None = None,
) -> tuple[str, dict]:
    """Create a new turn directory and return ``(turn_id, manifest)``.

    Attachments are copied into a content-addressable store keyed by SHA-256
    so replay can rehydrate exactly the bytes the user supplied without
    depending on the mutable sandbox tree.
    """
    paths = _paths()
    sandbox_root = paths.sandbox
    turn_id = ulid()
    turn_dir = paths.runs_dir / session_id / turn_id
    turn_dir.mkdir(parents=True, exist_ok=True)
    attachments_dir = turn_dir / "attachments"

    attachment_records: list[dict] = []
    for rel in attachments:
        if not rel:
            continue
        src = (sandbox_root / rel).resolve()
        try:
            src.relative_to(sandbox_root)
        except ValueError:
            continue
        if not src.is_file():
            continue
        sha = _sha256_file(src)
        if not sha:
            continue
        attachments_dir.mkdir(parents=True, exist_ok=True)
        dest = attachments_dir / sha
        if not dest.is_file():
            try:
                shutil.copy2(src, dest)
            except OSError:
                continue
        attachment_records.append(
            {
                "path": rel,
                "sha256": sha,
                "bytes": src.stat().st_size,
                "storedAt": f"attachments/{sha}",
            }
        )

    prompt_bytes = (user_text or "").encode("utf-8")
    prompt_preview = (user_text or "")[:200]

    manifest = {
        "turnId": turn_id,
        "sessionId": session_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "input": {
            "promptSha256": _sha256_bytes(prompt_bytes),
            "promptPreview": prompt_preview,
            "attachments": attachment_records,
            "databases": list(databases),
            "skills": list(skills),
            "compute": compute,
        },
        "env": {
            "kadyVersion": _kady_version(),
            "kadyCommitSha": _git_sha(),
            "model": model,
            "expertModel": expert_model or model,
            "litellmConfigSha256": _litellm_config_sha(),
            "pythonVersion": platform.python_version(),
            "nodeVersion": _node_version(),
            "geminiCliVersion": _gemini_cli_version(),
            "platform": f"{platform.system().lower()}/{platform.machine()}",
            "mcpServers": _mcp_servers_snapshot(),
            "seed": session_seed(session_id),
        },
        "delegations": [],
        "output": {
            "assistantTextSha256": None,
            "deliverables": [],
            "durationMs": 0,
        },
        "citations": None,
        "startedAt": time.time(),
    }

    _write_json(turn_dir / "manifest.json", manifest)
    return turn_id, manifest


def manifest_path(session_id: str, turn_id: str) -> Path:
    return _paths().runs_dir / session_id / turn_id / "manifest.json"


def read_manifest(session_id: str, turn_id: str) -> dict | None:
    return _read_json(manifest_path(session_id, turn_id))


async def attach_delegation(
    *,
    session_id: str,
    turn_id: str,
    delegation_id: str,
    prompt: str,
    cwd: str,
    result: dict,
    duration_ms: int,
    stdout: str | None = None,
    env_lock: str | None = None,
    deliverables: list[str] | None = None,
) -> None:
    """Append a delegation record to the manifest and persist side files."""
    lock = _manifest_lock(turn_id)
    async with lock:
        turn_dir = _paths().runs_dir / session_id / turn_id
        expert_dir = turn_dir / "expert" / delegation_id
        expert_dir.mkdir(parents=True, exist_ok=True)
        try:
            (expert_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
        except OSError:
            pass
        if stdout:
            try:
                (expert_dir / "stdout.jsonl").write_text(stdout, encoding="utf-8")
            except OSError:
                pass

        env_lock_path: str | None = None
        if env_lock is not None:
            try:
                (expert_dir / "env.lock").write_text(env_lock, encoding="utf-8")
                env_lock_path = f"expert/{delegation_id}/env.lock"
            except OSError:
                pass

        deliverables_list: list[str] | None = None
        if deliverables is not None:
            deliverables_list = list(deliverables)
            try:
                (expert_dir / "deliverables.json").write_text(
                    json.dumps(deliverables_list, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
            except OSError:
                pass

        manifest = _read_json(turn_dir / "manifest.json") or {}
        manifest.setdefault("delegations", []).append(
            {
                "id": delegation_id,
                "prompt": prompt,
                "cwd": cwd,
                "skillsUsed": list(result.get("skills_used", []) or []),
                "toolsUsed": dict(result.get("tools_used", {}) or {}),
                "durationMs": duration_ms,
                "envLockPath": env_lock_path,
                "deliverables": deliverables_list,
                "promptDir": f"expert/{delegation_id}",
            }
        )

        _write_json(turn_dir / "manifest.json", manifest)


async def close_turn(
    *,
    session_id: str,
    turn_id: str,
    assistant_text: str,
    extra: dict | None = None,
) -> dict | None:
    """Finalize the manifest with assistant output and duration."""
    lock = _manifest_lock(turn_id)
    async with lock:
        manifest = _read_json(manifest_path(session_id, turn_id))
        if not manifest:
            return None
        started_at = manifest.get("startedAt") or time.time()
        duration_ms = int((time.time() - started_at) * 1000)
        manifest["output"]["assistantTextSha256"] = _sha256_bytes(
            (assistant_text or "").encode("utf-8")
        )
        manifest["output"]["assistantTextPreview"] = (assistant_text or "")[:500]
        manifest["output"]["durationMs"] = duration_ms
        manifest["output"]["deliverables"] = _enumerate_deliverables(started_at)

        if extra:
            for k, v in extra.items():
                manifest[k] = v

        # Compute manifest hash (excluding its own hash field).
        manifest_copy = {k: v for k, v in manifest.items() if k != "manifestSha256"}
        manifest["manifestSha256"] = _sha256_bytes(
            json.dumps(manifest_copy, sort_keys=True, default=str).encode("utf-8")
        )

        _write_json(manifest_path(session_id, turn_id), manifest)
        return manifest


def _enumerate_deliverables(started_at: float) -> list[str]:
    """List sandbox files modified after the turn started, excluding .kady/."""
    out: list[str] = []
    sandbox_root = _paths().sandbox
    if not sandbox_root.is_dir():
        return out
    for path in sandbox_root.rglob("*"):
        try:
            rel = path.relative_to(sandbox_root)
        except ValueError:
            continue
        if rel.parts and rel.parts[0].startswith("."):
            continue
        if not path.is_file():
            continue
        try:
            if path.stat().st_mtime < started_at - 1.0:
                continue
        except OSError:
            continue
        out.append(str(rel))
    return sorted(out)


def update_manifest(
    session_id: str,
    turn_id: str,
    mutator,
) -> dict | None:
    """Synchronously mutate the manifest on disk. Returns the new manifest.

    ``mutator`` is a callable that receives and may edit the manifest dict.
    """
    path = manifest_path(session_id, turn_id)
    manifest = _read_json(path)
    if not manifest:
        return None
    mutator(manifest)
    _write_json(path, manifest)
    return manifest


def list_turns(session_id: str) -> list[str]:
    session_dir = _paths().runs_dir / session_id
    if not session_dir.is_dir():
        return []
    return sorted(p.name for p in session_dir.iterdir() if p.is_dir())


# Python version for methods-section footnotes.
PYTHON_VERSION = sys.version.split()[0]
