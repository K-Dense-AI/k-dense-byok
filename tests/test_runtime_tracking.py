from __future__ import annotations

import json


def test_tracking_headers_and_metadata_round_trip() -> None:
    from kady_agent import runtime

    headers = runtime.build_tracking_headers(
        role="expert",
        project_id="proj",
        session_id="sess",
        turn_id="turn",
        delegation_id="001",
    )
    assert runtime.extract_tags_from_headers(headers) == {
        "session_id": "sess",
        "turn_id": "turn",
        "role": "expert",
        "delegation_id": "001",
        "project_id": "proj",
    }

    metadata = runtime.build_tracking_metadata(
        role="orchestrator",
        project_id="proj",
        session_id="sess",
        turn_id="turn",
    )
    assert runtime.extract_tags_from_metadata(metadata) == {
        "session_id": "sess",
        "turn_id": "turn",
        "role": "orchestrator",
        "delegation_id": None,
        "project_id": "proj",
    }


def test_litellm_kwargs_prefers_metadata_over_headers() -> None:
    from kady_agent import runtime

    kwargs = {
        "litellm_params": {
            "metadata": runtime.build_tracking_metadata(
                role="orchestrator",
                project_id="meta-proj",
                session_id="meta-session",
                turn_id="meta-turn",
            ),
            "extra_headers": runtime.build_tracking_headers(
                role="expert",
                project_id="header-proj",
                session_id="header-session",
                turn_id="header-turn",
            ),
        }
    }

    assert runtime.extract_tags_from_litellm_kwargs(kwargs)["project_id"] == "meta-proj"


def test_cost_ledger_records_updates_and_aggregates(active_project: str) -> None:
    from kady_agent import runtime

    first = runtime.record_cost(
        session_id="session-a",
        turn_id="turn-a",
        role="orchestrator",
        model="openrouter/example/model",
        usage_dict={
            "prompt_tokens": 7,
            "completion_tokens": 11,
            "prompt_tokens_details": {"cached_tokens": 3},
            "completion_tokens_details": {"reasoning_tokens": 2},
        },
        cost_usd=None,
        project_id=active_project,
    )
    assert first

    second = runtime.record_cost(
        session_id="session-a",
        turn_id="turn-a",
        role="expert",
        model="openrouter/example/expert",
        usage_dict={"prompt_tokens": 2, "completion_tokens": 3},
        cost_usd=0.04,
        delegation_id="001",
        project_id=active_project,
    )
    assert second
    assert runtime.update_cost_entry(
        session_id="session-a",
        entry_id=first,
        cost_usd=0.01,
        project_id=active_project,
    )

    summary = runtime.read_costs("session-a", project_id=active_project)
    assert summary["totalUsd"] == 0.05
    assert summary["orchestratorUsd"] == 0.01
    assert summary["expertUsd"] == 0.04
    assert summary["totalTokens"] == 23
    assert summary["byTurn"]["turn-a"]["totalUsd"] == 0.05
    assert summary["entries"][0]["cachedTokens"] == 3
    assert summary["entries"][0]["reasoningTokens"] == 2

    project_summary = runtime.read_project_costs(active_project)
    assert project_summary["sessionCount"] == 1
    assert project_summary["totalUsd"] == 0.05


def test_budget_states(active_project: str) -> None:
    from kady_agent import runtime

    runtime.record_cost(
        session_id="budget-session",
        turn_id="turn",
        role="expert",
        model="openrouter/example",
        usage_dict={},
        cost_usd=8.0,
        project_id=active_project,
    )

    assert runtime.check_project_budget(active_project, None)["state"] == "ok"
    assert runtime.check_project_budget(active_project, 20.0)["state"] == "ok"
    assert runtime.check_project_budget(active_project, 10.0)["state"] == "warn"
    assert runtime.check_project_budget(active_project, 8.0)["state"] == "exceeded"


def test_record_cost_rejects_missing_required_fields(active_project: str) -> None:
    from kady_agent import projects, runtime

    assert runtime.record_cost(
        session_id="",
        turn_id="turn",
        role="expert",
        model="openrouter/x",
        usage_dict={},
        cost_usd=1.0,
        project_id=active_project,
    ) is None
    ledger = projects.resolve_paths(active_project).runs_dir
    assert not any(ledger.rglob("costs.jsonl")) if ledger.exists() else True


def test_update_cost_entry_preserves_malformed_lines(active_project: str) -> None:
    from kady_agent import projects, runtime

    entry_id = runtime.record_cost(
        session_id="session-b",
        turn_id="turn-b",
        role="expert",
        model="openrouter/example",
        usage_dict={},
        cost_usd=None,
        project_id=active_project,
    )
    path = projects.resolve_paths(active_project).runs_dir / "session-b" / "costs.jsonl"
    path.write_text(path.read_text(encoding="utf-8") + "not-json\n", encoding="utf-8")

    assert runtime.update_cost_entry(
        session_id="session-b",
        entry_id=entry_id or "",
        cost_usd=0.25,
        project_id=active_project,
    )
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[-1] == "not-json"
    assert json.loads(lines[0])["costPending"] is False
