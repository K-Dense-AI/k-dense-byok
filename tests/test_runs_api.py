from __future__ import annotations

import json

import pytest


pytestmark = pytest.mark.integration


async def test_runs_manifest_costs_citations_and_skills(
    client,
    active_project: str,
    project_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from kady_agent import projects, runtime

    monkeypatch.setattr(runtime, "_git_sha", lambda: "sha")
    monkeypatch.setattr(runtime, "_node_version", lambda: "node")
    monkeypatch.setattr(runtime, "_gemini_cli_version", lambda: "gemini")
    monkeypatch.setattr(runtime, "_litellm_config_sha", lambda: "config")

    turn_id, _ = await runtime.open_turn(session_id="session-api", user_text="hello")
    runtime.record_cost(
        session_id="session-api",
        turn_id=turn_id,
        role="orchestrator",
        model="openrouter/vendor/model",
        usage_dict={"prompt_tokens": 1, "completion_tokens": 1},
        cost_usd=0.01,
        project_id=active_project,
    )

    manifest = client.get(
        f"/turns/session-api/{turn_id}/manifest", headers=project_headers
    )
    assert manifest.status_code == 200
    assert manifest.json()["turnId"] == turn_id

    turns = client.get("/sessions/session-api/turns", headers=project_headers)
    assert turns.json() == {"sessionId": "session-api", "turns": [turn_id]}

    costs = client.get("/sessions/session-api/costs", headers=project_headers)
    assert costs.json()["totalUsd"] == 0.01

    citations = client.patch(
        f"/turns/session-api/{turn_id}/citations",
        headers=project_headers,
        json={"total": 2, "verified": 1, "unresolved": 1},
    )
    assert citations.status_code == 200
    assert runtime.read_manifest("session-api", turn_id)["citations"] == {
        "total": 2,
        "verified": 1,
        "unresolved": 1,
    }

    skill_dir = projects.resolve_paths(active_project).gemini_settings_dir / "skills" / "demo"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: Demo Skill\ndescription: Demo\nmetadata:\n  skill-author: Kady\n---\n",
        encoding="utf-8",
    )
    skills = client.get("/skills", headers=project_headers)
    assert skills.status_code == 200
    assert skills.json()[0]["name"] == "Demo Skill"


async def test_replay_endpoint_streams_ndjson(
    client,
    active_project: str,
    project_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from kady_agent import runtime
    from kady_agent.tools import gemini_cli

    turn_id, _ = await runtime.open_turn(session_id="session-replay-api", user_text="hello")
    await runtime.attach_delegation(
        session_id="session-replay-api",
        turn_id=turn_id,
        delegation_id="001",
        prompt="Replay this",
        cwd="sandbox",
        result={"result": "old", "skills_used": [], "tools_used": {}},
        duration_ms=1,
    )

    async def fake_delegate_task(prompt: str, working_directory: str | None = None, tool_context=None):
        return {"result": "new", "skills_used": [], "tools_used": {}}

    monkeypatch.setattr(gemini_cli, "delegate_task", fake_delegate_task)
    response = client.post(
        "/replay",
        headers=project_headers,
        json={"sessionId": "session-replay-api", "turnIds": [turn_id]},
    )
    assert response.status_code == 200
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[0]["event"] == "replay_session_start"
    assert events[-1]["event"] == "replay_session_complete"


async def test_verify_citations_validation(client, project_headers: dict[str, str]) -> None:
    bad = client.post("/verify-citations", headers=project_headers, json={"text": 1})
    assert bad.status_code == 400

    good = client.post(
        "/verify-citations",
        headers=project_headers,
        json={"text": "No citations here.", "files": []},
    )
    assert good.status_code == 200
    assert good.json()["total"] == 0
