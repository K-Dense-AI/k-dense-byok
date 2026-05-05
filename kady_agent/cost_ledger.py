"""Per-session OpenRouter cost ledger.

Both the orchestrator (ADK + direct LiteLLM) and the expert (Gemini CLI ->
LiteLLM proxy) hit OpenRouter. OpenRouter returns the exact ``usage.cost`` on
every response and LiteLLM normalizes that to ``kwargs["response_cost"]`` in
its callbacks. This module is the shared sink for both callback sites: it
appends one JSONL row per completion into
``<project>/sandbox/.kady/runs/<sessionId>/costs.jsonl`` and provides an
aggregation helper the UI reads through ``GET /sessions/{id}/costs``.

Entries are keyed by the ``X-Kady-*`` correlation headers we stamp onto every
LLM request (see ``agent.py`` and ``tools/gemini_cli.py``). If those headers
are missing (e.g. a completion issued outside an agent turn) the entry is
dropped silently — we don't want to pollute the ledger with orphan rows.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from .projects import resolve_paths
from .tracking import extract_tags_from_headers

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
