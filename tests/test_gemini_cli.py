"""Tests for kady_agent.tools.gemini_cli — stream parsing & delegation."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from kady_agent.tools.gemini_cli import _parse_stream_json, delegate_task


# ---------------------------------------------------------------------------
# _parse_stream_json
# ---------------------------------------------------------------------------


class TestParseStreamJson:
    def test_empty_input(self):
        result = _parse_stream_json("")
        assert result["result"] == ""
        assert result["skills_used"] == []
        assert result["tools_used"] == {}

    def test_assistant_messages(self):
        raw = (
            json.dumps({"type": "message", "role": "assistant", "content": "Hello "})
            + "\n"
        )
        raw += json.dumps({"type": "message", "role": "assistant", "content": "World"})
        result = _parse_stream_json(raw)
        assert result["result"] == "Hello World"

    def test_ignores_non_assistant_messages(self):
        raw = json.dumps({"type": "message", "role": "user", "content": "ignored"})
        result = _parse_stream_json(raw)
        assert result["result"] == ""

    def test_tool_use_counted(self):
        raw = json.dumps({"type": "tool_use", "tool_name": "read_file"}) + "\n"
        raw += json.dumps({"type": "tool_use", "tool_name": "read_file"}) + "\n"
        raw += json.dumps({"type": "tool_use", "tool_name": "write_file"})
        result = _parse_stream_json(raw)
        assert result["tools_used"]["read_file"] == 2
        assert result["tools_used"]["write_file"] == 1

    def test_skill_activation_via_skill_name(self):
        raw = json.dumps(
            {
                "type": "tool_use",
                "tool_name": "activate_skill",
                "parameters": {"skill_name": "phylogenetics"},
            }
        )
        result = _parse_stream_json(raw)
        assert "phylogenetics" in result["skills_used"]

    def test_skill_activation_via_name_key(self):
        raw = json.dumps(
            {
                "type": "tool_use",
                "tool_name": "activate_skill",
                "parameters": {"name": "neuropixels"},
            }
        )
        result = _parse_stream_json(raw)
        assert "neuropixels" in result["skills_used"]

    def test_skill_activation_via_first_string_value(self):
        raw = json.dumps(
            {
                "type": "tool_use",
                "tool_name": "activate_skill",
                "parameters": {"unknown_key": "fallback-skill"},
            }
        )
        result = _parse_stream_json(raw)
        assert "fallback-skill" in result["skills_used"]

    def test_deduplication_of_skills(self):
        raw = ""
        for _ in range(3):
            raw += (
                json.dumps(
                    {
                        "type": "tool_use",
                        "tool_name": "activate_skill",
                        "parameters": {"skill_name": "same-skill"},
                    }
                )
                + "\n"
            )
        result = _parse_stream_json(raw)
        assert result["skills_used"] == ["same-skill"]

    def test_invalid_json_lines_skipped(self):
        raw = "not json\n" + json.dumps(
            {"type": "message", "role": "assistant", "content": "ok"}
        )
        result = _parse_stream_json(raw)
        assert result["result"] == "ok"

    def test_empty_parameters_skill(self):
        raw = json.dumps(
            {
                "type": "tool_use",
                "tool_name": "activate_skill",
                "parameters": None,
            }
        )
        result = _parse_stream_json(raw)
        assert result["skills_used"] == []

    def test_mixed_events(self):
        lines = [
            {"type": "message", "role": "assistant", "content": "Part1 "},
            {"type": "tool_use", "tool_name": "bash", "parameters": {}},
            {
                "type": "tool_use",
                "tool_name": "activate_skill",
                "parameters": {"skill_name": "pymc"},
            },
            {"type": "message", "role": "assistant", "content": "Part2"},
        ]
        raw = "\n".join(json.dumps(line) for line in lines)
        result = _parse_stream_json(raw)
        assert result["result"] == "Part1 Part2"
        assert result["tools_used"]["bash"] == 1
        assert result["skills_used"] == ["pymc"]


# ---------------------------------------------------------------------------
# delegate_task (mocked subprocess)
# ---------------------------------------------------------------------------


class TestDelegateTask:
    @pytest.mark.asyncio
    async def test_successful_delegation(self):
        stream_output = json.dumps(
            {
                "type": "message",
                "role": "assistant",
                "content": "Paris",
            }
        )
        mock_proc = AsyncMock()
        mock_proc.communicate.return_value = (stream_output.encode(), b"")
        mock_proc.returncode = 0

        with patch(
            "kady_agent.tools.gemini_cli.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            result = await delegate_task("What is the capital of France?")
        assert result["result"] == "Paris"

    @pytest.mark.asyncio
    async def test_nonzero_returncode_raises(self):
        mock_proc = AsyncMock()
        mock_proc.communicate.return_value = (b"", b"gemini error occurred")
        mock_proc.returncode = 1

        with patch(
            "kady_agent.tools.gemini_cli.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            with pytest.raises(RuntimeError, match="gemini error occurred"):
                await delegate_task("fail this")
