"""Unit tests for cost-tracking helpers in ``kady_agent/agent.py``.

We exercise the pure logic (``_OrchestratorCostLogger._extract_*``,
``_record``, ``_fetch_openrouter_generation_cost``) without touching the
ADK runner or LiteLLM's real callback stack.
"""

from __future__ import annotations

import asyncio
import json
import types
from typing import Any

import httpx
import pytest
import respx

from kady_agent import agent as agent_module
from kady_agent import cost_ledger


# ---------------------------------------------------------------------------
# _extract_tags_from_kwargs
# ---------------------------------------------------------------------------


def test_extract_tags_prefers_metadata():
    logger = agent_module._OrchestratorCostLogger()
    tags = logger._extract_tags_from_kwargs(
        {
            "litellm_params": {
                "metadata": {
                    "kady_role": "orchestrator",
                    "kady_session_id": "s",
                    "kady_turn_id": "t",
                    "kady_project": "p",
                }
            }
        }
    )
    assert tags == {
        "role": "orchestrator",
        "session_id": "s",
        "turn_id": "t",
        "delegation_id": None,
        "project_id": "p",
    }


def test_extract_tags_falls_back_to_extra_headers():
    logger = agent_module._OrchestratorCostLogger()
    tags = logger._extract_tags_from_kwargs(
        {
            "litellm_params": {},
            "optional_params": {
                "extra_headers": {
                    "X-Kady-Session-Id": "s",
                    "X-Kady-Turn-Id": "t",
                    "X-Kady-Role": "orchestrator",
                    "X-Kady-Project": "p",
                }
            },
        }
    )
    assert tags is not None
    assert tags["role"] == "orchestrator"


def test_extract_tags_returns_none_when_missing():
    logger = agent_module._OrchestratorCostLogger()
    assert logger._extract_tags_from_kwargs({"litellm_params": {}}) is None


# ---------------------------------------------------------------------------
# _extract_cost_and_gen_id
# ---------------------------------------------------------------------------


def test_extract_cost_and_gen_id_from_response_usage():
    logger = agent_module._OrchestratorCostLogger()
    response = types.SimpleNamespace(
        id="gen-123",
        usage=types.SimpleNamespace(cost=0.12, total_tokens=30),
    )
    cost, gen_id = logger._extract_cost_and_gen_id({}, response)
    assert cost == 0.12
    assert gen_id == "gen-123"


def test_extract_cost_and_gen_id_fallback_to_response_cost_kwarg():
    logger = agent_module._OrchestratorCostLogger()
    cost, gen_id = logger._extract_cost_and_gen_id(
        {"response_cost": 0.04}, types.SimpleNamespace(id="not-openrouter", usage=None)
    )
    assert cost == 0.04
    assert gen_id is None


def test_extract_cost_and_gen_id_hidden_params_override():
    logger = agent_module._OrchestratorCostLogger()
    kwargs = {
        "litellm_params": {
            "metadata": {"hidden_params": {"received_model_id": "gen-xyz"}},
        }
    }
    _, gen_id = logger._extract_cost_and_gen_id(
        kwargs, types.SimpleNamespace(usage=None, id="other")
    )
    assert gen_id == "gen-xyz"


# ---------------------------------------------------------------------------
# _record
# ---------------------------------------------------------------------------


def _orchestrator_kwargs(**extras):
    return {
        "custom_llm_provider": "openrouter",
        "model": "openrouter/x/y",
        "litellm_params": {
            "metadata": {
                "kady_role": "orchestrator",
                "kady_session_id": "s1",
                "kady_turn_id": "t1",
                "kady_project": extras.get("project", "test-project"),
                "hidden_params": {
                    "received_model_id": "gen-abc",
                    "litellm_model_name": "openrouter/anthropic/claude-opus-4.7",
                },
            },
        },
    }


def test_record_writes_ledger_entry(active_project):
    logger = agent_module._OrchestratorCostLogger()
    response = types.SimpleNamespace(
        id="gen-abc",
        usage=types.SimpleNamespace(
            cost=0.05, prompt_tokens=10, completion_tokens=5, total_tokens=15
        ),
    )
    entry_id, gen_id, project_id = logger._record(
        _orchestrator_kwargs(project=active_project.id), response
    )
    assert entry_id
    assert gen_id is None  # cost present, no backfill needed
    assert project_id == active_project.id

    summary = cost_ledger.read_costs("s1", project_id=active_project.id)
    assert summary["orchestratorUsd"] == 0.05
    assert summary["entries"][0]["model"] == "openrouter/anthropic/claude-opus-4.7"


def test_record_returns_gen_id_for_backfill_when_cost_missing(active_project):
    logger = agent_module._OrchestratorCostLogger()
    response = types.SimpleNamespace(
        id="gen-abc",
        usage=types.SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2),
    )
    entry_id, gen_id, _ = logger._record(
        _orchestrator_kwargs(project=active_project.id), response
    )
    assert entry_id is not None
    assert gen_id == "gen-abc"


def test_record_skips_non_orchestrator_roles(active_project):
    logger = agent_module._OrchestratorCostLogger()
    kwargs = _orchestrator_kwargs(project=active_project.id)
    kwargs["litellm_params"]["metadata"]["kady_role"] = "expert"
    out = logger._record(kwargs, types.SimpleNamespace(usage=None, id=None))
    assert out == (None, None, None)


def test_record_skips_non_openrouter_provider(active_project):
    logger = agent_module._OrchestratorCostLogger()
    kwargs = _orchestrator_kwargs(project=active_project.id)
    kwargs["custom_llm_provider"] = "anthropic"
    assert logger._record(kwargs, types.SimpleNamespace(usage=None, id=None)) == (
        None,
        None,
        None,
    )


# ---------------------------------------------------------------------------
# _fetch_openrouter_generation_cost
# ---------------------------------------------------------------------------


async def test_fetch_openrouter_generation_cost_success(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    with respx.mock() as mock:
        mock.get("https://openrouter.ai/api/v1/generation").mock(
            return_value=httpx.Response(
                200, json={"data": {"total_cost": 0.037}}
            )
        )
        cost = await agent_module._fetch_openrouter_generation_cost("gen-1")
    assert cost == pytest.approx(0.037)


async def test_fetch_openrouter_generation_cost_returns_none_on_404_retry_exhaustion(
    monkeypatch,
):
    """Fewer retries so the test runs fast."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    # Shorten retry delays to 0.
    monkeypatch.setattr(
        agent_module,
        "_fetch_openrouter_generation_cost",
        agent_module._fetch_openrouter_generation_cost,
    )
    # Patch asyncio.sleep to no-op so we don't wait ~46s.
    async def fast_sleep(*a, **kw):
        return None

    monkeypatch.setattr(agent_module.asyncio, "sleep", fast_sleep)
    with respx.mock() as mock:
        mock.get("https://openrouter.ai/api/v1/generation").mock(
            return_value=httpx.Response(404)
        )
        cost = await agent_module._fetch_openrouter_generation_cost("gen-1")
    assert cost is None


async def test_fetch_openrouter_generation_cost_requires_api_key(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("OR_API_KEY", raising=False)
    assert await agent_module._fetch_openrouter_generation_cost("gen-1") is None


async def test_fetch_openrouter_generation_cost_handles_http_error(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    async def fast_sleep(*a, **kw):
        return None
    monkeypatch.setattr(agent_module.asyncio, "sleep", fast_sleep)
    with respx.mock() as mock:
        mock.get("https://openrouter.ai/api/v1/generation").mock(
            side_effect=httpx.ConnectError("down")
        )
        cost = await agent_module._fetch_openrouter_generation_cost("gen-1")
    assert cost is None
