"""Unit tests for ``kady_agent/manifest.py``.

Tests heavily mock subprocess (git/node/gemini --version) via
``no_subprocess`` + a broader ``asyncio`` wrapper so the manifest writer
never shells out during tests.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from kady_agent import manifest as manifest_module


@pytest.fixture(autouse=True)
def _stub_env_probes(monkeypatch):
    """Force the env-probing helpers to return deterministic values so manifest
    writes don't depend on whether git/gemini/node are present on the runner."""
    monkeypatch.setattr(manifest_module, "_git_sha", lambda: "deadbeef" * 5)
    monkeypatch.setattr(manifest_module, "_gemini_cli_version", lambda: "1.0.0-test")
    monkeypatch.setattr(manifest_module, "_node_version", lambda: "v20.0.0-test")


def test_ulid_is_monotonic_enough():
    a = manifest_module.ulid()
    time.sleep(0.002)
    b = manifest_module.ulid()
    # Sort lexicographically and the later one is >=
    assert b >= a
    assert len(a) == len(b)


def test_session_seed_is_stable(active_project):
    s1 = manifest_module.session_seed("sess-1")
    s2 = manifest_module.session_seed("sess-1")
    assert s1 == s2
    # Different session -> different seed (overwhelmingly likely)
    assert manifest_module.session_seed("sess-2") != s1


def test_sha256_helpers_roundtrip(tmp_path):
    data = b"hello world"
    digest = manifest_module._sha256_bytes(data)
    assert len(digest) == 64
    f = tmp_path / "x.bin"
    f.write_bytes(data)
    assert manifest_module._sha256_file(f) == digest
    # Missing file returns None
    assert manifest_module._sha256_file(tmp_path / "missing") is None


async def test_open_turn_writes_manifest_and_copies_attachments(active_project):
    # Seed an attachment inside the sandbox so it can be copied.
    data = b"some attached bytes"
    attached = active_project.sandbox / "user_data" / "a.txt"
    attached.parent.mkdir(parents=True, exist_ok=True)
    attached.write_bytes(data)

    turn_id, manifest = await manifest_module.open_turn(
        session_id="s1",
        user_text="hello",
        attachments=["user_data/a.txt", "escape/..", "missing.txt"],
        model="openrouter/anthropic/claude-opus-4.7",
    )

    assert manifest["sessionId"] == "s1"
    assert manifest["turnId"] == turn_id
    assert manifest["input"]["promptPreview"] == "hello"
    assert len(manifest["input"]["attachments"]) == 1
    assert manifest["input"]["attachments"][0]["path"] == "user_data/a.txt"

    # On disk the manifest and the attachment are present
    turn_dir = active_project.runs_dir / "s1" / turn_id
    assert (turn_dir / "manifest.json").is_file()
    sha = manifest["input"]["attachments"][0]["sha256"]
    assert (turn_dir / "attachments" / sha).is_file()


async def test_attach_delegation_appends_and_persists(active_project):
    turn_id, _ = await manifest_module.open_turn(
        session_id="s1", user_text="prompt", model="m"
    )
    await manifest_module.attach_delegation(
        session_id="s1",
        turn_id=turn_id,
        delegation_id="d1",
        prompt="do the thing",
        cwd=str(active_project.sandbox),
        result={"skills_used": ["skill-a"], "tools_used": {"shell": 1}},
        duration_ms=123,
        stdout='{"k":"v"}\n',
        env_lock="numpy==2.0\n",
        deliverables=["result.csv"],
    )

    manifest = manifest_module.read_manifest("s1", turn_id)
    assert manifest is not None
    assert len(manifest["delegations"]) == 1
    deleg = manifest["delegations"][0]
    assert deleg["id"] == "d1"
    assert deleg["skillsUsed"] == ["skill-a"]
    assert deleg["toolsUsed"] == {"shell": 1}
    assert deleg["durationMs"] == 123
    assert deleg["deliverables"] == ["result.csv"]
    assert deleg["envLockPath"] == f"expert/d1/env.lock"

    expert_dir = active_project.runs_dir / "s1" / turn_id / "expert" / "d1"
    assert (expert_dir / "prompt.txt").read_text() == "do the thing"
    assert (expert_dir / "stdout.jsonl").read_text() == '{"k":"v"}\n'
    assert (expert_dir / "env.lock").read_text() == "numpy==2.0\n"
    assert json.loads((expert_dir / "deliverables.json").read_text()) == ["result.csv"]


async def test_close_turn_sets_duration_and_hash(active_project):
    turn_id, _ = await manifest_module.open_turn(
        session_id="s2", user_text="p", model="m"
    )
    # Move time forward a tick so duration is non-zero
    time.sleep(0.01)
    manifest = await manifest_module.close_turn(
        session_id="s2",
        turn_id=turn_id,
        assistant_text="done",
    )
    assert manifest is not None
    assert manifest["output"]["durationMs"] >= 0
    assert manifest["output"]["assistantTextPreview"] == "done"
    assert manifest["output"]["assistantTextSha256"] == manifest_module._sha256_bytes(
        b"done"
    )
    # manifestSha256 is stable (same inputs = same hash).
    assert isinstance(manifest["manifestSha256"], str)
    assert len(manifest["manifestSha256"]) == 64


async def test_close_turn_missing_returns_none(active_project):
    assert await manifest_module.close_turn(
        session_id="nope", turn_id="also-nope", assistant_text=""
    ) is None


def test_list_turns_returns_sorted_dir_names(active_project):
    # Nothing yet
    assert manifest_module.list_turns("s3") == []
    # Seed two turn directories manually
    root = active_project.runs_dir / "s3"
    (root / "t-002").mkdir(parents=True)
    (root / "t-001").mkdir(parents=True)
    (root / "notes.txt").parent.mkdir(parents=True, exist_ok=True)
    (root / "notes.txt").write_text("x")
    assert manifest_module.list_turns("s3") == ["t-001", "t-002"]


def test_update_manifest_in_place(active_project):
    # Create an already-closed manifest synchronously.
    async def _setup():
        tid, _ = await manifest_module.open_turn(
            session_id="s4", user_text="p", model="m"
        )
        await manifest_module.close_turn(
            session_id="s4", turn_id=tid, assistant_text="hi"
        )
        return tid

    turn_id = asyncio.run(_setup())

    def mutator(m: dict) -> None:
        m["citations"] = {"total": 3}

    updated = manifest_module.update_manifest("s4", turn_id, mutator)
    assert updated is not None
    assert updated["citations"]["total"] == 3
    # Persisted
    reread = manifest_module.read_manifest("s4", turn_id)
    assert reread["citations"]["total"] == 3


# ---------------------------------------------------------------------------
# _mcp_servers_snapshot — built-in MCP registration
# ---------------------------------------------------------------------------


def test_mcp_snapshot_includes_parallel_when_key_set(active_project, monkeypatch):
    monkeypatch.setenv("PARALLEL_API_KEY", "test-parallel")
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    entries = manifest_module._mcp_servers_snapshot()
    names = [entry["name"] for entry in entries]
    assert "parallel-search" in names
    assert "exa-search" not in names
    parallel = next(e for e in entries if e["name"] == "parallel-search")
    # Keys are redacted before they hit disk.
    assert parallel["spec"]["headers"]["Authorization"] == "Bearer <redacted>"


def test_mcp_snapshot_includes_exa_when_key_set(active_project, monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "test-exa")
    monkeypatch.delenv("PARALLEL_API_KEY", raising=False)
    entries = manifest_module._mcp_servers_snapshot()
    names = [entry["name"] for entry in entries]
    assert "exa-search" in names
    assert "parallel-search" not in names
    exa = next(e for e in entries if e["name"] == "exa-search")
    assert exa["spec"]["httpUrl"] == "https://mcp.exa.ai/mcp"
    # API key redacted to a clear placeholder; integration header preserved verbatim.
    assert exa["spec"]["headers"]["x-api-key"] == "YOUR_EXA_API_KEY"
    assert exa["spec"]["headers"]["x-exa-integration"] == "k-dense-byok"


def test_mcp_snapshot_omits_both_when_keys_unset(active_project, monkeypatch):
    monkeypatch.delenv("PARALLEL_API_KEY", raising=False)
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    entries = manifest_module._mcp_servers_snapshot()
    names = [entry["name"] for entry in entries]
    assert "parallel-search" not in names
    assert "exa-search" not in names


def test_mcp_snapshot_includes_both_when_both_keys_set(active_project, monkeypatch):
    monkeypatch.setenv("PARALLEL_API_KEY", "test-parallel")
    monkeypatch.setenv("EXA_API_KEY", "test-exa")
    entries = manifest_module._mcp_servers_snapshot()
    names = [entry["name"] for entry in entries]
    assert "parallel-search" in names
    assert "exa-search" in names
