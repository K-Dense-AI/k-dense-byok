"""Runtime tracking, provenance, cost ledger, and replay helpers."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import platform
import secrets
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Iterable, Optional, TypedDict

import httpx

from .projects import active_paths, resolve_paths

HEADER_SESSION = "X-Kady-Session-Id"
HEADER_TURN = "X-Kady-Turn-Id"
HEADER_ROLE = "X-Kady-Role"
HEADER_DELEGATION = "X-Kady-Delegation-Id"
HEADER_PROJECT = "X-Kady-Project"

METADATA_SESSION = "kady_session_id"
METADATA_TURN = "kady_turn_id"
METADATA_ROLE = "kady_role"
METADATA_DELEGATION = "kady_delegation_id"
METADATA_PROJECT = "kady_project"


class KadyCostTags(TypedDict):
    session_id: str
    turn_id: str
    role: str
    delegation_id: Optional[str]
    project_id: Optional[str]


def normalize_headers(headers: Any) -> dict[str, str]:
    """Return a lower-cased ``{name: value}`` view of arbitrary header shapes."""
    if not headers:
        return {}
    if isinstance(headers, dict):
        return {str(k).lower(): str(v) for k, v in headers.items() if v is not None}
    try:
        return {
            str(k).lower(): str(v)
            for k, v in headers.items()  # type: ignore[attr-defined]
            if v is not None
        }
    except AttributeError:
        return {}


def extract_tags_from_headers(headers: Any) -> KadyCostTags | None:
    """Pull Kady correlation tags from an HTTP-style header mapping."""
    hmap = normalize_headers(headers)
    session_id = hmap.get(HEADER_SESSION.lower())
    turn_id = hmap.get(HEADER_TURN.lower())
    role = hmap.get(HEADER_ROLE.lower())
    if not (session_id and turn_id and role):
        return None
    return {
        "session_id": session_id,
        "turn_id": turn_id,
        "role": role,
        "delegation_id": hmap.get(HEADER_DELEGATION.lower()),
        "project_id": hmap.get(HEADER_PROJECT.lower()),
    }


def extract_tags_from_metadata(metadata: Any) -> KadyCostTags | None:
    """Pull Kady correlation tags from LiteLLM metadata."""
    if not isinstance(metadata, dict):
        return None
    session_id = metadata.get(METADATA_SESSION)
    turn_id = metadata.get(METADATA_TURN)
    role = metadata.get(METADATA_ROLE)
    if not (session_id and turn_id and role):
        return None
    return {
        "session_id": str(session_id),
        "turn_id": str(turn_id),
        "role": str(role),
        "delegation_id": (
            str(metadata[METADATA_DELEGATION])
            if metadata.get(METADATA_DELEGATION) is not None
            else None
        ),
        "project_id": (
            str(metadata[METADATA_PROJECT])
            if metadata.get(METADATA_PROJECT) is not None
            else None
        ),
    }


def extract_tags_from_litellm_kwargs(kwargs: dict[str, Any]) -> KadyCostTags | None:
    """Extract tags from LiteLLM callback kwargs.

    Prefer metadata because provider paths can drop custom headers from callback
    kwargs. Fall back to the known extra_headers buckets for older paths.
    """
    lparams = kwargs.get("litellm_params") or {}
    metadata = lparams.get("metadata") if isinstance(lparams, dict) else None
    tags = extract_tags_from_metadata(metadata)
    if tags is not None:
        return tags

    optional = kwargs.get("optional_params") or {}
    headers = optional.get("extra_headers") if isinstance(optional, dict) else None
    if not headers and isinstance(lparams, dict):
        headers = lparams.get("extra_headers")
    return extract_tags_from_headers(headers)


def build_tracking_headers(
    *,
    role: str,
    project_id: str | None,
    session_id: str | None = None,
    turn_id: str | None = None,
    delegation_id: str | None = None,
) -> dict[str, str]:
    """Build canonical ``X-Kady-*`` headers for LLM requests."""
    headers = {HEADER_ROLE: role}
    if project_id:
        headers[HEADER_PROJECT] = project_id
    if session_id:
        headers[HEADER_SESSION] = session_id
    if turn_id:
        headers[HEADER_TURN] = turn_id
    if delegation_id:
        headers[HEADER_DELEGATION] = delegation_id
    return headers


def build_tracking_metadata(
    *,
    role: str,
    project_id: str | None,
    session_id: str | None = None,
    turn_id: str | None = None,
    delegation_id: str | None = None,
) -> dict[str, str]:
    """Build canonical LiteLLM metadata for Kady tracking tags."""
    metadata = {METADATA_ROLE: role}
    if project_id:
        metadata[METADATA_PROJECT] = project_id
    if session_id:
        metadata[METADATA_SESSION] = session_id
    if turn_id:
        metadata[METADATA_TURN] = turn_id
    if delegation_id:
        metadata[METADATA_DELEGATION] = delegation_id
    return metadata


logger = logging.getLogger(__name__)

def extract_cost_tags(headers: Any) -> Optional[dict[str, Optional[str]]]:
    """Pull the correlation tags out of an extra_headers mapping.

    Returns ``None`` when the mandatory session/turn/role triplet is absent —
    callers should treat that as "not a Kady-orchestrated call" and skip.
    """
    return extract_tags_from_headers(headers)


def _coerce_usage_dict(usage: Any) -> dict[str, Any]:
    """Best-effort convert a LiteLLM/OpenAI usage object to a plain dict."""
    if usage is None:
        return {}
    if isinstance(usage, dict):
        return usage
    if hasattr(usage, "model_dump"):
        try:
            return usage.model_dump()
        except Exception:  # noqa: BLE001
            return {}
    if hasattr(usage, "__dict__"):
        return {k: v for k, v in vars(usage).items() if not k.startswith("_")}
    return {}


def _extract_cached_tokens(usage_dict: dict[str, Any]) -> int:
    """Mirror of ADK's extract: cached tokens can live in several shapes."""
    details = usage_dict.get("prompt_tokens_details")
    if isinstance(details, dict):
        value = details.get("cached_tokens")
        if isinstance(value, int):
            return value
    for key in ("cached_prompt_tokens", "cached_tokens"):
        value = usage_dict.get(key)
        if isinstance(value, int):
            return value
    return 0


def _extract_reasoning_tokens(usage_dict: dict[str, Any]) -> int:
    details = usage_dict.get("completion_tokens_details")
    if isinstance(details, dict):
        value = details.get("reasoning_tokens")
        if isinstance(value, int):
            return value
    return 0


def _ledger_path(session_id: str, project_id: Optional[str]) -> Path:
    """Resolve ``<project>/sandbox/.kady/runs/<sessionId>/costs.jsonl``."""
    paths = resolve_paths(project_id or "")
    target = paths.runs_dir / session_id / "costs.jsonl"
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def record_cost(
    *,
    session_id: str,
    turn_id: str,
    role: str,
    model: Optional[str],
    usage_dict: Any,
    cost_usd: Optional[float],
    delegation_id: Optional[str] = None,
    project_id: Optional[str] = None,
) -> Optional[str]:
    """Append one completion row to the session ledger.

    ``cost_usd`` may be ``None`` when a provider does not report a cost (e.g.
    Ollama, or streaming OpenRouter responses where cost is resolved out-of-
    band). In that case we still record the row with ``costUsd: 0`` so the
    UI can show token counts immediately; aggregation treats 0 as free.

    Returns the generated ``entryId`` so callers can update this row later
    via :func:`update_cost_entry` once authoritative cost becomes available.
    """
    if not session_id or not turn_id or not role:
        return None

    if not model or not isinstance(model, str):
        return None

    udict = _coerce_usage_dict(usage_dict)
    prompt_tokens = int(udict.get("prompt_tokens") or 0)
    completion_tokens = int(udict.get("completion_tokens") or 0)
    total_tokens = int(udict.get("total_tokens") or (prompt_tokens + completion_tokens))
    cached_tokens = _extract_cached_tokens(udict)
    reasoning_tokens = _extract_reasoning_tokens(udict)

    entry_id = uuid.uuid4().hex
    entry = {
        "entryId": entry_id,
        "ts": time.time(),
        "sessionId": session_id,
        "turnId": turn_id,
        "role": role,
        "delegationId": delegation_id,
        "model": model,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": total_tokens,
        "cachedTokens": cached_tokens,
        "reasoningTokens": reasoning_tokens,
        "costUsd": float(cost_usd) if cost_usd is not None else 0.0,
        "costPending": cost_usd is None,
    }

    try:
        path = _ledger_path(session_id, project_id)
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        # Single write() on an append-opened file is atomic for short lines on
        # POSIX filesystems, which is enough for concurrent orchestrator +
        # proxy processes to coexist without a lock file.
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
        return entry_id
    except OSError as exc:
        logger.warning("Failed to append cost ledger entry: %s", exc)
        return None


def update_cost_entry(
    *,
    session_id: str,
    entry_id: str,
    cost_usd: float,
    project_id: Optional[str] = None,
) -> bool:
    """Rewrite the ledger with ``entry_id``'s cost updated.

    Used when an async backfill (e.g. OpenRouter's ``/generation`` endpoint)
    resolves cost after :func:`record_cost` has already persisted the row
    with a placeholder ``$0``. Quiet no-op when the file or entry is
    missing. Returns ``True`` if the entry was found and rewritten.
    """
    if not session_id or not entry_id:
        return False
    try:
        path = _ledger_path(session_id, project_id)
    except (OSError, ValueError):
        return False
    if not path.is_file():
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError as exc:
        logger.warning("Failed to read cost ledger %s for update: %s", path, exc)
        return False

    updated = False
    rewritten: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            rewritten.append(line)
            continue
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError:
            rewritten.append(line)
            continue
        if isinstance(entry, dict) and entry.get("entryId") == entry_id:
            entry["costUsd"] = float(cost_usd)
            entry["costPending"] = False
            rewritten.append(json.dumps(entry, ensure_ascii=False) + "\n")
            updated = True
        else:
            rewritten.append(line if line.endswith("\n") else line + "\n")

    if not updated:
        return False

    tmp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.writelines(rewritten)
        os.replace(tmp_path, path)
    except OSError as exc:
        logger.warning("Failed to rewrite cost ledger %s: %s", path, exc)
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        return False
    return True


def _empty_project_summary(project_id: str) -> dict[str, Any]:
    return {
        "projectId": project_id,
        "totalUsd": 0.0,
        "orchestratorUsd": 0.0,
        "expertUsd": 0.0,
        "totalTokens": 0,
        "orchestratorTokens": 0,
        "expertTokens": 0,
        "sessionCount": 0,
        "hasPending": False,
        "bySession": {},
    }


def read_project_costs(project_id: str) -> dict[str, Any]:
    """Aggregate every session's ``costs.jsonl`` under one project.

    Walks ``<project>/sandbox/.kady/runs/<sessionId>/costs.jsonl`` for every
    session directory. ``entryId``-level rows are not echoed back (the
    session endpoint does that per-session); instead the caller gets a
    compact ``bySession`` map keyed by session id for any UI that wants
    to drill down.
    """
    summary = _empty_project_summary(project_id or "")
    try:
        paths = resolve_paths(project_id or "")
    except (OSError, ValueError):
        return summary
    if not paths.runs_dir.is_dir():
        return summary

    session_ids: list[str] = []
    try:
        for child in paths.runs_dir.iterdir():
            if child.is_dir() and (child / "costs.jsonl").is_file():
                session_ids.append(child.name)
    except OSError as exc:
        logger.warning("Failed to list runs dir %s: %s", paths.runs_dir, exc)
        return summary

    by_session: dict[str, dict[str, Any]] = {}
    any_pending = False
    for sid in session_ids:
        session_summary = read_costs(sid, project_id=project_id)
        total_usd = float(session_summary.get("totalUsd") or 0.0)
        total_tokens = int(session_summary.get("totalTokens") or 0)
        orch_usd = float(session_summary.get("orchestratorUsd") or 0.0)
        orch_tok = int(session_summary.get("orchestratorTokens") or 0)
        exp_usd = float(session_summary.get("expertUsd") or 0.0)
        exp_tok = int(session_summary.get("expertTokens") or 0)
        pending = any(
            bool(e.get("costPending")) for e in session_summary.get("entries", [])
        )
        if pending:
            any_pending = True
        if total_usd == 0.0 and total_tokens == 0 and not pending:
            # Skip sessions that never produced a cost row (e.g. Ollama-only
            # or orphan dirs). They'd still inflate sessionCount otherwise.
            continue
        by_session[sid] = {
            "sessionId": sid,
            "totalUsd": total_usd,
            "totalTokens": total_tokens,
            "orchestratorUsd": orch_usd,
            "expertUsd": exp_usd,
            "hasPending": pending,
        }
        summary["totalUsd"] += total_usd
        summary["totalTokens"] += total_tokens
        summary["orchestratorUsd"] += orch_usd
        summary["orchestratorTokens"] += orch_tok
        summary["expertUsd"] += exp_usd
        summary["expertTokens"] += exp_tok

    summary["sessionCount"] = len(by_session)
    summary["bySession"] = by_session
    summary["hasPending"] = any_pending
    return summary


def check_project_budget(
    project_id: str, limit_usd: Optional[float]
) -> dict[str, Any]:
    """Classify a project's current spend against a hard cap.

    ``state`` is one of ``"ok"`` (< 80% of limit, or no limit set),
    ``"warn"`` (>= 80% and < 100%), or ``"exceeded"`` (>= 100%). ``ratio``
    is ``totalUsd / limitUsd`` when a limit is set and otherwise ``None``
    so the UI can render "proj $X.XX" without a denominator.
    """
    project_summary = read_project_costs(project_id)
    total = float(project_summary.get("totalUsd") or 0.0)
    if limit_usd is None or limit_usd <= 0:
        return {
            "totalUsd": total,
            "limitUsd": None,
            "ratio": None,
            "state": "ok",
        }
    ratio = total / float(limit_usd)
    if ratio >= 1.0:
        state = "exceeded"
    elif ratio >= 0.8:
        state = "warn"
    else:
        state = "ok"
    return {
        "totalUsd": total,
        "limitUsd": float(limit_usd),
        "ratio": ratio,
        "state": state,
    }


def _empty_summary(session_id: str) -> dict[str, Any]:
    return {
        "sessionId": session_id,
        "totalUsd": 0.0,
        "orchestratorUsd": 0.0,
        "expertUsd": 0.0,
        "totalTokens": 0,
        "orchestratorTokens": 0,
        "expertTokens": 0,
        "entries": [],
        "byTurn": {},
    }


def read_costs(session_id: str, project_id: Optional[str] = None) -> dict[str, Any]:
    """Aggregate the ledger into totals the UI can render directly.

    Returns an empty summary when no ledger exists yet. ``byTurn`` keys are
    turn ids; each value has orchestrator/expert subtotals plus the raw
    entries for that turn.
    """
    summary = _empty_summary(session_id)
    try:
        path = _ledger_path(session_id, project_id)
    except (OSError, ValueError):
        return summary
    if not path.is_file():
        return summary

    try:
        with open(path, "r", encoding="utf-8") as f:
            raw_lines = f.readlines()
    except OSError as exc:
        logger.warning("Failed to read cost ledger %s: %s", path, exc)
        return summary

    by_turn: dict[str, dict[str, Any]] = {}
    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue

        cost = float(entry.get("costUsd") or 0.0)
        tokens = int(entry.get("totalTokens") or 0)
        role = str(entry.get("role") or "")
        turn_id = str(entry.get("turnId") or "")

        summary["totalUsd"] += cost
        summary["totalTokens"] += tokens
        if role == "orchestrator":
            summary["orchestratorUsd"] += cost
            summary["orchestratorTokens"] += tokens
        elif role == "expert":
            summary["expertUsd"] += cost
            summary["expertTokens"] += tokens
        summary["entries"].append(entry)

        if turn_id:
            bucket = by_turn.setdefault(
                turn_id,
                {
                    "turnId": turn_id,
                    "totalUsd": 0.0,
                    "orchestratorUsd": 0.0,
                    "expertUsd": 0.0,
                    "totalTokens": 0,
                    "entries": [],
                },
            )
            bucket["totalUsd"] += cost
            bucket["totalTokens"] += tokens
            if role == "orchestrator":
                bucket["orchestratorUsd"] += cost
            elif role == "expert":
                bucket["expertUsd"] += cost
            bucket["entries"].append(entry)

    summary["byTurn"] = by_turn
    return summary


__all__ = [
    "check_project_budget",
    "extract_cost_tags",
    "read_costs",
    "read_project_costs",
    "record_cost",
    "update_cost_entry",
]


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
    from .mcp import build_default_settings, load_custom_mcps

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


def _replays_dir() -> Path:
    return active_paths().kady_dir / "replays"


def _runs_dir() -> Path:
    return active_paths().runs_dir


def _rehydrate_attachments(
    *,
    manifest: dict,
    replay_sandbox: Path,
) -> list[str]:
    """Copy each attachment from content-addressable storage into replay_sandbox.

    Returns the relative paths that were successfully restored.
    """
    restored: list[str] = []
    session_id = manifest["sessionId"]
    turn_id = manifest["turnId"]
    original_turn_dir = _runs_dir() / session_id / turn_id
    for att in manifest.get("input", {}).get("attachments", []):
        sha = att.get("sha256")
        rel = att.get("path")
        if not sha or not rel:
            continue
        src = original_turn_dir / "attachments" / sha
        if not src.is_file():
            continue
        dest = replay_sandbox / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(src, dest)
            restored.append(rel)
        except OSError:
            continue
    return restored


async def replay_turn(
    *,
    session_id: str,
    turn_id: str,
    replay_id: str,
) -> AsyncIterator[dict]:
    """Replay a single turn. Yields progress events suitable for SSE streaming.

    Events yielded:
        {"event": "replay_turn_start", ...}
        {"event": "delegation_start", ...}
        {"event": "delegation_complete", ...}
        {"event": "replay_turn_complete", ...}
        {"event": "replay_error", ...}
    """
    original = read_manifest(session_id, turn_id)
    if not original:
        yield {"event": "replay_error", "detail": f"manifest not found: {turn_id}"}
        return

    replays_dir = _replays_dir()
    new_turn_id = ulid()
    replay_sandbox = replays_dir / replay_id / new_turn_id
    replay_sandbox.mkdir(parents=True, exist_ok=True)

    restored = _rehydrate_attachments(
        manifest=original, replay_sandbox=replay_sandbox
    )

    new_manifest: dict[str, Any] = {
        "turnId": new_turn_id,
        "sessionId": f"replay-{replay_id}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "replayedFrom": {
            "sessionId": original["sessionId"],
            "turnId": original["turnId"],
            "manifestSha256": original.get("manifestSha256"),
        },
        "input": {
            "promptSha256": original["input"]["promptSha256"],
            "promptPreview": original["input"]["promptPreview"],
            "attachments": original["input"]["attachments"],
            "restoredAttachments": restored,
            "databases": original["input"]["databases"],
            "skills": original["input"]["skills"],
            "compute": original["input"]["compute"],
        },
        "env": dict(original.get("env", {})),
        "delegations": [],
        "output": {"deliverables": [], "durationMs": 0},
        "startedAt": time.time(),
    }

    replay_turn_dir = replays_dir / replay_id / "runs" / new_turn_id
    replay_turn_dir.mkdir(parents=True, exist_ok=True)
    _write_json(replay_turn_dir / "manifest.json", new_manifest)

    yield {
        "event": "replay_turn_start",
        "replayId": replay_id,
        "newTurnId": new_turn_id,
        "originalTurnId": turn_id,
        "restoredAttachments": restored,
        "delegationCount": len(original.get("delegations", [])),
    }

    for original_delegation in original.get("delegations", []):
        prompt = original_delegation.get("prompt", "")
        if not prompt:
            continue
        delegation_id = original_delegation.get("id", uuid.uuid4().hex[:8])

        yield {
            "event": "delegation_start",
            "originalDelegationId": delegation_id,
            "promptPreview": prompt[:200],
        }

        started = time.time()
        try:
            # We deliberately do not pass tool_context here: we want the
            # delegation to execute in the replay sandbox with the recorded
            # seed, not to mutate the live session state.
            from os import environ

            environ["KADY_SEED"] = original["env"].get("seed", "")
            environ["KADY_REPLAY_TURN_ID"] = new_turn_id
            environ["KADY_REPLAY_SESSION_ID"] = f"replay-{replay_id}"
            environ["KADY_DELEGATION_ID"] = delegation_id
            from .tools.gemini_cli import delegate_task

            result = await delegate_task(
                prompt=prompt,
                working_directory=str(replay_sandbox),
            )
        except Exception as exc:
            yield {
                "event": "replay_error",
                "delegationId": delegation_id,
                "detail": str(exc),
            }
            new_manifest["delegations"].append(
                {
                    "id": delegation_id,
                    "prompt": prompt,
                    "error": str(exc),
                    "durationMs": int((time.time() - started) * 1000),
                }
            )
            _write_json(replay_turn_dir / "manifest.json", new_manifest)
            continue

        duration_ms = int((time.time() - started) * 1000)
        delegation_record = {
            "id": delegation_id,
            "prompt": prompt,
            "cwd": str(replay_sandbox),
            "skillsUsed": result.get("skills_used", []),
            "toolsUsed": result.get("tools_used", {}),
            "durationMs": duration_ms,
            "resultPreview": (result.get("result") or "")[:500],
        }
        new_manifest["delegations"].append(delegation_record)
        _write_json(replay_turn_dir / "manifest.json", new_manifest)

        yield {
            "event": "delegation_complete",
            "delegationId": delegation_id,
            "durationMs": duration_ms,
            "skillsUsed": delegation_record["skillsUsed"],
            "resultPreview": delegation_record["resultPreview"],
        }

    new_manifest["output"]["durationMs"] = int(
        (time.time() - new_manifest["startedAt"]) * 1000
    )
    _write_json(replay_turn_dir / "manifest.json", new_manifest)

    yield {
        "event": "replay_turn_complete",
        "replayId": replay_id,
        "newTurnId": new_turn_id,
        "originalTurnId": turn_id,
        "durationMs": new_manifest["output"]["durationMs"],
        "diff": _diff_summary(original, new_manifest),
    }


def _diff_summary(original: dict, replayed: dict) -> dict:
    """Compact diff summary the UI can show next to the replay header.

    Compares input hashes, output hashes (if present), and citation counts.
    """
    def _citations(m: dict) -> tuple[int, int, int]:
        c = m.get("citations") or {}
        return (
            int(c.get("total", 0)),
            int(c.get("verified", 0)),
            int(c.get("unresolved", 0)),
        )

    return {
        "inputHashMatch": original.get("input", {}).get("promptSha256")
        == replayed.get("input", {}).get("promptSha256"),
        "delegationsOriginal": len(original.get("delegations", [])),
        "delegationsReplayed": len(replayed.get("delegations", [])),
        "citationsOriginal": _citations(original),
    }


async def replay_session(
    *,
    session_id: str,
    turn_ids: list[str] | None = None,
) -> AsyncIterator[dict]:
    """Replay every turn (or the given ``turn_ids``) for a session."""
    replay_id = ulid()
    if turn_ids is None:
        turn_ids = list_turns(session_id)

    yield {
        "event": "replay_session_start",
        "replayId": replay_id,
        "sessionId": session_id,
        "turnIds": turn_ids,
    }

    for turn_id in turn_ids:
        async for event in replay_turn(
            session_id=session_id, turn_id=turn_id, replay_id=replay_id
        ):
            yield event

    yield {"event": "replay_session_complete", "replayId": replay_id}
