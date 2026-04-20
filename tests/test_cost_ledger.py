"""Unit tests for ``kady_agent/cost_ledger.py``.

The ledger is the single source of truth for billing; these tests exercise
the four ways things typically go wrong in practice:

1. Header extraction: arbitrary shapes (dict, Pydantic-ish, missing values).
2. Usage coercion: OpenAI SDK objects, Pydantic objects, weird types.
3. Append/read round-trip semantics with role-based aggregation.
4. Backfill (``update_cost_entry``) re-writes only the matching row.
"""

from __future__ import annotations

import json
import types

from kady_agent import cost_ledger


class _FakeUsage:
    """Looks like a LiteLLM/OpenAI usage object."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _PydanticishUsage:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def model_dump(self) -> dict:
        return dict(self._payload)


# ---------------------------------------------------------------------------
# extract_cost_tags
# ---------------------------------------------------------------------------


def test_extract_cost_tags_none_on_missing_headers():
    assert cost_ledger.extract_cost_tags(None) is None
    assert cost_ledger.extract_cost_tags({}) is None


def test_extract_cost_tags_none_when_triplet_incomplete():
    # role missing
    headers = {
        "x-kady-session-id": "s",
        "x-kady-turn-id": "t",
    }
    assert cost_ledger.extract_cost_tags(headers) is None


def test_extract_cost_tags_returns_triplet_and_optional_fields():
    headers = {
        "X-Kady-Session-Id": "sess",
        "X-Kady-Turn-Id": "turn",
        "X-Kady-Role": "orchestrator",
        "X-Kady-Delegation-Id": "deleg",
        "X-Kady-Project": "proj",
        "X-Kady-Unrelated": "drop",
    }
    tags = cost_ledger.extract_cost_tags(headers)
    assert tags == {
        "session_id": "sess",
        "turn_id": "turn",
        "role": "orchestrator",
        "delegation_id": "deleg",
        "project_id": "proj",
    }


def test_extract_cost_tags_object_without_items_yields_empty():
    """Non-dict without items() should be treated as empty."""
    class Bad:
        pass

    assert cost_ledger.extract_cost_tags(Bad()) is None


# ---------------------------------------------------------------------------
# _coerce_usage_dict and token extraction
# ---------------------------------------------------------------------------


def test_coerce_usage_dict_handles_common_shapes():
    assert cost_ledger._coerce_usage_dict(None) == {}
    assert cost_ledger._coerce_usage_dict({"a": 1}) == {"a": 1}
    assert cost_ledger._coerce_usage_dict(_PydanticishUsage({"x": 2})) == {"x": 2}

    usage = _FakeUsage(prompt_tokens=1, completion_tokens=2)
    coerced = cost_ledger._coerce_usage_dict(usage)
    assert coerced["prompt_tokens"] == 1
    assert coerced["completion_tokens"] == 2


def test_extract_cached_tokens_from_details():
    assert cost_ledger._extract_cached_tokens({"prompt_tokens_details": {"cached_tokens": 7}}) == 7
    assert cost_ledger._extract_cached_tokens({"cached_tokens": 3}) == 3
    assert cost_ledger._extract_cached_tokens({}) == 0


def test_extract_reasoning_tokens_from_details():
    assert (
        cost_ledger._extract_reasoning_tokens(
            {"completion_tokens_details": {"reasoning_tokens": 9}}
        )
        == 9
    )
    assert cost_ledger._extract_reasoning_tokens({}) == 0


# ---------------------------------------------------------------------------
# record_cost + read_costs round-trip
# ---------------------------------------------------------------------------


def test_record_cost_appends_and_returns_id(active_project):
    entry_id = cost_ledger.record_cost(
        session_id="s1",
        turn_id="t1",
        role="orchestrator",
        model="openrouter/anthropic/claude-opus-4.7",
        usage_dict={"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
        cost_usd=0.0125,
        project_id=active_project.id,
    )
    assert entry_id
    ledger = active_project.runs_dir / "s1" / "costs.jsonl"
    row = json.loads(ledger.read_text().strip())
    assert row["entryId"] == entry_id
    assert row["promptTokens"] == 10
    assert row["costUsd"] == 0.0125
    assert row["costPending"] is False


def test_record_cost_rejects_missing_mandatory_fields(active_project):
    assert cost_ledger.record_cost(
        session_id="",
        turn_id="t",
        role="orchestrator",
        model="m",
        usage_dict={},
        cost_usd=0.0,
    ) is None
    assert cost_ledger.record_cost(
        session_id="s",
        turn_id="t",
        role="orchestrator",
        model=None,
        usage_dict={},
        cost_usd=0.0,
    ) is None


def test_record_cost_marks_pending_when_cost_is_none(active_project):
    cost_ledger.record_cost(
        session_id="s1",
        turn_id="t1",
        role="expert",
        model="m",
        usage_dict={"total_tokens": 5},
        cost_usd=None,
        project_id=active_project.id,
    )
    ledger = active_project.runs_dir / "s1" / "costs.jsonl"
    row = json.loads(ledger.read_text().strip())
    assert row["costUsd"] == 0.0
    assert row["costPending"] is True


def test_read_costs_aggregates_by_role_and_turn(active_project, write_ledger, make_cost_entry):
    entries = [
        make_cost_entry(turnId="t1", role="orchestrator", costUsd=0.01, totalTokens=100),
        make_cost_entry(turnId="t1", role="expert", costUsd=0.02, totalTokens=200),
        make_cost_entry(turnId="t2", role="orchestrator", costUsd=0.03, totalTokens=50),
    ]
    write_ledger("s1", entries)

    summary = cost_ledger.read_costs("s1", project_id=active_project.id)
    assert summary["sessionId"] == "s1"
    assert summary["totalUsd"] == 0.01 + 0.02 + 0.03
    assert summary["orchestratorUsd"] == 0.04
    assert summary["expertUsd"] == 0.02
    assert summary["totalTokens"] == 350
    assert set(summary["byTurn"]) == {"t1", "t2"}
    assert summary["byTurn"]["t1"]["totalTokens"] == 300
    assert summary["byTurn"]["t1"]["orchestratorUsd"] == 0.01
    assert summary["byTurn"]["t1"]["expertUsd"] == 0.02


def test_read_costs_handles_missing_ledger(active_project):
    summary = cost_ledger.read_costs("never-seen", project_id=active_project.id)
    assert summary["totalUsd"] == 0.0
    assert summary["entries"] == []


def test_read_costs_skips_malformed_lines(active_project, write_ledger, make_cost_entry):
    ledger = write_ledger("s1", [make_cost_entry(turnId="t1", costUsd=0.05, totalTokens=10)])
    ledger.write_text(
        ledger.read_text() + "not-json\n{}\n",
        encoding="utf-8",
    )
    summary = cost_ledger.read_costs("s1", project_id=active_project.id)
    assert summary["totalUsd"] == 0.05


# ---------------------------------------------------------------------------
# update_cost_entry
# ---------------------------------------------------------------------------


def test_update_cost_entry_rewrites_only_matching_row(active_project, write_ledger, make_cost_entry):
    entries = [
        make_cost_entry(entryId="a", turnId="t1", costUsd=0.0, costPending=True),
        make_cost_entry(entryId="b", turnId="t1", costUsd=0.0, costPending=True),
    ]
    write_ledger("s1", entries)

    ok = cost_ledger.update_cost_entry(
        session_id="s1", entry_id="b", cost_usd=0.42, project_id=active_project.id
    )
    assert ok is True

    summary = cost_ledger.read_costs("s1", project_id=active_project.id)
    rows = {e["entryId"]: e for e in summary["entries"]}
    assert rows["a"]["costUsd"] == 0.0
    assert rows["a"]["costPending"] is True
    assert rows["b"]["costUsd"] == 0.42
    assert rows["b"]["costPending"] is False


def test_update_cost_entry_returns_false_when_missing(active_project, write_ledger, make_cost_entry):
    write_ledger("s1", [make_cost_entry(entryId="a")])
    assert cost_ledger.update_cost_entry(
        session_id="s1", entry_id="zzz", cost_usd=1.0, project_id=active_project.id
    ) is False


def test_update_cost_entry_no_ledger_returns_false(active_project):
    assert cost_ledger.update_cost_entry(
        session_id="missing", entry_id="x", cost_usd=1.0, project_id=active_project.id
    ) is False
