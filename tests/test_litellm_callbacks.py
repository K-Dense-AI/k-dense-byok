"""Unit tests for ``litellm_callbacks.py``.

Exercise ``_strip_openrouter_prefix``, ``_merge_header_sources``, and the
``OpenRouterPrefixFix._record`` expert ledger path.
"""

from __future__ import annotations

import json
import types

import pytest

import litellm_callbacks as cb
from kady_agent import cost_ledger


# ---------------------------------------------------------------------------
# _strip_openrouter_prefix
# ---------------------------------------------------------------------------


def test_strip_openrouter_prefix_drops_double_prefix():
    assert cb._strip_openrouter_prefix("openrouter/anthropic/claude-opus-4.7") == (
        "anthropic/claude-opus-4.7"
    )


def test_strip_openrouter_prefix_keeps_single_segment():
    # If the upstream id is already `openrouter/name` (single slash), leave it.
    assert cb._strip_openrouter_prefix("openrouter/gpt-4o") == "openrouter/gpt-4o"


def test_strip_openrouter_prefix_passthrough_non_openrouter():
    assert cb._strip_openrouter_prefix("gemini-pro") == "gemini-pro"
    assert cb._strip_openrouter_prefix(None) is None


# ---------------------------------------------------------------------------
# _merge_header_sources
# ---------------------------------------------------------------------------


def test_merge_header_sources_merges_priority_order():
    kwargs = {
        "proxy_server_request": {"headers": {"X-Kady-Session-Id": "from-proxy"}},
        "optional_params": {"extra_headers": {"X-Kady-Turn-Id": "turn"}},
        "litellm_params": {"extra_headers": {"X-Kady-Role": "expert"}},
    }
    merged = cb._merge_header_sources(kwargs)
    assert merged["X-Kady-Session-Id"] == "from-proxy"
    assert merged["X-Kady-Turn-Id"] == "turn"
    assert merged["X-Kady-Role"] == "expert"


def test_merge_header_sources_tolerates_missing_buckets():
    assert cb._merge_header_sources({}) == {}
    assert cb._merge_header_sources({"proxy_server_request": "not-a-dict"}) == {}


# ---------------------------------------------------------------------------
# OpenRouterPrefixFix._record -> record_cost integration
# ---------------------------------------------------------------------------


def _success_kwargs(model="openrouter/anthropic/claude-opus-4.7", **extras) -> dict:
    return {
        "model": model,
        "proxy_server_request": {
            "headers": {
                "X-Kady-Session-Id": "s1",
                "X-Kady-Turn-Id": "t1",
                "X-Kady-Role": "expert",
                "X-Kady-Delegation-Id": "d1",
                "X-Kady-Project": "test-project",
                **extras,
            }
        },
        "response_cost": 0.0075,
    }


def _response_with_usage():
    return types.SimpleNamespace(
        usage=types.SimpleNamespace(
            prompt_tokens=10, completion_tokens=20, total_tokens=30
        )
    )


def test_record_appends_expert_ledger(active_project):
    handler = cb.OpenRouterPrefixFix()
    handler._record(_success_kwargs(), _response_with_usage())

    summary = cost_ledger.read_costs("s1", project_id=active_project.id)
    assert summary["expertUsd"] == pytest.approx(0.0075)
    assert summary["totalTokens"] == 30


def test_record_skips_when_missing_role(active_project):
    handler = cb.OpenRouterPrefixFix()
    # Absent role -> no cost recorded
    kwargs = {
        "model": "openrouter/x/y",
        "proxy_server_request": {"headers": {"X-Kady-Session-Id": "s1"}},
        "response_cost": 0.1,
    }
    handler._record(kwargs, _response_with_usage())
    summary = cost_ledger.read_costs("s1", project_id=active_project.id)
    assert summary["entries"] == []


def test_record_skips_when_role_is_orchestrator(active_project):
    handler = cb.OpenRouterPrefixFix()
    # Orchestrator costs are recorded elsewhere (agent.py), not by this callback.
    kwargs = _success_kwargs()
    kwargs["proxy_server_request"]["headers"]["X-Kady-Role"] = "orchestrator"
    handler._record(kwargs, _response_with_usage())
    summary = cost_ledger.read_costs("s1", project_id=active_project.id)
    assert summary["entries"] == []


def test_record_skips_when_model_has_no_slash(active_project):
    handler = cb.OpenRouterPrefixFix()
    kwargs = _success_kwargs(model="no-slash-id")
    handler._record(kwargs, _response_with_usage())
    summary = cost_ledger.read_costs("s1", project_id=active_project.id)
    assert summary["entries"] == []


def test_record_handles_dict_response_object(active_project):
    handler = cb.OpenRouterPrefixFix()
    handler._record(
        _success_kwargs(),
        {"usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}},
    )
    summary = cost_ledger.read_costs("s1", project_id=active_project.id)
    assert summary["totalTokens"] == 3


def test_record_swallows_exceptions(active_project, monkeypatch):
    handler = cb.OpenRouterPrefixFix()

    def boom(**kw):
        raise RuntimeError("disk full")

    monkeypatch.setattr(cb, "record_cost", boom)
    # Must not raise
    handler._record(_success_kwargs(), _response_with_usage())


def test_patched_get_llm_provider_strips_prefix(monkeypatch):
    """``_patched_get_llm_provider`` should coerce the provider to None."""
    captured = {}

    def fake_orig(model, custom_llm_provider=None, **kw):
        captured["model"] = model
        captured["provider"] = custom_llm_provider
        return ("stripped", None, None, None)

    monkeypatch.setattr(cb, "_ORIG_GET_LLM_PROVIDER", fake_orig)
    cb._patched_get_llm_provider(
        model="openrouter/anthropic/claude-opus-4.7",
        custom_llm_provider="openrouter",
    )
    assert captured["model"] == "openrouter/anthropic/claude-opus-4.7"
    assert captured["provider"] is None


def test_patched_get_llm_provider_passthrough_for_other_provider(monkeypatch):
    captured = {}

    def fake_orig(model, custom_llm_provider=None, **kw):
        captured["provider"] = custom_llm_provider
        return ("x", None, None, None)

    monkeypatch.setattr(cb, "_ORIG_GET_LLM_PROVIDER", fake_orig)
    cb._patched_get_llm_provider(model="gemini-pro", custom_llm_provider="vertex_ai")
    assert captured["provider"] == "vertex_ai"
