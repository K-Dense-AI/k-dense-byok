from __future__ import annotations


def test_strip_openrouter_prefix() -> None:
    import litellm_callbacks

    assert litellm_callbacks._strip_openrouter_prefix("openrouter/anthropic/model") == "anthropic/model"
    assert litellm_callbacks._strip_openrouter_prefix("openrouter/model") == "openrouter/model"
    assert litellm_callbacks._strip_openrouter_prefix("anthropic/model") == "anthropic/model"


def test_merge_header_sources_precedence() -> None:
    import litellm_callbacks

    headers = litellm_callbacks._merge_header_sources(
        {
            "proxy_server_request": {"headers": {"A": "1", "B": "proxy"}},
            "optional_params": {"extra_headers": {"B": "optional", "C": "2"}},
            "litellm_params": {"extra_headers": {"D": "3"}},
        }
    )

    assert headers == {"A": "1", "B": "optional", "C": "2", "D": "3"}


def test_proxy_callback_records_expert_cost(active_project: str) -> None:
    import litellm_callbacks
    from kady_agent import runtime

    callback = litellm_callbacks.OpenRouterPrefixFix()
    callback._record(
        {
            "model": "openrouter/vendor/model",
            "response_cost": 0.02,
            "proxy_server_request": {
                "headers": runtime.build_tracking_headers(
                    role="expert",
                    project_id=active_project,
                    session_id="session-proxy",
                    turn_id="turn-proxy",
                    delegation_id="001",
                )
            },
        },
        {"usage": {"prompt_tokens": 4, "completion_tokens": 5}},
    )

    summary = runtime.read_costs("session-proxy", project_id=active_project)
    assert summary["expertUsd"] == 0.02
    assert summary["entries"][0]["delegationId"] == "001"


def test_proxy_callback_ignores_non_expert(active_project: str) -> None:
    import litellm_callbacks
    from kady_agent import runtime

    callback = litellm_callbacks.OpenRouterPrefixFix()
    callback._record(
        {
            "model": "openrouter/vendor/model",
            "response_cost": 0.02,
            "proxy_server_request": {
                "headers": runtime.build_tracking_headers(
                    role="orchestrator",
                    project_id=active_project,
                    session_id="session-noop",
                    turn_id="turn",
                )
            },
        },
        {"usage": {}},
    )

    assert runtime.read_costs("session-noop", project_id=active_project)["entries"] == []


def test_proxy_callback_records_gemini_alias_cost(active_project: str) -> None:
    import litellm_callbacks
    from kady_agent import runtime

    callback = litellm_callbacks.OpenRouterPrefixFix()
    callback._record(
        {
            "model": "gemini-3-pro-preview",
            "response_cost": 0.01,
            "proxy_server_request": {
                "headers": runtime.build_tracking_headers(
                    role="expert",
                    project_id=active_project,
                    session_id="session-gemini-proxy",
                    turn_id="turn",
                )
            },
        },
        {"usage": {"prompt_tokens": 1, "completion_tokens": 1}},
    )

    assert (
        runtime.read_costs("session-gemini-proxy", project_id=active_project)["expertUsd"]
        == 0.01
    )
