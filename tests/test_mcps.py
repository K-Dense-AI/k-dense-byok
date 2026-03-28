"""Tests for kady_agent.mcps — ResilientMcpToolset wrapper."""

import logging
from unittest.mock import AsyncMock, MagicMock

import pytest

from kady_agent.mcps import ResilientMcpToolset


def _make_mock_inner() -> MagicMock:
    """Create a mock McpToolset with default tool_filter and tool_name_prefix."""
    inner = MagicMock()
    inner.tool_filter = None
    inner.tool_name_prefix = ""
    inner.get_tools = AsyncMock(return_value=[MagicMock()])
    inner.close = AsyncMock()
    return inner


# ---------------------------------------------------------------------------
# ResilientMcpToolset
# ---------------------------------------------------------------------------


class TestResilientMcpToolset:
    def test_init_stores_inner_and_label(self):
        inner = _make_mock_inner()
        rts = ResilientMcpToolset(inner, label="TestMCP")
        assert rts._inner is inner
        assert rts._label == "TestMCP"

    @pytest.mark.asyncio
    async def test_get_tools_success(self):
        inner = _make_mock_inner()
        fake_tool = MagicMock()
        inner.get_tools.return_value = [fake_tool]
        rts = ResilientMcpToolset(inner, label="OK")
        tools = await rts.get_tools()
        assert tools == [fake_tool]

    @pytest.mark.asyncio
    async def test_get_tools_returns_empty_on_failure(self, caplog):
        inner = _make_mock_inner()
        inner.get_tools.side_effect = ConnectionRefusedError("nope")
        rts = ResilientMcpToolset(inner, label="BrokenMCP")
        with caplog.at_level(logging.WARNING):
            tools = await rts.get_tools()
        assert tools == []
        assert "BrokenMCP" in caplog.text

    @pytest.mark.asyncio
    async def test_close_success(self):
        inner = _make_mock_inner()
        rts = ResilientMcpToolset(inner)
        await rts.close()
        inner.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_close_swallows_exception(self):
        inner = _make_mock_inner()
        inner.close.side_effect = RuntimeError("cleanup failed")
        rts = ResilientMcpToolset(inner)
        # Should not raise
        await rts.close()

    @pytest.mark.asyncio
    async def test_get_tools_with_readonly_context(self):
        inner = _make_mock_inner()
        rts = ResilientMcpToolset(inner)
        mock_ctx = MagicMock()
        await rts.get_tools(readonly_context=mock_ctx)
        inner.get_tools.assert_awaited_once_with(mock_ctx)
