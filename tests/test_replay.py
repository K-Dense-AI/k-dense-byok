"""Unit tests for ``kady_agent/replay.py``.

We stub ``delegate_task`` with a canned async result so tests never hit
gemini CLI. Focus on:

* Attachment rehydration copies bytes out of the content-addressable store.
* ``replay_turn`` emits start/delegation/complete events in order.
* ``_diff_summary`` shape.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from kady_agent import replay as replay_module
from kady_agent import manifest as manifest_module


async def _seed_turn_with_attachment(active_project) -> tuple[str, str]:
    """Create a turn with one attachment and one recorded delegation."""
    att = active_project.sandbox / "user_data" / "input.txt"
    att.parent.mkdir(parents=True, exist_ok=True)
    att.write_bytes(b"source data")

    turn_id, _ = await manifest_module.open_turn(
        session_id="sess",
        user_text="run analysis",
        attachments=["user_data/input.txt"],
        model="m",
    )
    await manifest_module.attach_delegation(
        session_id="sess",
        turn_id=turn_id,
        delegation_id="001",
        prompt="do work",
        cwd=str(active_project.sandbox),
        result={"skills_used": ["scanpy"], "tools_used": {"shell": 1}},
        duration_ms=42,
    )
    await manifest_module.close_turn(
        session_id="sess", turn_id=turn_id, assistant_text="ok"
    )
    return "sess", turn_id


async def test_replay_turn_rehydrates_attachments_and_emits_events(
    active_project, monkeypatch
):
    session_id, turn_id = await _seed_turn_with_attachment(active_project)

    async def fake_delegate(prompt, working_directory=None, tool_context=None):
        # Also drop a synthetic deliverable into the replay sandbox.
        cwd = Path(working_directory) if working_directory else active_project.sandbox
        (cwd / "out.txt").write_text("replayed output", encoding="utf-8")
        return {"result": "replayed", "skills_used": ["scanpy"], "tools_used": {"shell": 1}}

    monkeypatch.setattr(replay_module, "delegate_task", fake_delegate)

    events = []
    async for ev in replay_module.replay_turn(
        session_id=session_id, turn_id=turn_id, replay_id="RPL"
    ):
        events.append(ev)

    kinds = [e["event"] for e in events]
    assert kinds[0] == "replay_turn_start"
    assert "delegation_start" in kinds
    assert "delegation_complete" in kinds
    assert kinds[-1] == "replay_turn_complete"

    start = events[0]
    assert start["restoredAttachments"] == ["user_data/input.txt"]
    assert start["delegationCount"] == 1

    complete = events[-1]
    assert complete["originalTurnId"] == turn_id
    assert complete["diff"]["inputHashMatch"] is True
    assert complete["diff"]["delegationsReplayed"] == 1


async def test_replay_turn_emits_error_when_manifest_missing(active_project, monkeypatch):
    events = []
    async for ev in replay_module.replay_turn(
        session_id="nope", turn_id="nope", replay_id="R"
    ):
        events.append(ev)
    assert len(events) == 1
    assert events[0]["event"] == "replay_error"


async def test_replay_turn_records_error_on_delegate_failure(active_project, monkeypatch):
    session_id, turn_id = await _seed_turn_with_attachment(active_project)

    async def failing_delegate(*a, **kw):
        raise RuntimeError("expert crashed")

    monkeypatch.setattr(replay_module, "delegate_task", failing_delegate)

    errors = []
    async for ev in replay_module.replay_turn(
        session_id=session_id, turn_id=turn_id, replay_id="RPL-err"
    ):
        if ev["event"] == "replay_error":
            errors.append(ev)

    assert errors and "expert crashed" in errors[0]["detail"]


def test_diff_summary_matches_and_mismatches():
    orig = {
        "input": {"promptSha256": "abc"},
        "delegations": [1, 2, 3],
        "citations": {"total": 5, "verified": 4, "unresolved": 1},
    }
    new = {
        "input": {"promptSha256": "abc"},
        "delegations": [1, 2],
    }
    diff = replay_module._diff_summary(orig, new)
    assert diff == {
        "inputHashMatch": True,
        "delegationsOriginal": 3,
        "delegationsReplayed": 2,
        "citationsOriginal": (5, 4, 1),
    }

    # Mismatch
    new["input"]["promptSha256"] = "xyz"
    diff = replay_module._diff_summary(orig, new)
    assert diff["inputHashMatch"] is False


async def test_replay_session_iterates_all_turns(active_project, monkeypatch):
    session_id, _ = await _seed_turn_with_attachment(active_project)

    async def fake_delegate(prompt, working_directory=None, tool_context=None):
        return {"result": "r", "skills_used": [], "tools_used": {}}

    monkeypatch.setattr(replay_module, "delegate_task", fake_delegate)

    events = []
    async for ev in replay_module.replay_session(session_id=session_id):
        events.append(ev)

    kinds = [e["event"] for e in events]
    assert kinds[0] == "replay_session_start"
    assert kinds[-1] == "replay_session_complete"
