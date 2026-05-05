from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
import pytest


pytestmark = [pytest.mark.integration, pytest.mark.live_e2e]


def _sse_events(response: httpx.Response) -> list[dict]:
    events: list[dict] = []
    for line in response.text.splitlines():
        if not line.startswith("data: "):
            continue
        payload = line.removeprefix("data: ").strip()
        if payload:
            events.append(json.loads(payload))
    return events


def _event_text(event: dict) -> str:
    parts = event.get("content", {}).get("parts", [])
    return "".join(part.get("text") or "" for part in parts if isinstance(part, dict))


def _event_turn_id(event: dict) -> str | None:
    actions = event.get("actions") or {}
    state = actions.get("stateDelta") or actions.get("state_delta") or {}
    value = state.get("_turnId")
    return value if isinstance(value, str) else None


def test_live_agent_turn_delegation_mcp_costs_and_replay(live_project, monkeypatch: pytest.MonkeyPatch) -> None:
    backend = live_project["backend"]
    project_id = live_project["id"]
    headers = live_project["headers"]

    write = httpx.put(
        f"{backend}/sandbox/file?path=input.txt",
        headers=headers,
        content=b"Live E2E input: write a short summary file.",
        timeout=30.0,
    )
    write.raise_for_status()

    session_resp = httpx.post(
        f"{backend}/apps/kady_agent/users/user/sessions",
        headers={**headers, "Content-Type": "application/json"},
        timeout=30.0,
    )
    session_resp.raise_for_status()
    session_id = session_resp.json()["id"]

    prompt = (
        "This is a live end-to-end pytest run. Use delegate_task exactly once. "
        "Ask the specialist to read input.txt and write live_e2e_summary.md in the sandbox. "
        "Then respond briefly with the file name."
    )
    run_resp = httpx.post(
        f"{backend}/run_sse",
        headers={**headers, "Content-Type": "application/json"},
        json={
            "appName": "kady_agent",
            "userId": "user",
            "sessionId": session_id,
            "newMessage": {"role": "user", "parts": [{"text": prompt}]},
            "streaming": True,
            "state_delta": {
                "_attachments": ["input.txt"],
                "_expertModel": "openrouter/google/gemini-3.1-pro-preview",
            },
        },
        timeout=300.0,
    )
    run_resp.raise_for_status()
    events = _sse_events(run_resp)

    assert events, run_resp.text
    assert not any(event.get("error") for event in events)
    combined_text = "".join(_event_text(event) for event in events)
    assert combined_text.strip()
    turn_id = next((tid for event in events if (tid := _event_turn_id(event))), None)
    assert turn_id
    assert any(
        "functionCall" in part
        for event in events
        for part in event.get("content", {}).get("parts", [])
        if isinstance(part, dict)
    )

    manifest_resp = httpx.get(
        f"{backend}/turns/{session_id}/{turn_id}/manifest",
        headers=headers,
        timeout=30.0,
    )
    manifest_resp.raise_for_status()
    manifest = manifest_resp.json()
    assert manifest["turnId"] == turn_id
    assert manifest["delegations"], manifest
    assert manifest["input"]["attachments"][0]["path"] == "input.txt"

    tree = httpx.get(f"{backend}/sandbox/tree", headers=headers, timeout=30.0)
    tree.raise_for_status()
    assert "live_e2e_summary.md" in json.dumps(tree.json())

    costs = None
    deadline = time.time() + 90
    while time.time() < deadline:
        costs_resp = httpx.get(
            f"{backend}/sessions/{session_id}/costs", headers=headers, timeout=30.0
        )
        costs_resp.raise_for_status()
        costs = costs_resp.json()
        roles = {entry.get("role") for entry in costs.get("entries", [])}
        if "orchestrator" in roles:
            break
        time.sleep(3)
    roles = {entry.get("role") for entry in (costs or {}).get("entries", [])}
    assert "orchestrator" in roles, costs
    if "expert" not in roles:
        # Some live Gemini CLI aliases do not report provider cost through the
        # proxy; the delegation itself is verified via the manifest above.
        assert manifest["delegations"]

    # Exercise the bundled PDF annotation MCP against the live project root.
    import kady_agent.projects as projects
    from kady_agent.mcp_servers import pdf_annotations

    live_root = Path(live_project["projects_root"])
    monkeypatch.setattr(projects, "PROJECTS_ROOT", live_root)
    monkeypatch.setattr(projects, "INDEX_PATH", live_root / "index.json")
    monkeypatch.setenv("KADY_PROJECT_ID", project_id)
    monkeypatch.setenv("KADY_EXPERT_ID", "live-e2e")
    monkeypatch.setenv("KADY_EXPERT_LABEL", "Live E2E")

    httpx.put(
        f"{backend}/sandbox/file?path=paper.pdf",
        headers=headers,
        content=b"%PDF-1.4\n",
        timeout=30.0,
    ).raise_for_status()
    ann = pdf_annotations.add_pdf_annotation(
        "paper.pdf",
        "note",
        1,
        body="Created by live E2E MCP test",
        anchor={"x": 1, "y": 2},
    )
    annotations = httpx.get(
        f"{backend}/sandbox/annotations?path=paper.pdf", headers=headers, timeout=30.0
    )
    annotations.raise_for_status()
    assert annotations.json()["annotations"][0]["id"] == ann["id"]

    replay = httpx.post(
        f"{backend}/replay",
        headers={**headers, "Content-Type": "application/json"},
        json={"sessionId": session_id, "turnIds": [turn_id]},
        timeout=300.0,
    )
    replay.raise_for_status()
    replay_events = [json.loads(line) for line in replay.text.splitlines() if line.strip()]
    assert replay_events[0]["event"] == "replay_session_start"
    assert replay_events[-1]["event"] == "replay_session_complete"
