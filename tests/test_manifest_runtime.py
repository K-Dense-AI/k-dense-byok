from __future__ import annotations

import hashlib
import json

import pytest


@pytest.fixture(autouse=True)
def fast_runtime_probes(monkeypatch: pytest.MonkeyPatch) -> None:
    from kady_agent import runtime

    monkeypatch.setattr(runtime, "_git_sha", lambda: "test-sha")
    monkeypatch.setattr(runtime, "_node_version", lambda: "v-test")
    monkeypatch.setattr(runtime, "_gemini_cli_version", lambda: "gemini-test")
    monkeypatch.setattr(runtime, "_litellm_config_sha", lambda: "config-sha")


async def test_open_and_close_turn_manifest(active_project: str) -> None:
    from kady_agent import projects, runtime

    paths = projects.resolve_paths(active_project)
    attachment = paths.sandbox / "input.txt"
    attachment.parent.mkdir(parents=True, exist_ok=True)
    attachment.write_text("important input", encoding="utf-8")

    turn_id, manifest = await runtime.open_turn(
        session_id="session-1",
        user_text="Analyze the attachment",
        attachments=["input.txt", "../escape.txt", "missing.txt"],
        model="openrouter/test-model",
        expert_model="openrouter/test-expert",
        skills=["skill-a"],
        databases=["db-a"],
        compute="local",
    )

    assert manifest["turnId"] == turn_id
    assert manifest["input"]["promptSha256"] == hashlib.sha256(
        b"Analyze the attachment"
    ).hexdigest()
    assert manifest["input"]["attachments"] == [
        {
            "path": "input.txt",
            "sha256": hashlib.sha256(b"important input").hexdigest(),
            "bytes": len("important input"),
            "storedAt": f"attachments/{hashlib.sha256(b'important input').hexdigest()}",
        }
    ]
    assert manifest["env"]["seed"]

    closed = await runtime.close_turn(
        session_id="session-1",
        turn_id=turn_id,
        assistant_text="Final answer",
    )
    assert closed is not None
    assert closed["output"]["assistantTextSha256"] == hashlib.sha256(
        b"Final answer"
    ).hexdigest()
    assert closed["manifestSha256"]
    assert runtime.list_turns("session-1") == [turn_id]


async def test_attach_delegation_writes_side_files(active_project: str) -> None:
    from kady_agent import projects, runtime

    turn_id, _ = await runtime.open_turn(session_id="session-2", user_text="delegate")
    await runtime.attach_delegation(
        session_id="session-2",
        turn_id=turn_id,
        delegation_id="001",
        prompt="Do work",
        cwd="projects/x/sandbox",
        result={"result": "done", "skills_used": ["analysis"], "tools_used": {"x": 2}},
        duration_ms=42,
        stdout='{"type":"message"}\n',
        env_lock="python=3.13",
        deliverables=["out.txt"],
    )

    manifest = runtime.read_manifest("session-2", turn_id)
    assert manifest is not None
    assert manifest["delegations"][0]["id"] == "001"
    assert manifest["delegations"][0]["skillsUsed"] == ["analysis"]
    assert manifest["delegations"][0]["toolsUsed"] == {"x": 2}

    expert_dir = projects.resolve_paths(active_project).runs_dir / "session-2" / turn_id / "expert" / "001"
    assert (expert_dir / "prompt.txt").read_text(encoding="utf-8") == "Do work"
    assert (expert_dir / "stdout.jsonl").is_file()
    assert json.loads((expert_dir / "deliverables.json").read_text(encoding="utf-8")) == ["out.txt"]


def test_update_manifest_and_missing_manifest(active_project: str) -> None:
    from kady_agent import runtime

    assert runtime.update_manifest("missing", "turn", lambda data: data.update(x=1)) is None


async def test_replay_session_streams_delegation_events(
    active_project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent import runtime
    from kady_agent.tools import gemini_cli

    turn_id, _ = await runtime.open_turn(session_id="session-3", user_text="original")
    await runtime.attach_delegation(
        session_id="session-3",
        turn_id=turn_id,
        delegation_id="001",
        prompt="Replay me",
        cwd="sandbox",
        result={"result": "old", "skills_used": [], "tools_used": {}},
        duration_ms=1,
    )
    await runtime.close_turn(session_id="session-3", turn_id=turn_id, assistant_text="old")

    async def fake_delegate_task(prompt: str, working_directory: str | None = None, tool_context=None):
        assert prompt == "Replay me"
        assert working_directory
        return {"result": "new", "skills_used": ["replay"], "tools_used": {"delegate": 1}}

    monkeypatch.setattr(gemini_cli, "delegate_task", fake_delegate_task)

    events = [
        event
        async for event in runtime.replay_session(
            session_id="session-3", turn_ids=[turn_id]
        )
    ]
    assert [event["event"] for event in events] == [
        "replay_session_start",
        "replay_turn_start",
        "delegation_start",
        "delegation_complete",
        "replay_turn_complete",
        "replay_session_complete",
    ]
    assert events[3]["skillsUsed"] == ["replay"]


async def test_replay_missing_manifest_reports_error(active_project: str) -> None:
    from kady_agent import runtime

    events = [
        event
        async for event in runtime.replay_session(
            session_id="missing-session", turn_ids=["missing-turn"]
        )
    ]
    assert events[1] == {
        "event": "replay_error",
        "detail": "manifest not found: missing-turn",
    }
