"""Unit tests for ``kady_agent/mcps.py``.

We avoid exercising the real ADK ``McpToolset`` (it would try to open
subprocesses/stdio). Instead, we verify:

* ``_make_toolset`` picks the right connection-params class per spec shape.
* ``ResilientMcpToolset`` swallows ``get_tools`` errors and returns [].
* ``DynamicCustomMcpToolset`` rebuilds on config hash change.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from kady_agent import mcps


class _FakeInnerToolset:
    """Stand-in for ``McpToolset`` that records open/close + can raise."""

    tool_filter = None
    tool_name_prefix = None

    def __init__(self, *, fail: bool = False) -> None:
        self._fail = fail
        self.closed = False
        self.tools_calls = 0

    async def get_tools(self, readonly_context=None):
        self.tools_calls += 1
        if self._fail:
            raise RuntimeError("mcp down")
        return ["tool-a", "tool-b"]

    async def close(self):
        self.closed = True


async def test_resilient_toolset_returns_empty_on_error():
    inner = _FakeInnerToolset(fail=True)
    ts = mcps.ResilientMcpToolset(inner, label="x")
    out = await ts.get_tools()
    assert out == []
    await ts.close()
    assert inner.closed


async def test_resilient_toolset_forwards_tools():
    inner = _FakeInnerToolset(fail=False)
    ts = mcps.ResilientMcpToolset(inner, label="x")
    out = await ts.get_tools()
    assert out == ["tool-a", "tool-b"]


def test_make_toolset_rejects_malformed_spec(caplog):
    caplog.set_level("WARNING")
    assert mcps._make_toolset("bad", {}) is None
    assert any("no 'command' or 'httpUrl'" in rec.message for rec in caplog.records)


def test_make_toolset_http(monkeypatch):
    captured = {}

    class FakeMcpToolset:
        def __init__(self, connection_params):
            captured["params"] = connection_params
            self.tool_filter = None
            self.tool_name_prefix = None

    monkeypatch.setattr(mcps, "McpToolset", FakeMcpToolset)
    ts = mcps._make_toolset("http-mcp", {"httpUrl": "https://x", "headers": {"A": "1"}})
    assert isinstance(ts, mcps.ResilientMcpToolset)
    assert captured["params"].url == "https://x"
    assert captured["params"].headers == {"A": "1"}


def test_make_toolset_stdio(monkeypatch):
    captured = {}

    class FakeMcpToolset:
        def __init__(self, connection_params):
            captured["params"] = connection_params
            self.tool_filter = None
            self.tool_name_prefix = None

    monkeypatch.setattr(mcps, "McpToolset", FakeMcpToolset)
    ts = mcps._make_toolset("stdio", {"command": "uvx", "args": ["foo"]})
    assert isinstance(ts, mcps.ResilientMcpToolset)
    sp = captured["params"].server_params
    assert sp.command == "uvx"
    assert sp.args == ["foo"]


# ---------------------------------------------------------------------------
# DynamicCustomMcpToolset
# ---------------------------------------------------------------------------


async def test_dynamic_custom_rebuilds_on_config_change(active_project, monkeypatch):
    from kady_agent import gemini_settings as gs

    class RecordingToolset:
        """Replaces the real MCP toolset so we don't open subprocesses."""

        def __init__(self, *a, **kw):
            self.closed = False
            self.tool_filter = None
            self.tool_name_prefix = None

        async def get_tools(self, ctx=None):
            return [("tool", id(self))]

        async def close(self):
            self.closed = True

    monkeypatch.setattr(mcps, "McpToolset", RecordingToolset)

    gs.save_custom_mcps({"a": {"command": "x"}})
    ts = mcps.DynamicCustomMcpToolset()
    tools_v1 = await ts.get_tools()
    assert len(tools_v1) == 1

    # Same config -> cached instance.
    previous = list(ts._toolsets.values())[0]._inner
    await ts.get_tools()
    assert list(ts._toolsets.values())[0]._inner is previous

    # Config change -> rebuild.
    gs.save_custom_mcps({"b": {"command": "y"}})
    await ts.get_tools()
    assert previous.closed is True
    assert "b" in ts._toolsets and "a" not in ts._toolsets


async def test_dynamic_builtin_browser_use_obeys_enabled(active_project, monkeypatch):
    from kady_agent import gemini_settings as gs

    class RecordingToolset:
        def __init__(self, *a, **kw):
            self.closed = False
            self.tool_filter = None
            self.tool_name_prefix = None

        async def get_tools(self, ctx=None):
            return ["tool"]

        async def close(self):
            self.closed = True

    monkeypatch.setattr(mcps, "McpToolset", RecordingToolset)

    # Disabled: no tools.
    gs.save_browser_use_config({"enabled": False})
    ts = mcps.DynamicBuiltinBrowserUseToolset()
    assert await ts.get_tools() == []
    assert ts._toolset is None

    # Now enable: one tool.
    gs.save_browser_use_config({"enabled": True})
    assert await ts.get_tools() == ["tool"]
    assert ts._toolset is not None

    # Disable again: close and drop.
    gs.save_browser_use_config({"enabled": False})
    assert await ts.get_tools() == []
    assert ts._toolset is None
