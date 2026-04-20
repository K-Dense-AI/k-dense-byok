"""Shared pytest fixtures for the Kady test suite.

Key goals:

* Every filesystem-touching test operates under a fresh ``tmp_path`` rooted
  PROJECTS_ROOT so tests never pollute the real ``projects/`` tree.
* Every test that would otherwise fork a subprocess (``uv sync``, ``git``,
  ``gemini``, ``node``, ``latexmk``, ``uvx browser-use install`` ...) either
  gets an allow-list-only recorder via ``no_subprocess`` or mocks the
  specific call site.
* Every test that would otherwise issue a LiteLLM completion gets a stubbed
  ``litellm.acompletion`` via ``no_litellm``.
* ``asgi_client`` constructs an in-process ``httpx.AsyncClient`` bound to
  ``server:app`` so integration tests can hit FastAPI endpoints without a
  real network bind.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

import pytest


# ---------------------------------------------------------------------------
# Core project-scoped fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_projects_root(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Redirect ``kady_agent.projects.PROJECTS_ROOT`` at ``tmp_path``.

    Every module that derives paths via ``resolve_paths`` / ``active_paths``
    reads the module-level ``PROJECTS_ROOT`` at call time, so a single
    monkeypatch here scopes all project I/O into the temp tree for the
    duration of the test.
    """
    import kady_agent.projects as projects_module

    projects_dir = (tmp_path / "projects").resolve()
    projects_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(projects_module, "PROJECTS_ROOT", projects_dir)
    monkeypatch.setattr(
        projects_module, "INDEX_PATH", projects_dir / "index.json"
    )
    return projects_dir


@pytest.fixture
def active_project(
    tmp_projects_root: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Any]:
    """Create a project under the temp root and set it active.

    Yields a ``ProjectPaths`` object; the ContextVar token is reset on
    teardown so concurrent tests can't bleed into each other's project.
    """
    from kady_agent import projects as projects_module

    meta = projects_module.create_project(name="Test Project", project_id="test-project")
    paths = projects_module.ensure_project_exists(meta.id)
    token = projects_module.set_active_project(meta.id)
    try:
        yield paths
    finally:
        projects_module.ACTIVE_PROJECT.reset(token)


# ---------------------------------------------------------------------------
# Side-effect guards
# ---------------------------------------------------------------------------


class _SubprocessRecorder:
    """Records arguments and returns a stub ``CompletedProcess`` / Popen-ish object."""

    def __init__(self) -> None:
        self.calls: list[tuple[tuple, dict]] = []
        self.returncode: int = 0
        self.stdout: str = ""
        self.stderr: str = ""

    def sync(self, *args: Any, **kwargs: Any) -> Any:
        self.calls.append((args, kwargs))
        result = types.SimpleNamespace(
            args=args[0] if args else None,
            returncode=self.returncode,
            stdout=self.stdout,
            stderr=self.stderr,
        )
        return result


@pytest.fixture
def no_subprocess(monkeypatch: pytest.MonkeyPatch) -> _SubprocessRecorder:
    """Replace ``subprocess.run`` with a recorder that never forks a process.

    Returns the recorder so tests can assert on the argv list. Async
    subprocess callers (``asyncio.create_subprocess_exec``) are handled
    per-test because their return values are more varied.
    """
    import subprocess

    recorder = _SubprocessRecorder()
    monkeypatch.setattr(subprocess, "run", recorder.sync)
    return recorder


@pytest.fixture
def no_litellm(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Stub ``litellm.acompletion`` so server tests don't hit real providers.

    Tests set ``state["response"]`` before they issue the request to
    customise what the stub returns.
    """
    import litellm

    state: dict[str, Any] = {
        "calls": [],
        "response": types.SimpleNamespace(
            choices=[
                types.SimpleNamespace(
                    message=types.SimpleNamespace(content="stub revised text")
                )
            ],
            usage=types.SimpleNamespace(prompt_tokens=5, completion_tokens=3, total_tokens=8),
        ),
    }

    async def fake_acompletion(**kwargs: Any) -> Any:
        state["calls"].append(kwargs)
        return state["response"]

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    return state


# ---------------------------------------------------------------------------
# FastAPI in-process client
# ---------------------------------------------------------------------------


@pytest.fixture
async def asgi_client(
    active_project: Any,
    no_litellm: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[Any]:
    """Return an httpx.AsyncClient bound to server.app via ASGITransport."""
    from httpx import ASGITransport, AsyncClient

    import server as server_module

    transport = ASGITransport(app=server_module.app)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-Project-Id": active_project.id},
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# Ensure repo root on sys.path
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True, scope="session")
def _repo_root_on_syspath() -> None:
    root = str(Path(__file__).resolve().parents[1])
    if root not in sys.path:
        sys.path.insert(0, root)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def make_cost_entry():
    """Build a cost-ledger row dict for tests."""
    def _make(**overrides: Any) -> dict:
        base = {
            "entryId": "e1",
            "ts": 1700000000.0,
            "sessionId": "sess-1",
            "turnId": "turn-1",
            "role": "orchestrator",
            "delegationId": None,
            "model": "openrouter/anthropic/claude-opus-4.7",
            "promptTokens": 100,
            "completionTokens": 50,
            "totalTokens": 150,
            "cachedTokens": 0,
            "reasoningTokens": 0,
            "costUsd": 0.01,
            "costPending": False,
        }
        base.update(overrides)
        return base

    return _make


@pytest.fixture
def write_ledger(active_project):
    """Write a costs.jsonl file directly under the active project."""
    def _write(session_id: str, entries: list[dict]) -> Path:
        ledger_dir = active_project.runs_dir / session_id
        ledger_dir.mkdir(parents=True, exist_ok=True)
        ledger = ledger_dir / "costs.jsonl"
        ledger.write_text(
            "\n".join(json.dumps(e) for e in entries) + "\n",
            encoding="utf-8",
        )
        return ledger

    return _write
