from __future__ import annotations

from types import SimpleNamespace

import pytest


def test_override_model_injects_tracking_args(
    active_project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent import agent

    original_args = dict(agent._LITELLM_MODEL._additional_args)
    try:
        agent._LITELLM_MODEL._additional_args.clear()
        request = SimpleNamespace(model="original")
        context = SimpleNamespace(
            state={
                "_model": "openrouter/test-model",
                "_sessionId": "session",
                "_turnId": "turn",
            }
        )

        assert agent._override_model(context, request) is None

        assert request.model == "openrouter/test-model"
        args = agent._LITELLM_MODEL._additional_args
        assert args["extra_headers"]["X-Kady-Role"] == "orchestrator"
        assert args["extra_headers"]["X-Kady-Session-Id"] == "session"
        assert args["extra_headers"]["X-Kady-Project"] == active_project
        assert args["metadata"]["kady_turn_id"] == "turn"
        assert args["extra_body"] == {"usage": {"include": True}}
    finally:
        agent._LITELLM_MODEL._additional_args.clear()
        agent._LITELLM_MODEL._additional_args.update(original_args)


async def test_open_and_close_turn_manifest_callbacks(
    active_project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent import agent, runtime

    monkeypatch.setattr(runtime, "_git_sha", lambda: "sha")
    monkeypatch.setattr(runtime, "_node_version", lambda: "node")
    monkeypatch.setattr(runtime, "_gemini_cli_version", lambda: "gemini")
    monkeypatch.setattr(runtime, "_litellm_config_sha", lambda: "litellm")

    user_content = SimpleNamespace(parts=[SimpleNamespace(text="hello"), SimpleNamespace(text=" world")])
    invocation = SimpleNamespace(session=SimpleNamespace(id="session-cb"), user_content=user_content)
    context = SimpleNamespace(
        state={"_model": "openrouter/orchestrator", "_expertModel": "openrouter/expert"},
        _invocation_context=invocation,
    )

    assert await agent._open_turn_manifest(context) is None
    assert context.state["_turnId"]
    assert context.state["_sessionId"] == "session-cb"

    context.state["final_output"] = "assistant output"
    assert await agent._close_turn_manifest(context) is None

    manifest = runtime.read_manifest("session-cb", context.state["_turnId"])
    assert manifest["output"]["assistantTextPreview"] == "assistant output"


def test_orchestrator_cost_logger_filters_and_records(active_project: str) -> None:
    from kady_agent import agent, runtime

    logger = agent._OrchestratorCostLogger()
    tags = runtime.build_tracking_metadata(
        role="orchestrator",
        project_id=active_project,
        session_id="session-cost",
        turn_id="turn-cost",
    )
    metadata = {
        **tags,
        "hidden_params": {
            "litellm_model_name": "openrouter/vendor/model",
            "received_model_id": "gen-123",
        },
    }
    kwargs = {
        "custom_llm_provider": "openrouter",
        "model": "vendor/model",
        "litellm_params": {"metadata": metadata},
    }
    response = {"usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_cost": 0.03}}

    entry_id, gen_id, project_id = logger._record(kwargs, response)

    assert entry_id
    assert gen_id is None
    assert project_id == active_project
    summary = runtime.read_costs("session-cost", project_id=active_project)
    assert summary["orchestratorUsd"] == 0.03
    assert summary["entries"][0]["model"] == "openrouter/vendor/model"


def test_orchestrator_cost_logger_ignores_non_openrouter(active_project: str) -> None:
    from kady_agent import agent, runtime

    logger = agent._OrchestratorCostLogger()
    kwargs = {
        "custom_llm_provider": "ollama",
        "model": "ollama/local",
        "litellm_params": {
            "metadata": runtime.build_tracking_metadata(
                role="orchestrator",
                project_id=active_project,
                session_id="session-ignore",
                turn_id="turn-ignore",
            )
        },
    }
    assert logger._record(kwargs, {"usage": {}}) == (None, None, None)
    assert runtime.read_costs("session-ignore", project_id=active_project)["entries"] == []


async def test_orchestrator_cost_backfill_updates_entry(
    active_project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent import agent, runtime

    entry_id = runtime.record_cost(
        session_id="session-backfill",
        turn_id="turn",
        role="orchestrator",
        model="openrouter/vendor/model",
        usage_dict={},
        cost_usd=None,
        project_id=active_project,
    )

    async def fake_fetch(gen_id: str) -> float:
        assert gen_id == "gen-backfill"
        return 0.12

    monkeypatch.setattr(agent, "_fetch_openrouter_generation_cost", fake_fetch)
    await agent._OrchestratorCostLogger._backfill_cost(
        "session-backfill", entry_id, "gen-backfill", active_project
    )
    summary = runtime.read_costs("session-backfill", project_id=active_project)
    assert summary["entries"][0]["costUsd"] == 0.12
    assert summary["entries"][0]["costPending"] is False
